/**
 * Email handler for the portfolio tracker.
 * Ported 1:1 from src/channels/email_handler.py
 */

import { load } from 'cheerio';

export function extractEmailBody(rawEmail) {
  try {
    const $ = load(rawEmail);
    $('script, style').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  } catch {
    return String(rawEmail).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
}

export function classifyEmail(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();
  if (text.includes('flex query') || text.includes('flex report')) return 'ibkr_flex';
  if (text.includes('trade confirmation')) return 'trade_confirmation';
  if (text.includes('statement') || text.includes('activity')) return 'statement';
  if (text.includes('dividend') || text.includes('distribution')) return 'dividend';
  return 'unknown';
}
