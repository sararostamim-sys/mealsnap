// src/lib/vision.ts
import fs from 'node:fs';
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { normalizeTextToOcrResult, OcrResult } from './ocrTypes';

type ServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

/**
 * Credential sources (priority):
 * 1) GOOGLE_APPLICATION_CREDENTIALS_DATA  (preferred): raw SA JSON
 * 2) GOOGLE_APPLICATION_CREDENTIALS       : filesystem path to SA JSON
 * 3) ADC (Application Default Credentials) : fallback if neither 1 nor 2 are valid
 */

let _client: ImageAnnotatorClient | null = null;

function readServiceAccount(): ServiceAccount | null {
  // 1) Inline JSON
  const inline = process.env.GOOGLE_APPLICATION_CREDENTIALS_DATA;
  if (inline && inline.trim()) {
    try {
      const parsed = JSON.parse(inline);
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
        project_id: parsed.project_id,
      };
    } catch (e) {
      console.error('[Vision] Failed to parse GOOGLE_APPLICATION_CREDENTIALS_DATA:', e);
      // Fall through to other methods / ADC
    }
  }

  // 2) File path
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath && keyPath.trim()) {
    try {
      if (!fs.existsSync(keyPath)) {
        console.warn(
          `[Vision] GOOGLE_APPLICATION_CREDENTIALS points to '${keyPath}', ` +
            'but the file does not exist. Falling back to ADC.'
        );
        return null;
      }
      const raw = fs.readFileSync(keyPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
        project_id: parsed.project_id,
      };
    } catch (e) {
      console.error('[Vision] Failed to read/parse service account file:', e);
      // Fall back to ADC instead of crashing
      return null;
    }
  }

  // 3) Nothing explicit → let ADC handle it
  return null;
}

function getVisionClient(): ImageAnnotatorClient {
  if (_client) return _client;

  const sa = readServiceAccount();

  if (sa) {
    // Explicit service account
    _client = new ImageAnnotatorClient({
      credentials: {
        client_email: sa.client_email,
        private_key: sa.private_key,
      },
      projectId: sa.project_id,
    });
    console.log('[Vision] Using explicit service account credentials.');
  } else {
    // ADC (gcloud auth, runtime identity, Vercel secret-backed, etc.)
    _client = new ImageAnnotatorClient();
    console.log('[Vision] Using Application Default Credentials (ADC).');
  }

  return _client;
}

export async function detectLabelsFromBuffer(
  buf: Buffer,
  max = 10
): Promise<string[]> {
  const c = getVisionClient();

  const req = {
    image: { content: new Uint8Array(buf) },
    features: [{ type: 'LABEL_DETECTION' as const, maxResults: max }],
  } satisfies protos.google.cloud.vision.v1.IAnnotateImageRequest;

  try {
    const [res] = await c.annotateImage(req);
    return (res.labelAnnotations ?? [])
      .map(a => a.description ?? '')
      .filter(Boolean)
      .slice(0, max);
  } catch (e) {
    console.warn('[Vision] LABEL_DETECTION failed (soft-fail):', (e as Error)?.message ?? e);
    // Soft-fail so your pipeline continues
    return [];
  }
}

/**
 * Low-level helper: returns raw text only (backwards compatible).
 */
export async function detectTextFromBuffer(buf: Buffer): Promise<string> {
  const c = getVisionClient();

  const req = {
    image: { content: new Uint8Array(buf) },
    features: [{ type: 'TEXT_DETECTION' as const }],
  } satisfies protos.google.cloud.vision.v1.IAnnotateImageRequest;

  try {
    const [res] = await c.annotateImage(req);
    return res.fullTextAnnotation?.text?.trim() ?? '';
  } catch (e) {
    console.warn('[Vision] TEXT_DETECTION failed (soft-fail):', (e as Error)?.message ?? e);
    // Soft-fail so your pipeline continues
    return '';
  }
}

/**
 * High-level helper for OCR pipeline.
 * Returns unified OcrResult shape used by /api/ocr.
 */
export async function runVisionOcr(buf: Buffer): Promise<OcrResult> {
  const text = await detectTextFromBuffer(buf);
  return normalizeTextToOcrResult(text, 'vision');
}