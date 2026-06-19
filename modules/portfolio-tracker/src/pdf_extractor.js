/**
 * OCR-based PDF text extraction for trade confirmations.
 * Ported 1:1 from src/extractors/pdf_extractor.py
 *
 * Requires: pdf2pic (for pdf-to-image) and tesseract.js (for OCR).
 * Falls back gracefully if dependencies are missing.
 */

let pdf2picAvailable = false;
let tesseractAvailable = false;

async function ensureDeps() {
  if (pdf2picAvailable && tesseractAvailable) return;
  try {
    await import('pdf2pic');
    pdf2picAvailable = true;
  } catch { /* pdf2pic not installed */ }
  try {
    await import('tesseract.js');
    tesseractAvailable = true;
  } catch { /* tesseract.js not installed */ }
}

/**
 * Extract text from PDF bytes using OCR.
 * @param {Buffer} pdfBytes - Raw PDF file bytes
 * @returns {Promise<string>}
 */
export async function extractPdfText(pdfBytes) {
  await ensureDeps();

  if (!pdf2picAvailable || !tesseractAvailable) {
    return '[PDF_OCR_UNAVAILABLE]';
  }

  try {
    const { fromBuffer } = await import('pdf2pic');
    const Tesseract = await import('tesseract.js');

    const options = {
      density: 300,
      saveFilename: 'page',
      savePath: '/tmp',
      format: 'png',
      width: 2550,
      height: 3300,
    };

    const convert = fromBuffer(pdfBytes, options);
    // pdf2pic returns a function that converts all pages; we call it with page -1 for all
    const results = await convert(-1, { responseType: 'buffer' });

    // results is an array of { name, path, buffer } for each page
    const pages = Array.isArray(results) ? results : [results];
    const texts = [];

    for (const page of pages) {
      const imageBuffer = page.buffer || page;
      if (!imageBuffer) continue;

      const { data } = await Tesseract.recognize(imageBuffer, 'eng', {
        logger: () => {}, // suppress progress
      });
      if (data.text && data.text.trim()) {
        texts.push(data.text.trim());
      }
    }

    return texts.join('\n--- PAGE BREAK ---\n');
  } catch (e) {
    return `[PDF_OCR_ERROR: ${e.message}]`;
  }
}

/**
 * Extract text from a PDF file on disk.
 * @param {string} filepath
 * @returns {Promise<string>}
 */
export async function extractPdfTextFromFile(filepath) {
  const { existsSync, readFileSync } = await import('fs');
  if (!existsSync(filepath)) {
    return '[PDF_FILE_NOT_FOUND]';
  }
  return extractPdfText(readFileSync(filepath));
}
