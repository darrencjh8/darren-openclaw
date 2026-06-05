from lxml import etree


IBKR_NS = {"ns": "http://www.interactivebrokers.com/flex/statement"}

TRADE_TYPE_MAP = {
    "BUY": "Buy",
    "SELL": "Sell",
    "BUY (CA)": "Buy",
    "SELL (CA)": "Sell",
}

CORP_ACTION_MAP = {
    "DIVIDEND": "Dividend",
    "DIVIDEND_REINVEST": "Dividend",
    "STOCK_SPLIT": "Buy",
}


def parse_ibkr_flex_query(xml_content: str) -> list[dict]:
    try:
        root = etree.fromstring(xml_content.encode("utf-8"))
    except etree.XMLSyntaxError as e:
        raise ValueError(f"Invalid IBKR flex query XML: {e}")

    transactions: list[dict] = []

    trades_elem = root.find(".//ns:Trades", IBKR_NS)
    if trades_elem is not None:
        for trade in trades_elem.findall("ns:Trade", IBKR_NS):
            txn = _parse_trade(trade)
            if txn:
                transactions.append(txn)

    cash_elem = root.find(".//ns:CashTransactions", IBKR_NS)
    if cash_elem is not None:
        for ct in cash_elem.findall("ns:CashTransaction", IBKR_NS):
            txn = _parse_cash_transaction(ct)
            if txn:
                transactions.append(txn)

    corp_elem = root.find(".//ns:CorporateActions", IBKR_NS)
    if corp_elem is not None:
        for ca in corp_elem.findall("ns:CorporateAction", IBKR_NS):
            txn = _parse_corporate_action(ca)
            if txn:
                transactions.append(txn)

    return transactions


def _get_text(elem, tag: str) -> str:
    val = elem.get(tag)
    if val is not None:
        return val.strip()
    child = elem.find(f"ns:{tag}", IBKR_NS)
    if child is not None:
        return (child.text or "").strip()
    return ""


def _get_float(elem, tag: str) -> float:
    val = _get_text(elem, tag)
    if not val:
        return 0.0
    try:
        return float(val.replace(",", ""))
    except (ValueError, TypeError):
        return 0.0


def _get_date(elem, tag: str) -> str:
    val = _get_text(elem, tag)
    if val and len(val) >= 10:
        return val[:10]
    return val


def _parse_trade(trade) -> dict | None:
    symbol = _get_text(trade, "symbol")
    isin = _get_text(trade, "isin")
    if not symbol or symbol == "":
        return None

    trade_type_raw = _get_text(trade, "buySell")
    trade_type = TRADE_TYPE_MAP.get(trade_type_raw, trade_type_raw)

    date = _get_date(trade, "tradeDate") or _get_date(trade, "dateTime")
    quantity = abs(_get_float(trade, "quantity"))
    price = _get_float(trade, "tradePrice") or _get_float(trade, "price")
    currency = _get_text(trade, "currency") or _get_text(trade, "currencyCode")
    fees = _get_float(trade, "ibCommission") + _get_float(trade, "taxes")
    taxes = 0.0
    description = _get_text(trade, "description") or f"{symbol} {trade_type_raw}"

    amount = _get_float(trade, "proceeds")
    if amount < 0 and trade_type == "Buy":
        amount = abs(amount)

    return {
        "type": trade_type,
        "symbol": symbol,
        "isin": isin,
        "description": description,
        "date": date,
        "quantity": quantity,
        "price": price,
        "currency": currency,
        "fees": fees,
        "taxes": taxes,
        "amount": amount,
        "source": "IBKR_Trade",
    }


def _parse_cash_transaction(ct) -> dict | None:
    ctype = _get_text(ct, "type")
    if not ctype:
        return None

    type_map = {
        "Dividends": "Dividend",
        "Dividend": "Dividend",
        "Withholding Tax": "Tax",
        "Withholding": "Tax",
        "Deposits/Withdrawals": "Deposit",
        "Deposit": "Deposit",
        "Withdrawal": "Withdrawal",
        "Interest": "Interest",
        "Broker Interest": "Interest",
        "Other Fees": "Fee",
        "Fees": "Fee",
    }

    txn_type = type_map.get(ctype, ctype)
    date = _get_date(ct, "dateTime") or _get_date(ct, "reportDate")
    currency = _get_text(ct, "currency")
    amount = _get_float(ct, "amount")
    description = _get_text(ct, "description") or ctype
    symbol = _get_text(ct, "symbol")

    if amount < 0 and txn_type in ("Deposit", "Dividend", "Interest"):
        amount = abs(amount)
    elif amount > 0 and txn_type in ("Withdrawal", "Fee", "Tax"):
        amount = -abs(amount)

    return {
        "type": txn_type,
        "symbol": symbol,
        "isin": "",
        "description": description,
        "date": date,
        "quantity": 0,
        "price": abs(amount) if amount else 0,
        "currency": currency,
        "fees": 0.0,
        "taxes": 0.0,
        "amount": amount,
        "source": "IBKR_Cash",
    }


def _parse_corporate_action(ca) -> dict | None:
    ca_type = _get_text(ca, "type")
    if not ca_type:
        return None

    mapped_type = CORP_ACTION_MAP.get(ca_type, "Dividend")
    symbol = _get_text(ca, "symbol")
    date = _get_date(ca, "dateTime") or _get_date(ca, "reportDate")
    currency = _get_text(ca, "currency")
    description = _get_text(ca, "description") or f"{ca_type}: {symbol}"
    quantity = _get_float(ca, "quantity")

    return {
        "type": mapped_type,
        "symbol": symbol,
        "isin": "",
        "description": description,
        "date": date,
        "quantity": quantity,
        "price": 0.0,
        "currency": currency,
        "fees": 0.0,
        "taxes": 0.0,
        "amount": 0.0,
        "source": "IBKR_CA",
    }
