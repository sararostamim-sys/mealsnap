// src/app/api/vision/route.ts
import { NextResponse } from 'next/server';
import {
  detectLabelsFromBuffer,
  detectTextFromBuffer,
} from '../../../lib/vision';

export const runtime = 'nodejs';        // required for @google-cloud/vision
export const maxDuration = 30;          // generous timeout for big images
export const dynamic = 'force-dynamic'; // don't cache

// Optional: make GET explicit (helps when you hit /api/vision in browser)
export async function GET() {
  return NextResponse.json(
    { error: 'Method Not Allowed. Use POST with multipart/form-data and a "file" field.' },
    { status: 405 }
  );
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
    }

    // Basic guards
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    if (file.type && !allowed.includes(file.type)) {
      return NextResponse.json({ error: `Unsupported content-type: ${file.type}` }, { status: 415 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (max 8MB).' }, { status: 413 });
    }

    const buf = Buffer.from(await file.arrayBuffer());

    const [labels, text] = await Promise.all([
      detectLabelsFromBuffer(buf, 10),
      detectTextFromBuffer(buf),
    ]);

    return NextResponse.json({ ok: true, labels, text });
  } catch (err: unknown) {
    // Surface useful errors from Google SDK (PERMISSION_DENIED, UNAUTHENTICATED, etc.)
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
    console.error('Vision API error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}