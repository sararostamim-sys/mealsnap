// src/lib/ocrTypes.ts
export type OcrResult = {
  rawText: string;      // full extracted text
  lines: string[];      // split by line, trimmed
  engine: 'tesseract' | 'vision';
};

export function normalizeTextToOcrResult(
  text: string,
  engine: 'tesseract' | 'vision'
): OcrResult {
  const rawText = text || '';
  const lines = rawText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  return { rawText, lines, engine };
}