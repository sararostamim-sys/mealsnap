// src/lib/helpers.ts

/** ------------------------------------------------------------------
 * Mobile UA detection
 * -----------------------------------------------------------------*/
type NavigatorUA = Navigator & { userAgentData?: { mobile?: boolean } };

export function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorUA;
  if (nav.userAgentData?.mobile) return true;
  const ua = nav.userAgent || '';
  return /iphone|ipod|ipad|android|mobile/i.test(ua);
}

/** Safely coerce a value into an array (undefined/null -> []) */
export function asArray<T>(x: T | T[] | null | undefined): T[] {
  if (Array.isArray(x)) return x;
  if (x === null || x === undefined) return [];
  return [x as T];
}

/* ------------------------------------------------------------------
 * Pantry capture types
 * -----------------------------------------------------------------*/
export type DetectedItem = {
  name: string;
  qty?: number;
  unit?: string;
  confidence?: number;
  raw?: unknown;
};

/* ------------------------------------------------------------------
 * Size parsing + category rules
 * -----------------------------------------------------------------*/

const OZ_TO_G = 28.3495;
const ML_TO_FLOZ = 0.033814;

type ParsedSize = {
  oz?: number;      // solids in ounces
  floz?: number;    // liquids in fluid ounces
  g?: number;
  ml?: number;
  lb?: number;
};

function parseSizeText(s?: string): ParsedSize {
  const txt = (s || '').toLowerCase();

  // 14.5 oz  |  12oz  |  32 fl oz
  const oz = (txt.match(/(\d+(?:\.\d+)?)\s*oz\b(?!\s*fl)/) || [])[1];
  const floz = (txt.match(/(\d+(?:\.\d+)?)\s*fl\s*oz\b/) || [])[1];
  const g = (txt.match(/(\d+(?:\.\d+)?)\s*g\b/) || [])[1];
  const ml = (txt.match(/(\d+(?:\.\d+)?)\s*ml\b/) || [])[1];
  const lb = (txt.match(/(\d+(?:\.\d+)?)\s*lb\b/) || [])[1];

  const out: ParsedSize = {};
  if (oz) out.oz = parseFloat(oz);
  if (floz) out.floz = parseFloat(floz);
  if (g) out.g = parseFloat(g);
  if (ml) out.ml = parseFloat(ml);
  if (lb) out.lb = parseFloat(lb);

  // If we only have grams, also expose oz
  if (!out.oz && out.g) out.oz = out.g / OZ_TO_G;
  // If we only have ml, also expose fl oz
  if (!out.floz && out.ml) out.floz = out.ml * ML_TO_FLOZ;

  return out;
}

type QtyUnit = { qty: number; unit: string };

function suggestQtyUnit(name: string, sizeText?: string): QtyUnit {
  const t = name.toLowerCase();
  const sz = parseSizeText(sizeText);

  // Quick helpers
  const isLiquid = /\b(broth|stock|milk|vinegar|oil|sauce)\b/.test(t) || typeof sz.floz === 'number';
  const isCanned =
    /\b(can|canned|beans?|tomatoes?|tuna|sardines?)\b/.test(t) ||
    /\b\d+\s*(oz|g)\b/.test(sizeText || '');

  // 1) Direct from size when we can trust it
  if (isLiquid && sz.floz && sz.floz > 1) {
    return { qty: Math.round(sz.floz), unit: 'fl oz' };
  }
  if (!isLiquid && sz.lb && sz.lb > 0.5) {
    return { qty: Math.round(sz.lb), unit: 'lb' };
  }
  if (!isLiquid && sz.oz && sz.oz > 4) {
    return { qty: Math.round(sz.oz), unit: 'oz' };
  }

  // 2) Category defaults
  if (/\bbeans?\b/.test(t)) {
    // Canned beans → 1 can (≈15 oz)
    return { qty: 1, unit: 'can' };
  }
  if (/\btomatoes?\b|crushed|diced|paste\b/.test(t)) {
    return { qty: 1, unit: 'can' };
  }
  if (/\btuna\b|\bsardines?\b/.test(t)) {
    return { qty: 1, unit: 'can' };
  }
  if (/\bbroth\b|\bstock\b/.test(t)) {
    return { qty: 32, unit: 'fl oz' }; // 1 quart carton
  }
  if (/\bpasta\b|spaghetti|penne|fusilli|rigatoni|linguine|radiatori|orecchiette|macaroni\b/.test(t)) {
    return { qty: 16, unit: 'oz' }; // standard box
  }
  if (/\brice\b|basmati|jasmine|arborio\b/.test(t)) {
    return { qty: 16, unit: 'oz' }; // 1 lb bag default
  }
  if (/\boil\b|olive\b|extra\s*virgin\b|vegetable oil\b/.test(t)) {
    return { qty: 16, unit: 'fl oz' }; // small bottle
  }
  if (/\bmilk\b/.test(t)) {
    return { qty: 64, unit: 'fl oz' }; // half gallon default
  }
  if (/\bchicken\b|breast|thighs?|drumsticks?\b/.test(t)) {
    return { qty: 1, unit: 'lb' };
  }

  // 3) Produce → count
  if (/\btomato(es)?\b|\bgarlic\b|\bonion(s)?\b|\bpepper(s)?\b|\bapple(s)?\b/.test(t)) {
    return { qty: 1, unit: 'unit' };
  }

  // 4) Fallback
  return { qty: 1, unit: isLiquid ? 'fl oz' : 'unit' };
}

/* ------------------------------------------------------------------
 * OCR & UPC helpers (improved)
 * -----------------------------------------------------------------*/

type OCRResponse = { ok?: boolean; text?: string; error?: string };

// Pull in your name cleaners
import { properCaseName, stripBrandFromName } from '@/lib/normalize';

/**
 * Call your /api/ocr endpoint with a single image file (field name 'image').
 * We still return multiple DetectedItems (tokens), but each gets a smart qty/unit.
 */
export async function ocrDetectSingle(file: File): Promise<DetectedItem[]> {
  const fd = new FormData();
  fd.append('image', file);

  const res = await fetch('/api/ocr', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());

  const j: unknown = await res.json();
  const json: OCRResponse = (typeof j === 'object' && j !== null) ? (j as OCRResponse) : {};
  const text: string = json.text ?? '';

  const tokens = text
    .toLowerCase()
    .split(/\n|,|;|\/|•|·|\s{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const candidates = Array.from(
    new Set(tokens.filter((t) => /[a-z]/.test(t) && t.length >= 3 && t.length <= 48))
  ).slice(0, 8);

  return candidates.map((raw) => {
    const pretty = properCaseName(stripBrandFromName(raw, ''));
    const { qty, unit } = suggestQtyUnit(pretty);
    return {
      name: pretty.toLowerCase(),
      qty,
      unit,
      confidence: 0.7,
      raw: { source: 'ocr', token: raw } as const,
    };
  });
}

/* ------------------- UPC lookup helper ------------------- */

type UPCProduct = {
  brand?: string;
  name?: string;
  size?: string;
  category?: string;
  [k: string]: unknown;
};

type UPCReturn =
  | { ok?: boolean; found?: boolean; product?: UPCProduct; item?: UPCProduct }
  | UPCProduct;

function pickUPCProduct(x: unknown): UPCProduct | null {
  if (!x || typeof x !== 'object') return null;
  const obj = x as Record<string, unknown>;
  if (obj.product && typeof obj.product === 'object') return obj.product as UPCProduct;
  if (obj.item && typeof obj.item === 'object') return obj.item as UPCProduct;
  const maybe = obj as UPCProduct;
  if ('brand' in maybe || 'name' in maybe || 'size' in maybe || 'category' in maybe) return maybe;
  return null;
}

/**
 * Call your /api/upc endpoint and return a DetectedItem with a brandless name
 * and a sensible qty/unit suggestion based on the item family + parsed size.
 */
export async function upcLookup(codeOrTerm: string): Promise<DetectedItem> {
  const res = await fetch('/api/upc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: codeOrTerm }),
  });
  if (!res.ok) throw new Error(await res.text());

  const j: unknown = await res.json();
  const p = pickUPCProduct(j);

  // Brandless, proper-cased name
  const rawBrand = (p?.brand ?? '').trim();
  const rawName = (p?.name ?? '').trim();
  const brandless = properCaseName(stripBrandFromName(rawName, rawBrand) || rawName);

  const { qty, unit } = suggestQtyUnit(brandless, p?.size);

  return {
    name: brandless.toLowerCase(),
    qty,
    unit,
    confidence: 0.99,
    raw: p ?? j,
  };
}