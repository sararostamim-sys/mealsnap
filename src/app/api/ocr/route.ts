// src/app/api/ocr/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { detectTextFromBuffer } from '@/lib/vision';
import type { OcrResult } from '@/lib/ocrTypes';
import { cleanOcrText } from '@/lib/normalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const OCR_PIPELINE_VERSION = '2025-11-30-vision-only-v1';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    // Accept both "image" (your current field) and "file" (future-proof)
    const file = (form.get('image') || form.get('file')) as File | null;

    if (!file) {
      return NextResponse.json(
        { ok: false, error: 'No file provided' },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Use your existing Vision helper
    const raw = await detectTextFromBuffer(buffer);

    if (!raw || !raw.trim()) {
      return NextResponse.json(
        { ok: false, error: 'No text detected in image' },
        { status: 200 },
      );
    }

    // Normalize / clean the OCR text once
    const cleaned = cleanOcrText(raw);

    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const result: OcrResult = {
      rawText: raw,
      lines,
      engine: 'vision',
    };

    return NextResponse.json({
      ok: true,
      result,        // ✅ unified shape for new code
      text: cleaned, // ✅ keeps `text` for existing callers
      version: OCR_PIPELINE_VERSION,
    });
  } catch (e) {
    console.error('[OCR] route error:', e);
    const msg = (e as Error)?.message ?? String(e);

    return NextResponse.json(
      {
        ok: false,
        error:
          process.env.NODE_ENV === 'production'
            ? 'OCR failed'
            : msg,
      },
      { status: 500 },
    );
  }
}