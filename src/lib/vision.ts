// src/lib/vision.ts
import fs from 'node:fs';
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';

/**
 * Credential sources (priority):
 * 1) GOOGLE_APPLICATION_CREDENTIALS_DATA  (preferred): raw SA JSON
 * 2) GOOGLE_APPLICATION_CREDENTIALS       : filesystem path to SA JSON
 * 3) ADC (Application Default Credentials) : fallback if neither 1 nor 2 are set
 */

let _client: ImageAnnotatorClient | null = null;

function readServiceAccount(): {
  client_email: string;
  private_key: string;
  project_id?: string;
} {
  const inline = process.env.GOOGLE_APPLICATION_CREDENTIALS_DATA;
  if (inline && inline.trim()) {
    return JSON.parse(inline);
  }

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath && keyPath.trim()) {
    const raw = fs.readFileSync(keyPath, 'utf8');
    return JSON.parse(raw);
  }

  // Let caller decide whether to use ADC instead of throwing here.
  throw new Error(
    'Missing Vision credentials. Set GOOGLE_APPLICATION_CREDENTIALS_DATA (preferred) ' +
      'or GOOGLE_APPLICATION_CREDENTIALS (file path).'
  );
}

function getVisionClient(): ImageAnnotatorClient {
  if (_client) return _client;

  const hasInline = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS_DATA && process.env.GOOGLE_APPLICATION_CREDENTIALS_DATA.trim());
  const hasPath   = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_APPLICATION_CREDENTIALS.trim());

  if (hasInline || hasPath) {
    // Explicit service account
    const sa = readServiceAccount();
    _client = new ImageAnnotatorClient({
      credentials: {
        client_email: sa.client_email,
        private_key:  sa.private_key,
      },
      projectId: sa.project_id,
    });
  } else {
    // ADC (gcloud auth, GCP runtime, or platform-secret based)
    _client = new ImageAnnotatorClient();
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
  } catch {
    // Soft-fail so your pipeline continues
    return [];
  }
}

export async function detectTextFromBuffer(buf: Buffer): Promise<string> {
  const c = getVisionClient();

  const req = {
    image: { content: new Uint8Array(buf) },
    features: [{ type: 'TEXT_DETECTION' as const }],
  } satisfies protos.google.cloud.vision.v1.IAnnotateImageRequest;

  try {
    const [res] = await c.annotateImage(req);
    return res.fullTextAnnotation?.text?.trim() ?? '';
  } catch {
    // Soft-fail so your pipeline continues
    return '';
  }
}