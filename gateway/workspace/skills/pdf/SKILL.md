---
name: pdf
description: Decrypt and extract text from PDFs using qpdf and pdftotext.
user-invocable: true
---

# PDF Tool

Use `qpdf` and `pdftotext` to handle PDFs the built-in parser cannot process.

## Encrypted PDFs

If a PDF is password-protected, decrypt it first:

```
exec: qpdf --decrypt --password=PASSWORD /path/to/encrypted.pdf /tmp/decrypted.pdf
```

Then extract text:

```
exec: pdftotext /tmp/decrypted.pdf -
```

## Scanned PDFs (no text)

If `pdftotext` returns empty, the PDF contains only images. Route to a module's `extract-pdf-text` tool for Tesseract OCR.

## Password Sources

Ask the user for the password. Never guess.
