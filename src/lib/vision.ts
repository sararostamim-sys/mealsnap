// src/lib/vision.ts
import fs from 'node:fs';
import vision from '@google-cloud/vision';

/**
 * We support two ways to provide credentials (no secrets committed):
 * 1) GOOGLE_APPLICATION_CREDENTIALS_DATA: the full JSON pasted into an env var (Vercel-friendly)
 * 2) GOOGLE_APPLICATION_CREDENTIALS: absolute path to the JSON on disk (good for local dev)
 *
 * We lazily create the Vision client the first time it’s needed.
 */

let _client: vision.ImageAnnotatorClient | null = null;

function readServiceAccount(): {
  client_email: string;
  private_key: string;
  project_id?: string;
} {
  const inline = process.env.GOOGLE_APPLICATION_CREDENTIALS_DATA;
  if (inline) {
    return JSON.parse(inline);
  }

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS[_DATA] not set. Provide the service-account JSON via ' +
        'GOOGLE_APPLICATION_CREDENTIALS_DATA (recommended on Vercel) or a file path in GOOGLE_APPLICATION_CREDENTIALS.'
    );
  }

  const raw = fs.readFileSync(keyPath, 'utf8');
  return JSON.parse(raw);
}

export function getVisionClient(): vision.ImageAnnotatorClient {
  if (_client) return _client;

  const sa = readServiceAccount();
  _client = new vision.ImageAnnotatorClient({
    credentials: {
      client_email: sa.client_email,
      private_key: sa.private_key,
    },
    projectId: sa.project_id,
  });
  return _client;
}

/**
 * Label detection using the generic annotateImage endpoint.
 * (Avoids the stricter overload on labelDetection that caused the TS error.)
 */
export async function detectLabelsFromBuffer(buf: Buffer, max = 10): Promise<string[]> {
  const c = getVisionClient();
  const [res] = await c.annotateImage({
    image: { content: buf },
    features: [{ type: 'LABEL_DETECTION', maxResults: max }],
  });

  return (res.labelAnnotations ?? [])
    .map((a) => a.description ?? '')
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Text detection. Using annotateImage keeps types simple and works for both printed text
 * and most product labels. If you prefer OCR tuned for documents, swap to DOCUMENT_TEXT_DETECTION.
 */
export async function detectTextFromBuffer(buf: Buffer): Promise<string> {
  const c = getVisionClient();
  const [res] = await c.annotateImage({
    image: { content: buf },
    // You can try 'DOCUMENT_TEXT_DETECTION' if you’re scanning dense docs.
    features: [{ type: 'TEXT_DETECTION' }],
  });

  return res.fullTextAnnotation?.text?.trim() ?? '';
}