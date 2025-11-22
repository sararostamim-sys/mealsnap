// src/lib/tesseractOcr.ts
import Tesseract from 'tesseract.js';
import { normalizeTextToOcrResult, OcrResult } from './ocrTypes';

export async function runTesseractOcr(imageBuffer: Buffer): Promise<OcrResult> {
  const { data } = await Tesseract.recognize(imageBuffer, 'eng', {
    // any config you already had
  });

  const text = data.text || '';
  return normalizeTextToOcrResult(text, 'tesseract');
}