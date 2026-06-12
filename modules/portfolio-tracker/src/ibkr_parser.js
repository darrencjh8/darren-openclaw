/**
 * IBKR Flex Query XML parser.
 * Ported 1:1 from src/extractors/ibkr_parser.py
 */

import { load } from 'cheerio';

/**
 * Parse an IBKR Flex Query XML response and extract trade data.
 * @param {string} xml - Raw XML string from IBKR flex query
 * @returns {object[]} Array of trade objects
 */
export function parseIBKRFlex(xml) {
  const $ = load(xml, { xmlMode: true });
  const trades = [];

  $('Trade').each((_, el) => {
    const get = (tag) => $(el).find(tag).text().trim();
    trades.push({
      symbol: get('Symbol'),
      isin: get('ISIN'),
      description: get('Description'),
      tradeDate: get('TradeDate'),
      quantity: parseFloat(get('Quantity')) || 0,
      price: parseFloat(get('TradePrice')) || 0,
      amount: parseFloat(get('TradeMoney')) || 0,
      currency: get('Currency') || 'USD',
      buySell: get('BuySell') || 'BUY',
      assetCategory: get('AssetCategory') || '',
    });
  });

  return trades;
}

/**
 * Parse IBKR Activity Flex statement for dividends, fees, deposits.
 * @param {string} xml
 * @returns {object[]} Array of activity objects
 */
export function parseIBKRActivity(xml) {
  const $ = load(xml, { xmlMode: true });
  const activities = [];

  // Parse various statement types
  $('StatementOfFundsLine, ChangeInDividendAccrual, CorporateAction, Trade').each((_, el) => {
    const get = (tag) => $(el).find(tag).text().trim();
    const type = el.tagName || el.name || '';
    activities.push({
      type,
      date: get('date') || get('reportDate') || '',
      description: get('description') || get('symbol') || '',
      amount: parseFloat(get('amount') || get('value') || '0'),
      currency: get('currency') || 'USD',
      activityCode: get('activityCode') || get('code') || '',
    });
  });

  return activities;
}
