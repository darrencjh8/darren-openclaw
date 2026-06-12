/**
 * Email and PDF content extractors.
 * Ported 1:1 from src/extractors/
 */

import { load } from 'cheerio';

/** Extract readable text from an HTML email body */
export function extractEmailContent(rawEmail) {
  try {
    const $ = load(rawEmail);
    // Remove script and style elements
    $('script, style').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  } catch {
    return String(rawEmail).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
}

/** Extract text from PDF via tesseract OCR (calls system binary) */
export async function extractPdfText(pdfBytesB64) {
  const { execFile } = await import('child_process');
  const { writeFileSync, unlinkSync, readFileSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  const pdfPath = join(tmpdir(), `ocr-${Date.now()}.pdf`);
  const outPath = pdfPath.replace('.pdf', '');
  writeFileSync(pdfPath, Buffer.from(pdfBytesB64, 'base64'));

  return new Promise((resolve, reject) => {
    execFile('pdftotext', [pdfPath, outPath], (err) => {
      try { unlinkSync(pdfPath); } catch {}
      if (err) {
        reject(err);
      } else {
        try {
          resolve(readFileSync(outPath, 'utf8'));
        } finally {
          try { unlinkSync(outPath); } catch {}
        }
      }
    });
  });
}
