// src/lib/vision.ts
import fs from 'node:fs';
import path from 'node:path';
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';

// We lazy-initialize so Next/Vercel can import this file during build
// without immediately requiring credentials.
let client: ImageAnnotatorClient | null = null;

/**
 * Create (once) and return a Vision client.
 * Prefers GOOGLE_APPLICATION_CREDENTIALS_JSON (full JSON in an env var),
 * otherwise tries GOOGLE_APPLICATION_CREDENTIALS (path to a JSON file).
 * If neither is present, we throw *at call time* (never at import time).
 */
function getVisionClient(): ImageAnnotatorClient {
  if (client) return client;

  const jsonEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (jsonEnv && jsonEnv.trim().startsWith('{')) {
    // Service Account JSON stored directly in an env var
    const sa = JSON.parse(jsonEnv) as {
      client_email: string;
      private_key: string;
      project_id?: string;
    };
    client = new ImageAnnotatorClient({
      projectId: sa.project_id,
      credentials: {
        client_email: sa.client_email,
        private_key: sa.private_key,
      },
    });
    return client;
  }

  if (keyPath) {
    // If a path is provided, try to read and pass explicit credentials (your prior behavior).
    try {
      const abs = path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);
      const raw = fs.readFileSync(abs, 'utf8');
      const sa = JSON.parse(raw) as {
        client_email: string;
        private_key: string;
        project_id?: string;
      };
      client = new ImageAnnotatorClient({
        projectId: sa.project_id,
        credentials: {
          client_email: sa.client_email,
          private_key: sa.private_key,
        },
      });
      return client;
    } catch {
      // Fallback: let Google SDK resolve credentials from the path itself / metadata
      client = new ImageAnnotatorClient();
      return client;
    }
  }

  // No credentials configured (this is reached only when a function calls us)
  throw new Error(
    'Google Vision credentials not configured. Set GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS.'
  );
}

/** Detect up to `max` labels (keeps your mapping/limit behavior) */
export async function detectLabelsFromBuffer(buf: Buffer, max = 10): Promise<string[]> {
  const c = getVisionClient();
  const [res] = await c.labelDetection({
    image: { content: buf },
    features: [{ type: 'LABEL_DETECTION', maxResults: max }],
  } as protos.google.cloud.vision.v1.IAnnotateImageRequest);

  return (res.labelAnnotations ?? [])
    .map((a) => (typeof a.description === 'string' ? a.description : ''))
    .filter(Boolean)
    .slice(0, max);
}

/** Detect text; prefer full text, fall back to joining individual annotations */
export async function detectTextFromBuffer(buf: Buffer): Promise<string> {
  const c = getVisionClient();
  const [res] = await c.textDetection({ image: { content: buf } });

  const full = res.fullTextAnnotation?.text?.trim();
  if (full) return full;

  const joined =
    (res.textAnnotations ?? [])
      .map((a) => (typeof a.description === 'string' ? a.description : ''))
      .filter(Boolean)
      .join('\n')
      .trim() || '';

  return joined;
}