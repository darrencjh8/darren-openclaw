from src.extractors.ibkr_parser import parse_ibkr_flex_query


SAMPLE_FLEX_QUERY = """<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
  <FlexStatements>
    <FlexStatement>
      <Trades>
        <Trade assetCategory="STK" symbol="AAPL" isin="US0378331005"
               tradeDate="20260601" quantity="100" tradePrice="185.30"
               currency="USD" buySell="BUY" proceeds="-18530.00"
               ibCommission="1.00" taxes="0.00"
               description="APPLE INC"/>
        <Trade assetCategory="STK" symbol="MSFT" isin="US5949181045"
               tradeDate="20260602" quantity="50" tradePrice="420.50"
               currency="USD" buySell="SELL" proceeds="21025.00"
               ibCommission="0.50" taxes="0.00"
               description="MICROSOFT CORP"/>
      </Trades>
      <CashTransactions>
        <CashTransaction type="Dividends" symbol="AAPL"
                         dateTime="20260603" currency="USD" amount="25.00"
                         description="AAPL(US0378331005) CASH DIVIDEND"/>
        <CashTransaction type="Withholding Tax" symbol="AAPL"
                         dateTime="20260603" currency="USD" amount="-3.75"
                         description="AAPL(US0378331005) WITHHOLDING"/>
      </CashTransactions>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>"""


def test_parse_flex_query_returns_transactions():
    transactions = parse_ibkr_flex_query(SAMPLE_FLEX_QUERY)
    assert len(transactions) >= 3


def test_parse_buy_trade():
    transactions = parse_ibkr_flex_query(SAMPLE_FLEX_QUERY)
    buys = [t for t in transactions if t["type"] == "Buy"]
    assert len(buys) >= 1
    buy = buys[0]
    assert buy["symbol"] == "AAPL"
    assert buy["isin"] == "US0378331005"
    assert buy["currency"] == "USD"


def test_parse_sell_trade():
    transactions = parse_ibkr_flex_query(SAMPLE_FLEX_QUERY)
    sells = [t for t in transactions if t["type"] == "Sell"]
    assert len(sells) >= 1
    sell = sells[0]
    assert sell["symbol"] == "MSFT"


def test_parse_dividend():
    transactions = parse_ibkr_flex_query(SAMPLE_FLEX_QUERY)
    divs = [t for t in transactions if t["type"] == "Dividend"]
    assert len(divs) >= 1
    div = divs[0]
    assert div["symbol"] == "AAPL"


def test_parse_withholding_tax():
    transactions = parse_ibkr_flex_query(SAMPLE_FLEX_QUERY)
    taxes = [t for t in transactions if t["type"] == "Tax"]
    assert len(taxes) >= 1
    tax = taxes[0]
    assert tax["symbol"] == "AAPL"


def test_invalid_xml_raises_error():
    try:
        parse_ibkr_flex_query("not valid xml")
        assert False, "Should have raised"
    except ValueError:
        pass


def test_empty_flex_query():
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements>
        <FlexStatement>
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>"""
    transactions = parse_ibkr_flex_query(xml)
    assert transactions == []


def test_flex_query_with_no_trades_section():
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements>
        <FlexStatement>
          <OpenPositions>
          </OpenPositions>
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>"""
    transactions = parse_ibkr_flex_query(xml)
    assert transactions == []


def test_trade_missing_symbol_is_skipped():
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements><FlexStatement>
        <Trades>
          <Trade tradeDate="20260601" quantity="10" tradePrice="100" currency="USD" buySell="BUY"/>
        </Trades>
      </FlexStatement></FlexStatements>
    </FlexQueryResponse>"""
    transactions = parse_ibkr_flex_query(xml)
    assert len(transactions) == 0


def test_corporate_action_parsed():
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements><FlexStatement>
        <CorporateActions>
          <CorporateAction type="DIVIDEND" symbol="AAPL" dateTime="20260603"
                           currency="USD" description="CASH DIVIDEND"/>
        </CorporateActions>
      </FlexStatement></FlexStatements>
    </FlexQueryResponse>"""
    transactions = parse_ibkr_flex_query(xml)
    assert len(transactions) >= 1
    assert transactions[0]["type"] == "Dividend"


def test_multi_currency_in_same_query():
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements><FlexStatement>
        <Trades>
          <Trade symbol="AAPL" tradeDate="20260601" quantity="10" tradePrice="185.30"
                 currency="USD" buySell="BUY"/>
          <Trade symbol="D05" tradeDate="20260602" quantity="100" tradePrice="40.50"
                 currency="SGD" buySell="BUY"/>
        </Trades>
      </FlexStatement></FlexStatements>
    </FlexQueryResponse>"""
    transactions = parse_ibkr_flex_query(xml)
    currencies = {t["currency"] for t in transactions}
    assert "USD" in currencies
    assert "SGD" in currencies
    assert len(transactions) == 2


def test_fees_and_taxes_extracted():
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements><FlexStatement>
        <Trades>
          <Trade symbol="AAPL" tradeDate="20260601" quantity="10" tradePrice="185.30"
                 currency="USD" buySell="BUY" ibCommission="5.00" taxes="0.30"/>
        </Trades>
      </FlexStatement></FlexStatements>
    </FlexQueryResponse>"""
    transactions = parse_ibkr_flex_query(xml)
    assert len(transactions) == 1
    assert transactions[0]["fees"] > 0
