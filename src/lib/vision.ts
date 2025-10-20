// src/lib/vision.ts
import fs from 'node:fs';
import vision from '@google-cloud/vision';

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  throw new Error(
    'GOOGLE_APPLICATION_CREDENTIALS is not set. Add it to .env.local and restart the dev server.'
  );
}

// Read the service-account JSON and extract credentials
const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as {
  client_email: string;
  private_key: string;
  project_id?: string;
};

export const client = new vision.ImageAnnotatorClient({
  credentials: {
    client_email: sa.client_email,
    private_key: sa.private_key,
  },
  projectId: sa.project_id,
});

export async function detectLabelsFromBuffer(buf: Buffer, max = 10): Promise<string[]> {
  const [res] = await client.labelDetection({ image: { content: buf } });
  return (res.labelAnnotations ?? [])
    .map(a => a.description ?? '')
    .filter(Boolean)
    .slice(0, max);
}

export async function detectTextFromBuffer(buf: Buffer): Promise<string> {
  const [res] = await client.textDetection({ image: { content: buf } });
  return res.fullTextAnnotation?.text?.trim() ?? '';
}