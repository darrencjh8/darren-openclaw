"""Test IBKR parser with namespace-less XML (actual IBKR flex query format)"""
from src.extractors.ibkr_parser import parse_ibkr_flex_query

# Real flex query without xmlns
NAMESPACELESS_FLEX = """<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="PP" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U***8844" fromDate="20260518" toDate="20260522">
<Trades>
<Trade accountId="U***8844" acctAlias="TestUser" model="" currency="USD"
       fxRateToBase="1.33235" assetCategory="STK" subCategory="COMMON"
       symbol="ISRG" description="INTUITIVE SURGICAL INC" conid="12345"
       isin="US46120E6023" listingExchange="NASDAQ"
       tradeDate="20260518" quantity="-5" tradePrice="438" buySell="SELL"
       ibCommission="-0.38136125" taxes="-0.03432251"/>
</Trades>
<CashTransactions>
<CashTransaction accountId="U***8844" acctAlias="TestUser" model=""
       currency="SGD" fxRateToBase="1" type="Dividends"
       symbol="D05" description="D05 CASH DIVIDEND"
       dateTime="20260520;202000" amount="30"/>
<CashTransaction accountId="U***8844" acctAlias="TestUser" model=""
       currency="SGD" fxRateToBase="1" type="Dividends"
       symbol="D05" description="D05 CASH DIVIDEND ORDINARY"
       dateTime="20260520;202000" amount="132"/>
</CashTransactions>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>"""


def test_namespaceless_flex_parses():
    txns = parse_ibkr_flex_query(NAMESPACELESS_FLEX)
    assert len(txns) >= 3


def test_namespaceless_sell_trade():
    txns = parse_ibkr_flex_query(NAMESPACELESS_FLEX)
    sells = [t for t in txns if t["type"] == "Sell"]
    assert len(sells) == 1
    assert sells[0]["symbol"] == "ISRG"
    assert sells[0]["isin"] == "US46120E6023"
    assert sells[0]["currency"] == "USD"
    assert sells[0]["fees"] != 0  # fees are negative in IBKR data


def test_namespaceless_dividend():
    txns = parse_ibkr_flex_query(NAMESPACELESS_FLEX)
    divs = [t for t in txns if t["type"] == "Dividend"]
    assert len(divs) == 2
    currencies = {d["currency"] for d in divs}
    assert "SGD" in currencies


def test_namespaceless_dividend_amounts():
    txns = parse_ibkr_flex_query(NAMESPACELESS_FLEX)
    divs = [t for t in txns if t["type"] == "Dividend"]
    amounts = [d["amount"] for d in divs if d["amount"]]
    assert 30.0 in amounts or -30.0 in amounts


def test_namespaceless_empty_sections():
    xml = """<?xml version="1.0"?>
<FlexQueryResponse queryName="PP" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U123" fromDate="20260101" toDate="20260101">
<Trades/>
<CashTransactions/>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>"""
    txns = parse_ibkr_flex_query(xml)
    assert txns == []


def test_mixed_namespace_types():
    txns = parse_ibkr_flex_query(NAMESPACELESS_FLEX)
    types = {t["source"] for t in txns}
    assert "IBKR_Trade" in types
    assert "IBKR_Cash" in types
