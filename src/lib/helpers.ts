// src/lib/helpers.ts

/** Detect (roughly) if we're on a mobile user agent. */
export function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  // @ts-ignore (Chromium)
  if (navigator.userAgentData?.mobile) return true;
  const ua = navigator.userAgent || '';
  return /iphone|ipod|ipad|android|mobile/i.test(ua);
}

/** Safely coerce any value into an array (undefined/null -> []) */
export function asArray<T>(x: T | T[] | null | undefined): T[] {
  if (Array.isArray(x)) return x;
  if (x === null || x === undefined) return [];
  // @ts-ignore – if it’s not already an array, wrap it
  return [x];
}

/* ------------------------------------------------------------------ */
/* Pantry capture helpers (added)                                      */
/* ------------------------------------------------------------------ */

export type DetectedItem = {
  name: string;
  qty?: number;
  unit?: string;
  confidence?: number;
  raw?: any;
};

/**
 * Call your /api/ocr endpoint with a single image file (field name 'image').
 * Your current OCR route returns: { ok: boolean, text: string }
 * We split the merged text into candidate tokens so the user can confirm/edit.
 */
export async function ocrDetectSingle(file: File): Promise<DetectedItem[]> {
  const fd = new FormData();
  fd.append('image', file); // <-- matches your /api/ocr handler

  const res = await fetch('/api/ocr', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();

  const text: string = json.text ?? '';
  // Turn the big merged text into a small list of candidate item names
  const tokens = text
    .toLowerCase()
    .split(/\n|,|;|\/|•|·|\s{2,}/g)
    .map(s => s.trim())
    .filter(Boolean);

  const candidates = Array.from(
    new Set(
      tokens.filter(t => /[a-z]/.test(t) && t.length >= 3 && t.length <= 48)
    )
  ).slice(0, 8);

  return candidates.map(t => ({
    name: t,
    qty: 1,
    unit: 'unit',
    confidence: 0.7,
    raw: { source: 'ocr', token: t }
  }));
}

/**
 * Call your /api/upc endpoint.
 * You updated it to accept POST { code: "<digits or term>" } and return:
 *   { ok, found, product }  (product has brand/name/size/category)
 * We map that to a DetectedItem the pantry UI can use.
 */
export async function upcLookup(codeOrTerm: string): Promise<DetectedItem> {
  const res = await fetch('/api/upc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: codeOrTerm })
  });
  if (!res.ok) throw new Error(await res.text());
  const j = await res.json();

  // Your route returns { ok, found, product }.
  const p = j.product ?? j.item ?? j;
  const name =
    [p?.brand, p?.name].filter(Boolean).join(' ').toLowerCase() ||
    `item ${codeOrTerm}`;

  return {
    name,
    qty: 1,
    unit: 'unit',
    confidence: 0.99,
    raw: p
  };
}