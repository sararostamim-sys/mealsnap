// /app/api/upc/route.ts
import { NextRequest, NextResponse } from 'next/server';
import products from '@/data/products.json'; // <-- fuzzy fallback for text terms

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// ---------------- in-memory cache ----------------
type UPCProduct = { brand: string; name: string; size?: string; category?: string };
type CacheEntry = { product: UPCProduct; ts: number };
const CACHE = new Map<string, CacheEntry>();

// -------------- helpers: size parsing --------------
const OZ_TO_G = 28.3495;

function parseSizeUnits(size: string) {
  const s = (size || '').toLowerCase();
  const oz = [...s.matchAll(/\b(\d+(?:\.\d+)?)\s*oz\b/g)].map(m => parseFloat(m[1]));
  const g  = [...s.matchAll(/\b(\d+(?:\.\d+)?)\s*g\b/g)].map(m => parseFloat(m[1]));
  return { oz, g };
}
function toG(n: number) { return n * OZ_TO_G; }
function formatSize(oz?: number, g?: number) {
  const ozTxt = typeof oz === 'number'
    ? (Number.isInteger(oz) ? `${oz} oz` : `${oz.toFixed(1)} oz`)
    : '';
  const gTxt = typeof g === 'number' ? `${Math.round(g)} g` : '';
  if (ozTxt && gTxt) return `${ozTxt} (${gTxt})`;
  if (ozTxt) return ozTxt;
  if (gTxt) return gTxt;
  return '';
}

/** If both oz and g are present (or can be inferred), present both nicely. */
function reconcileMixedUnits(original: string): string {
  const { oz, g } = parseSizeUnits(original);
  if (!oz.length && !g.length) return (original || '').trim();

  const maxOz = oz.length ? Math.max(...oz) : undefined;
  const maxG  = g.length  ? Math.max(...g)  : undefined;

  const maxOzG = typeof maxOz === 'number' ? toG(maxOz) : undefined;
  const bigG = Math.max(
    typeof maxG === 'number'  ? maxG  : 0,
    typeof maxOzG === 'number'? maxOzG: 0
  );

  if (!bigG) return (original || '').trim();

  const chosenOz = typeof maxOz === 'number'
    ? maxOz
    : (typeof maxG === 'number' ? (maxG / OZ_TO_G) : undefined);
  const chosenG  = typeof maxG === 'number'
    ? maxG
    : (typeof maxOz === 'number' ? toG(maxOz) : undefined);

  return formatSize(chosenOz, chosenG) || (original || '').trim();
}

// Pantry/canned signal for serving-size suppression
const CANNED_PANTRY_RX = /\b(beans?|tomatoes?|soup|broth|sardines?|tuna|olives?|corn|peas|sauce|paste|pickles?)\b/i;

// ---------------- small helpers (new) ----------------
function cleanCode(s: string) { return (s || '').replace(/[^\d]/g, ''); }
function isDigits(s: string) { return /^[0-9]{8,14}$/.test(s); } // EAN-8..GTIN-14
function norm(x: string) { return String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function fuzzyFind(term: string) {
  const needle = norm(term);
  // exact brand+name
  let hit = (products as any[]).find(p => norm(`${p.brand} ${p.name}`) === needle);
  if (hit) return hit;
  // name only
  hit = (products as any[]).find(p => norm(p.name) === needle);
  if (hit) return hit;
  // contains
  hit = (products as any[]).find(p =>
    norm(`${p.brand} ${p.name}`).includes(needle) || norm(p.name).includes(needle)
  );
  return hit ?? null;
}

// -------------- OFF v2 fetch & normalization --------------
async function fetchOFFv2(upc: string, debug: boolean) {
  const url = `https://world.openfoodfacts.net/api/v2/product/${encodeURIComponent(upc)}`;
  const res = await fetch(url, { next: { revalidate: 60 } });
  const tried = { code: upc, source: 'off_v2', status: res.status };

  if (!res.ok) {
    if (debug) console.info('[upc] OFF v2 HTTP error', res.status);
    return { ok: false as const, tried };
  }

  const j = await res.json().catch(() => null) as any;
  if (!j || j.status !== 1 || !j.product) {
    if (debug) console.info('[upc] OFF v2 no product');
    return { ok: false as const, tried };
  }

  const p = j.product;

  const brand: string =
    (typeof p.brands === 'string' && p.brands.split(',')[0]?.trim()) ||
    (typeof p.brand === 'string' ? p.brand.trim() : '') ||
    '';

  const name: string =
    (typeof p.product_name === 'string' && p.product_name.trim()) ||
    (typeof p.generic_name === 'string' && p.generic_name.trim()) ||
    '';

  let sizeRaw = (typeof p.quantity === 'string' ? p.quantity.trim() : '') || '';

  if (!sizeRaw) {
    const pq = (typeof p.product_quantity === 'number' ? p.product_quantity : undefined);
    const pqu = (typeof p.product_quantity_unit === 'string' ? p.product_quantity_unit : '').toLowerCase();
    if (typeof pq === 'number' && (pqu === 'g' || pqu === 'ml')) {
      sizeRaw = `${pq} ${pqu}`;
    }
  }

  return {
    ok: true as const,
    tried,
    product: { brand, name, sizeRaw, servingSize: (typeof p.serving_size === 'string' ? p.serving_size : '') }
  };
}

// ---------------- GET (unchanged behavior; now accepts ?code= as well) ----------------
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const upcParam = url.searchParams.get('upc') || url.searchParams.get('code') || '';
  const refresh = url.searchParams.get('refresh') === '1';
  const debug = url.searchParams.get('debug') === '1';

  const code = cleanCode(upcParam);
  const tried: Array<{ code: string; source: string; status: number | string }> = [];

  if (!code) {
    return NextResponse.json({ ok: true, found: false, product: null, tried: [{ code: '', source: 'cache', status: 'miss' }] });
  }

  // 1) cache
  if (!refresh && CACHE.has(code)) {
    const hit = CACHE.get(code)!;
    tried.push({ code, source: 'cache', status: 'hit' });
    return NextResponse.json({ ok: true, found: true, product: hit.product, tried });
  } else if (!refresh) {
    tried.push({ code, source: 'local', status: 'miss' });
  }

  // 2) OFF v2
  const off = await fetchOFFv2(code, debug);
  tried.push(off.tried);

  if (!off.ok) {
    return NextResponse.json({ ok: true, found: false, product: null, tried });
  }

  const cannedSignal = CANNED_PANTRY_RX.test(off.product.name || '');
  const originalSize = (off.product.sizeRaw || '').trim();

  let chosenSize = '';
  if (originalSize) {
    const reconciled = reconcileMixedUnits(originalSize);
    if (reconciled && reconciled !== originalSize && debug) {
      console.info('[upc] reconciled size', { upc: code, from: originalSize, to: reconciled });
    }
    chosenSize = reconciled || originalSize;
  } else if (off.product.servingSize) {
    const s = off.product.servingSize.toLowerCase();
    const gramsOnly = (s.match(/(\d+(?:\.\d+)?)\s*g\b/i) || [])[1] && !/oz/.test(s);
    const gramsVal = gramsOnly ? parseFloat((s.match(/(\d+(?:\.\d+)?)\s*g\b/i) || [])[1]!) : NaN;
    const looksLikeServing = gramsOnly && !Number.isNaN(gramsVal) && gramsVal < 200 && cannedSignal;

    if (looksLikeServing) {
      chosenSize = ''; // suppress
      if (debug) console.info('[upc] suppressing serving-size', { upc: code, s });
    } else {
      chosenSize = reconcileMixedUnits(off.product.servingSize);
      if (debug && chosenSize !== off.product.servingSize) {
        console.info('[upc] reconciled serving size', { upc: code, from: off.product.servingSize, to: chosenSize });
      }
    }
  }

  const product: UPCProduct = {
    brand: off.product.brand || '',
    name: off.product.name || '',
    size: chosenSize || undefined,
    category: undefined
  };

  // cache & return
  CACHE.set(code, { product, ts: Date.now() });
  return NextResponse.json({ ok: true, found: true, product, tried });
}

// ---------------- POST (new) ----------------
// Accepts JSON { code: "<digits or search term>" } or { q: "..."/term: "..." }
// - If digits: same OFF path as GET (plus cache)
// - If text: fuzzy match against src/data/products.json (lets "Spaghetti" work)
export async function POST(req: NextRequest) {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return NextResponse.json({ ok: false, error: 'Use application/json' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({} as any));
  const raw = String(body.code ?? body.q ?? body.term ?? '').trim();
  if (!raw) return NextResponse.json({ ok: false, error: 'Missing code' }, { status: 400 });

  // Numeric UPC/EAN/GTIN → run same flow as GET
  if (isDigits(raw)) {
    const code = cleanCode(raw);
    const url = new URL(req.url);
    const refresh = url.searchParams.get('refresh') === '1';
    const debug = url.searchParams.get('debug') === '1';

    const tried: Array<{ code: string; source: string; status: number | string }> = [];

    if (!refresh && CACHE.has(code)) {
      const hit = CACHE.get(code)!;
      tried.push({ code, source: 'cache', status: 'hit' });
      return NextResponse.json({ ok: true, found: true, product: hit.product, tried });
    } else if (!refresh) {
      tried.push({ code, source: 'local', status: 'miss' });
    }

    const off = await fetchOFFv2(code, debug);
    tried.push(off.tried);

    if (!off.ok) {
      return NextResponse.json({ ok: true, found: false, product: null, tried });
    }

    const cannedSignal = CANNED_PANTRY_RX.test(off.product.name || '');
    const originalSize = (off.product.sizeRaw || '').trim();

    let chosenSize = '';
    if (originalSize) {
      const reconciled = reconcileMixedUnits(originalSize);
      chosenSize = reconciled || originalSize;
    } else if (off.product.servingSize) {
      const s = off.product.servingSize.toLowerCase();
      const gramsOnly = (s.match(/(\d+(?:\.\d+)?)\s*g\b/i) || [])[1] && !/oz/.test(s);
      const gramsVal = gramsOnly ? parseFloat((s.match(/(\d+(?:\.\d+)?)\s*g\b/i) || [])[1]!) : NaN;
      const looksLikeServing = gramsOnly && !Number.isNaN(gramsVal) && gramsVal < 200 && cannedSignal;
      chosenSize = looksLikeServing ? '' : reconcileMixedUnits(off.product.servingSize);
    }

    const product: UPCProduct = {
      brand: off.product.brand || '',
      name: off.product.name || '',
      size: chosenSize || undefined,
      category: undefined
    };
    CACHE.set(code, { product, ts: Date.now() });
    return NextResponse.json({ ok: true, found: true, product, tried });
  }

  // Text term → fuzzy search products.json
  const hit = fuzzyFind(raw);
  if (!hit) {
    return NextResponse.json({ ok: true, found: false, product: null, tried: [{ code: raw, source: 'products.json', status: 'miss' }] });
  }

  const product: UPCProduct = {
    brand: hit.brand,
    name: hit.name,
    category: hit.category,
    size: undefined
  };

  return NextResponse.json({
    ok: true,
    found: true,
    product,
    tried: [{ code: raw, source: 'products.json', status: 'hit' }]
  });
}