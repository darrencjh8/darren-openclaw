import asyncio
import email
import logging

import aioimaplib

from src.agent.orchestrator import AgentOrchestrator

logger = logging.getLogger(__name__)


class EmailHandler:
    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        orchestrator: AgentOrchestrator,
        folder: str = "Trades",
        tool_registry=None,
    ):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._orchestrator = orchestrator
        self._folder = folder
        self._tools = tool_registry
        self._imap: aioimaplib.IMAP4_SSL | None = None

    async def connect(self):
        self._imap = aioimaplib.IMAP4_SSL(host=self._host, port=self._port)
        await self._imap.wait_hello_from_server()
        await self._imap.login(self._username, self._password)
        try:
            await self._imap.select(self._folder)
        except Exception:
            logger.warning("IMAP folder '%s' not found, falling back to INBOX", self._folder)
            await self._imap.select("INBOX")
        logger.info("IMAP connected to %s:%d", self._host, self._port)

    async def disconnect(self):
        if self._imap is not None:
            try:
                await self._imap.logout()
            except Exception:
                pass
            self._imap = None

    async def fetch_unread(self) -> list[dict]:
        if self._imap is None:
            await self.connect()
        result, data = await self._imap.search("UNSEEN")
        if result != "OK" or not data or not data[0]:
            return []

        msg_ids = [mid.decode() if isinstance(mid, bytes) else mid for mid in data[0].split()]
        logger.info("IMAP fetch_unread: %d unread emails in %s", len(msg_ids), self._folder)
        emails = []
        for msg_id in msg_ids:
            result, msg_data = await self._imap.fetch(msg_id, "(BODY.PEEK[])")
            if result == "OK" and msg_data:
                raw = self._extract_bytes(msg_data)
                emails.append(
                    {
                        "msg_id": msg_id,
                        "raw_email": raw,
                    }
                )
        return emails

    async def mark_read(self, msg_id: str):
        if self._imap is None:
            return
        await self._imap.store(msg_id, "+FLAGS", "(\\Seen)")

    async def idle_loop(self, callback=None):
        await self.connect()

        unread = await self.fetch_unread()
        for email_obj in unread:
            await self._process_email(email_obj["msg_id"], email_obj["raw_email"])

        while True:
            try:
                await self._imap.idle_start(timeout=300)
                response = await self._imap.wait_server_push(timeout=300)
                # aioimaplib may return a single value or a tuple
                if isinstance(response, tuple):
                    result, data = response
                else:
                    result, data = "OK", response
                if result == "OK" and data:
                    unread = await self.fetch_unread()
                    for email_obj in unread:
                        await self._process_email(email_obj["msg_id"], email_obj["raw_email"])
                await self._imap.idle_done()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("IMAP %s: %s — reconnecting...", type(e).__name__, e)
                await asyncio.sleep(5)
                await self.connect()
                # Scan for unread emails that arrived during reconnect
                unread = await self.fetch_unread()
                for email_obj in unread:
                    await self._process_email(email_obj["msg_id"], email_obj["raw_email"])

    async def _process_email(self, msg_id: str, raw_email: bytes):
        try:
            if self._tools is not None:
                await self._process_ibkr_direct(msg_id, raw_email)
            else:
                await self._orchestrator.process_event(
                    "email_trade",
                    raw_email,
                    correlation_id=f"email-{msg_id}",
                )
        finally:
            await self.mark_read(msg_id)

    async def _process_ibkr_direct(self, msg_id: str, raw_email: bytes):
        """Process IBKR flex query email directly without LLM overhead."""
        import json

        # 1. Extract email content
        try:
            msg = email.message_from_bytes(raw_email)
            body = self._extract_email_body(msg)
            if not body:
                logger.warning("Email %s: no body content", msg_id)
                return
        except Exception as e:
            logger.error("Email %s: failed to parse MIME: %s", msg_id, e)
            return

        # 2. Find XML content (IBKR flex query)
        xml_content = self._find_xml(body)
        if not xml_content:
            logger.info("Email %s: no IBKR flex query XML found, skipping", msg_id)
            return

        logger.info("Email %s: found IBKR flex query (%d bytes)", msg_id, len(xml_content))

        # 3. Parse XML
        try:
            from src.extractors.ibkr_parser import parse_ibkr_flex_query

            transactions = parse_ibkr_flex_query(xml_content)
            logger.info("Email %s: parsed %d transactions", msg_id, len(transactions))
            if not transactions:
                return
        except Exception as e:
            logger.error("Email %s: failed to parse XML: %s", msg_id, e)
            return

        # 4. Fetch PP securities and accounts
        try:
            securities_raw = await self._tools.execute_tool("fetch_pp_securities", {})
            accounts_raw = await self._tools.execute_tool("fetch_pp_accounts", {})
            securities = json.loads(securities_raw)
            accounts = json.loads(accounts_raw)
        except Exception as e:
            logger.error("Email %s: failed to fetch PP data: %s", msg_id, e)
            return

        # 5. Match and insert each transaction
        inserted = 0
        skipped_dup = 0
        errors = 0
        for txn in transactions:
            try:
                # Normalize IBKR date format (YYYYMMDD → YYYY-MM-DD)
                date = self._normalize_date(txn.get("date", ""))

                security_id = self._match_security(txn, securities)
                account_id = self._match_account(txn, accounts)
                if not security_id or not account_id:
                    logger.warning(
                        "Email %s: cannot match security=%s account=%s currency=%s — skipping",
                        msg_id,
                        txn.get("symbol"),
                        txn.get("source"),
                        txn.get("currency"),
                    )
                    errors += 1
                    continue

                # Check duplicate
                amount_cents = int(abs(txn.get("amount", 0)) * 100)
                dup_raw = await self._tools.execute_tool(
                    "check_duplicate",
                    {
                        "date": date,
                        "amount_cents": amount_cents,
                        "account_id": account_id,
                        "security_id": security_id,
                        "type": txn["type"],
                    },
                )
                dup_result = json.loads(dup_raw)
                if dup_result.get("is_duplicate"):
                    skipped_dup += 1
                    logger.info(
                        "Email %s: duplicate %s %s — skipped",
                        msg_id,
                        txn["type"],
                        txn.get("symbol"),
                    )
                    continue

                # Insert
                await self._tools.execute_tool(
                    "insert_pp_transaction",
                    {
                        "account_id": account_id,
                        "security_id": security_id,
                        "type": txn["type"],
                        "date": date,
                        "shares": txn.get("shares", 0),
                        "price": txn.get("price", 0),
                        "currency_code": txn["currency"],
                        "fees": txn.get("fees", 0),
                        "taxes": txn.get("taxes", 0),
                        "notes": f"IBKR {txn['type']} {txn.get('symbol', '')} — auto-imported from email",
                    },
                )
                inserted += 1
                logger.info("Email %s: inserted %s %s", msg_id, txn["type"], txn.get("symbol"))

            except Exception as e:
                logger.error("Email %s: failed to insert %s: %s", msg_id, txn.get("symbol"), e)
                errors += 1

        if inserted == 0 and skipped_dup == 0 and errors > 0:
            return  # Nothing succeeded

        # 6. pp-push
        try:
            await self._tools.execute_tool("pp-push", {})
            logger.info("Email %s: pp-push done", msg_id)
        except Exception as e:
            logger.error("Email %s: pp-push failed: %s", msg_id, e)

        # 7. pp-sync-all
        try:
            await self._tools.execute_tool("pp-sync-all", {})
            logger.info("Email %s: pp-sync-all done", msg_id)
        except Exception as e:
            logger.error("Email %s: pp-sync-all failed: %s", msg_id, e)

        # 8. notify_user
        summary = f"📧 Auto-imported IBKR flex query from email\n"
        if inserted:
            summary += f"   ✅ {inserted} transactions inserted\n"
        if skipped_dup:
            summary += f"   ⏭️ {skipped_dup} duplicates skipped\n"
        if errors:
            summary += f"   ⚠️ {errors} errors"
        try:
            await self._tools.execute_tool("notify_user", {"message": summary})
        except Exception:
            pass

        logger.info(
            "Email %s: done — %d inserted, %d skipped, %d errors",
            msg_id,
            inserted,
            skipped_dup,
            errors,
        )

    def _normalize_date(self, date_str: str) -> str:
        """Convert IBKR date formats to YYYY-MM-DD."""
        import re

        # Already YYYY-MM-DD
        if re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            return date_str
        # YYYYMMDD → YYYY-MM-DD
        if re.match(r"^\d{8}$", date_str):
            return f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
        return date_str

    def _extract_email_body(self, msg) -> str:
        """Extract text body and XML attachments from email."""
        parts = []
        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                if content_type == "text/plain":
                    payload = part.get_payload(decode=True)
                    if payload:
                        parts.append(("text", payload.decode("utf-8", errors="replace")))
                elif content_type == "text/html":
                    payload = part.get_payload(decode=True)
                    if payload:
                        import re

                        text = payload.decode("utf-8", errors="replace")
                        text = re.sub(r"<[^>]+>", " ", text)
                        text = re.sub(r"\s+", " ", text)
                        parts.append(("text", text.strip()))
                elif content_type in ("text/xml", "application/xml"):
                    payload = part.get_payload(decode=True)
                    if payload:
                        parts.append(("xml", payload.decode("utf-8", errors="replace")))
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                parts.append(("text", payload.decode("utf-8", errors="replace")))

        # Return XML content if found, otherwise text content
        for ptype, pbody in parts:
            if ptype == "xml" and "FlexQueryResponse" in pbody:
                return pbody
        # Return first text part
        for ptype, pbody in parts:
            if ptype == "text":
                return pbody
        return ""

    def _find_xml(self, body: str) -> str | None:
        """Extract IBKR flex query XML from email body."""
        import re

        # If body already IS the XML (e.g., from attachment)
        if "<FlexQueryResponse" in body:
            return body

        # Look for full XML with declaration
        match = re.search(
            r"<\?xml[^?]*\?>.*?<FlexQueryResponse.*?</FlexQueryResponse>",
            body,
            re.DOTALL | re.IGNORECASE,
        )
        if match:
            return match.group(0)

        # Try just FlexQueryResponse (some IBKR emails omit XML decl)
        match = re.search(
            r"<FlexQueryResponse.*?</FlexQueryResponse>",
            body,
            re.DOTALL | re.IGNORECASE,
        )
        if match:
            return match.group(0)

        return None

    def _match_security(self, txn: dict, securities: list[dict]) -> str | None:
        """Match IBKR transaction to PP security by ISIN → ticker → name."""
        isin = txn.get("isin", "")
        symbol = txn.get("symbol", "").upper()

        # Try ISIN match first
        if isin:
            for sec in securities:
                if sec.get("isin", "").upper() == isin.upper():
                    return sec.get("id")

        # Try ticker match (exact or prefix, e.g., D05 matches D05.SI)
        if symbol:
            for sec in securities:
                sec_ticker = sec.get("ticker", "").upper()
                if sec_ticker == symbol:
                    return sec.get("id")
            # Prefix match: D05 → D05.SI
            for sec in securities:
                sec_ticker = sec.get("ticker", "").upper()
                if sec_ticker.startswith(symbol + "."):
                    return sec.get("id")

        # Try name match
        name = txn.get("description", "").lower()
        if name:
            for sec in securities:
                sec_name = sec.get("name", "").lower()
                if name in sec_name or sec_name in name:
                    return sec.get("id")

        return None

    def _match_account(self, txn: dict, accounts: list[dict]) -> str | None:
        """Match IBKR transaction to PP account by currency."""
        currency = txn.get("currency", "").upper()
        if not currency:
            return None
        for acct in accounts:
            if acct.get("currency", "").upper() == currency:
                # Prefer IBKR/broker accounts
                name = acct.get("name", "").lower()
                if "ib" in name or "interactive" in name or "broker" in name:
                    return acct.get("id")

        # Fallback: any account with matching currency
        for acct in accounts:
            if acct.get("currency", "").upper() == currency:
                return acct.get("id")

        return None

    def _extract_bytes(self, data) -> bytes:
        if isinstance(data, list):
            # aioimaplib returns [header_bytes, body_bytearray, closing_bytes, status_bytes]
            for item in data:
                if isinstance(item, (bytearray, bytes)) and len(item) > 100:
                    return bytes(item)
                if isinstance(item, tuple) and len(item) > 0:
                    if isinstance(item[0], bytes):
                        return item[0]
                    if len(item) > 1 and isinstance(item[1], bytes):
                        return item[1]
        return b""
