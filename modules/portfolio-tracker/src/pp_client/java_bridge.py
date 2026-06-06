import asyncio
import json
from pathlib import Path


class PpJavaBridge:
    def __init__(self, jar_path: str, xml_path: str, password: str = "", timeout: int = 30):
        self._jar_path = Path(jar_path)
        self._xml_path = xml_path
        self._password = password
        self._timeout = timeout

    def _validate_jar(self):
        if not self._jar_path.exists():
            raise FileNotFoundError(f"Java CLI JAR not found: {self._jar_path}")

    async def _run_command(self, *args: str) -> dict:
        self._validate_jar()
        cmd = ["java", "-jar", str(self._jar_path)]
        # Ensure command is first arg, password flags follow immediately
        cmd.append(args[0])  # command name
        if self._password:
            cmd.append("--password")
            cmd.append(self._password)
        cmd += list(args[1:])  # rest of args
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=self._timeout)

            if proc.returncode != 0:
                error_msg = stderr.decode("utf-8", errors="replace").strip()
                try:
                    error_data = json.loads(error_msg)
                    raise RuntimeError(error_data.get("error", error_msg))
                except json.JSONDecodeError:
                    raise RuntimeError(f"Java CLI error (exit {proc.returncode}): {error_msg}")

            return json.loads(stdout.decode("utf-8", errors="replace"))
        except asyncio.TimeoutError:
            raise TimeoutError(f"Java CLI timed out after {self._timeout}s")
        except FileNotFoundError:
            raise RuntimeError("Java not found. Install Java 17+ to use the PP CLI.")

    async def get_accounts(self) -> list[dict]:
        result = await self._run_command("accounts", "--file", self._xml_path)
        return result.get("accounts", [])

    async def get_securities(self) -> list[dict]:
        result = await self._run_command("securities", "--file", self._xml_path)
        return result.get("securities", [])

    async def get_portfolio(self) -> dict:
        return await self._run_command("portfolio", "--file", self._xml_path)

    async def insert_transaction(
        self,
        account_id: str,
        txn_type: str,
        date: str,
        shares: float,
        price: float,
        currency_code: str,
        security_id: str = "",
        fees: float = 0.0,
        taxes: float = 0.0,
        notes: str = "",
    ) -> dict:
        args = [
            "insert",
            "--file", self._xml_path,
            "--account-id", account_id,
            "--type", txn_type,
            "--date", date,
            "--shares", str(int(shares)),
            "--price", str(price),
            "--currency", currency_code,
            "--fees", str(fees),
            "--taxes", str(taxes),
        ]
        if security_id:
            args.extend(["--security-id", security_id])
        if notes:
            args.extend(["--notes", notes])

        return await self._run_command(*args)

    async def update_balance(
        self,
        account_id: str,
        amount: float,
        currency_code: str,
        date: str,
        notes: str = "",
    ) -> dict:
        args = [
            "balance",
            "--file", self._xml_path,
            "--account-id", account_id,
            "--amount", str(amount),
            "--currency", currency_code,
            "--date", date,
        ]
        if notes:
            args.extend(["--notes", notes])
        return await self._run_command(*args)

    async def query_taxonomies(self, names: list[str]) -> dict:
        args = [
            "taxonomy",
            "--file", self._xml_path,
            "--names", ",".join(names),
        ]
        return await self._run_command(*args)

    async def get_transactions(self) -> list[dict]:
        result = await self._run_command("transactions", "--file", self._xml_path)
        return result if isinstance(result, list) else result.get("transactions", [])

    async def get_status(self) -> dict:
        return await self._run_command("status", "--file", self._xml_path)

    async def query_security(self, search: str) -> dict:
        return await self._run_command("query", "--file", self._xml_path, "--search", search)
