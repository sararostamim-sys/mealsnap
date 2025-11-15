// src/app/scan/page.tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  cleanOcrText,
  scanAllergens,
  extractSize,
  extractBrand,
  properCaseName,
  stripBrandFromName,
  extractTypeByCategory,
  detectCategory,
  postClean,
} from '@/lib/normalize';
import { draftProductFromOcrSmart } from '@/lib/normalize_smart';
import { matchCanonical } from '@/lib/match';
import { normalizeGtin } from '@/lib/gtin';
import products from '@/data/products.json';
const BarcodeScanner = dynamic(() => import('@/components/BarcodeScanner'), { ssr: false });
import { decodeBarcodeFromFile } from '@/components/BarcodeScanner';

// === Small helpers for barcode behavior ===========================

// For BARCODE scans only: choose a sensible default unit + qty
function inferFromBarcodeName(raw: string): { unit: string; qty: number } {
  const n = postClean(raw).toLowerCase();

  // Pasta / noodles / typical boxed shape
  if (/\b(pasta|spaghetti|penne|rigatoni|rigate|farfalle|farfalline|fusilli|noodles?)\b/.test(n)) {
    // Default to a typical 16 oz bag/box
    return { unit: 'oz', qty: 16 };
  }

  // Canned beans / veg / soups (things you usually add as "1 can")
  if (
    /\b(beans?|chickpeas?|garbanzos?|corn|peas|soup|broth|tomato(es)?|tuna|salmon)\b/.test(n) &&
    (/\b(can|canned)\b/.test(n) || /\btrader joe'?s\b/.test(n))
  ) {
    return { unit: 'can', qty: 1 };
  }

  // Rice / grains
  if (/\b(rice|quinoa|bulgur|couscous)\b/.test(n)) {
    return { unit: 'oz', qty: 16 };
  }

  // Fallback: let the UI behave as before
  return { unit: 'unit', qty: 1 };
}

// Normalize names so we can merge duplicates like
// "Organic Kidney Beans" & "Trader Joe's Kidney Beans"
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normKeyName(s: string): string {
  return postClean(s)
    .toLowerCase()
    .replace(/\b(trader joe'?s|kirkland|organic)\b/g, '') // strip brand / organic
    .replace(/\s+/g, ' ')
    .trim();
}

type Canonical = { id: string; brand: string; name: string; category?: string; score?: number };
type ProductSeed = { id: string; brand: string; name: string; category?: string };
type Draft = {
  brand: string;
  name: string;
  size: string;
  candidates: string[];
  unit?: string;       // for pantry merging + sensible defaults
  quantity?: number;   // default quantity (e.g., 1 can, 16 oz box)
};
type ResultT = {
  source: 'upc' | 'ocr';
  text: string;
  draft: Draft;
  labels: string[];
  allergens: string[];
  matches: Canonical[];
  previewUrl?: string | null;
};

// Treat the JSON catalog with a light type to avoid any
const catalog = products as unknown as ProductSeed[];

const BRAND_ALLOW_RE =
  /^(TRADER\s*JOE'?S|BARILLA|RUMMO|DE\s*CECCO|GAROFALO|COLAVITA|RUSTICHELLA|BUITONI|EATALY|RAO'?S|KELLOGG|GENERAL\s*MILLS|ANNIE'?S|BERTOLLI|CLASSICO|HEINZ|NESTL[EÉ]|GOYA|PROGRESSO|CAMPBELL'?S|O\s*ORGANICS)$/i;

/* -------------------- helpers (generic) -------------------- */

const useClassifier = () =>
  useCallback((t: string): string[] => {
    const txt = (t || '').toLowerCase();
    const out = new Set<string>(['Food']);

    // Pantry families
    if (/\bbeans?\b|kidney|black|garbanzo|chickpeas?|pinto|cannellini|lentils?\b/.test(txt)) out.add('Beans');
    if (/\bpasta|spaghetti|penne|farfalle|farfalline|fusilli|rigatoni|rotini|macaroni|radiatori|orecchiette|linguine|fettuccine|noodles?\b/.test(txt)) out.add('Pasta');
    if (/\brice\b|basmati|jasmine|arborio|sushi\b/.test(txt)) out.add('Rice');
    if (/\btomato(?:es)?\b|paste|sauce|crushed|diced\b/.test(txt)) out.add('Tomatoes');
    if (/\bbroth\b|\bstock\b/.test(txt)) out.add('Broth');
    if (/\bflour\b/.test(txt)) out.add('Flour');
    if (/\bsugar\b/.test(txt)) out.add('Sugar');
    if (/\bmilk\b|almond\s+milk|oat\s+milk|soy\s+milk\b/.test(txt)) out.add('Milk');
    if (/\boil\b|olive\b|extra\s*virgin\b/.test(txt)) out.add('Oil');
    if (/\bvinegar\b/.test(txt)) out.add('Vinegar');
    if (/\btuna\b|\bsalmon\b|\bsardines?\b|\banchov(?:y|ies)\b|\bmackerel\b/.test(txt)) out.add('Fish');

    // Descriptors
    if (/\borganic\b/.test(txt)) out.add('Organic');
    if (/\bgluten[- ]?free\b/.test(txt)) out.add('Gluten-free');
    if (/\bbrown\s+rice\b/.test(txt)) out.add('Brown rice');
    if (/\bwhole[-\s]?wheat\b/.test(txt)) out.add('Whole wheat');

    return Array.from(out);
  }, []);

// Suppress likely serving-size values for shelf-stable foods (keep liquids)
function sanitizeUPCSize(name: string, size: string | undefined, labels: string[]): string {
  if (!size) return '';
  const s = size.toLowerCase();

  const ozFl = (s.match(/(\d+(?:\.\d+)?)\s*fl\s*oz/) || [])[1];
  const oz = (s.match(/(\d+(?:\.\d+)?)\s*oz\b/) || [])[1]; // plain oz
  const g = (s.match(/(\d+(?:\.\d+)?)\s*g\b/) || [])[1];
  const ml = (s.match(/(\d+(?:\.\d+)?)\s*ml\b/) || [])[1];

  const ozVal = oz ? parseFloat(oz) : NaN;
  const gVal = g ? parseFloat(g) : NaN;
  const mlVal = ml ? parseFloat(ml) : NaN;

  const labelStr = `${name} ${labels.join(' ')}`.toLowerCase();
  const isLiquid = !!ozFl || /\bml\b|\bl(?!b)\b/i.test(s) || /(broth|soup|sauce|oil|vinegar|milk)/i.test(labelStr);

  // For non-liquids (pasta/beans/rice/tomatoes/etc), ignore tiny sizes that are likely "per serving"
  const looksPantry = /(beans|pasta|rice|tomato|flour|sugar)/i.test(labelStr);

  const verySmallOz = !isNaN(ozVal) && ozVal > 0 && ozVal <= 4;
  const verySmallG = !isNaN(gVal) && gVal > 0 && gVal <= 120;

  if (!isLiquid && looksPantry && (verySmallOz || verySmallG)) {
    return ''; // drop misleading serving sizes
  }

  if (!isNaN(ozVal) && ozVal >= 8) {
    return gVal && gVal >= 200 ? `${ozVal} oz (${gVal} g)` : `${ozVal} oz`;
  }
  if (!isNaN(gVal) && gVal >= 200) return `${gVal} g`;
  if (isLiquid && !isNaN(mlVal) && mlVal >= 200) return `${mlVal} ml`;
  return '';
}

const FAMILY_LABEL_BY_CATEGORY: Record<string, string> = {
  Beans: 'Beans',
  Pasta: 'Pasta',
  Rice: 'Rice',
  Tomatoes: 'Tomatoes',
  Broth: 'Broth',
  Flour: 'Flour',
  Sugar: 'Sugar',
  Milk: 'Milk',
  Oil: 'Oil',
  Vinegar: 'Vinegar',
  Fish: 'Fish',
};

function labelsWithPreferredSubtype(baseLabels: string[], text: string): string[] {
  const category = detectCategory(text);
  if (!category) return baseLabels;

  const { type, normalizedCategoryWord } = extractTypeByCategory(text, category);
  if (!type) return baseLabels;

  const set = new Set(baseLabels);
  const generic = FAMILY_LABEL_BY_CATEGORY[normalizedCategoryWord || category];
  if (generic && set.has(generic)) set.delete(generic);
  set.add(type);

  return Array.from(set);
}

export default function ScanPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('Scan a barcode or snap a clear FRONT label.');

  const [mounted, setMounted] = useState(false);
  const [canUseCamera, setCanUseCamera] = useState(false);
  const [camState, setCamState] =
    useState<'idle' | 'requesting' | 'running' | 'denied' | 'notfound'>('idle');

  const [result, setResult] = useState<ResultT | null>(null);

  const fileFrontRef = useRef<HTMLInputElement | null>(null);
  const fileBarcodeRef = useRef<HTMLInputElement | null>(null);

  const classifyFromText = useClassifier();

  useEffect(() => {
    setMounted(true);

    const secure =
      typeof window !== 'undefined' &&
      (window.isSecureContext || location.hostname === 'localhost');

    setCanUseCamera(secure && typeof navigator !== 'undefined' && 'mediaDevices' in navigator);
    if (!secure) {
      setHint('Camera requires HTTPS (or localhost). Upload a barcode/label photo instead.');
    }
  }, []);

  // ---------- image preprocess + OCR ----------
  async function preprocessFrontImage(
    file: File
  ): Promise<{ full: Blob; brCrop: Blob; topBrandCrop: Blob }> {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const u = URL.createObjectURL(file);
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Image load failed'));
      i.src = u;
    });

    const maxW = 1600;
    const scale = Math.min(1, maxW / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    // full canvas
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.filter = 'contrast(115%) brightness(105%)';
    ctx.drawImage(img, 0, 0, w, h);

    // bottom-right crop (size)
    const cw = Math.round(w * 0.55);
    const ch = Math.round(h * 0.45);
    const cx = Math.max(0, w - cw);
    const cy = Math.max(0, h - ch);
    const cropSize = document.createElement('canvas');
    cropSize.width = cw;
    cropSize.height = ch;
    const sctx = cropSize.getContext('2d')!;
    sctx.filter = 'contrast(125%) brightness(110%)';
    sctx.drawImage(c, cx, cy, cw, ch, 0, 0, cw, ch);

    // top-center crop (brand zone)
    const bw = Math.round(w * 0.7);
    const bh = Math.round(h * 0.3);
    const bx = Math.max(0, Math.round((w - bw) / 2));
    const by = 0;
    const cropBrand = document.createElement('canvas');
    cropBrand.width = bw;
    cropBrand.height = bh;
    const bctx = cropBrand.getContext('2d')!;
    bctx.filter = 'contrast(125%) brightness(110%)';
    bctx.drawImage(c, bx, by, bw, bh, 0, 0, bw, bh);

    const full = await new Promise<Blob>((res) =>
      c.toBlob((b) => res(b as Blob), 'image/jpeg', 0.9)
    );
    const brCrop = await new Promise<Blob>((res) =>
      cropSize.toBlob((b) => res(b as Blob), 'image/jpeg', 0.95)
    );
    const topBrandCrop = await new Promise<Blob>((res) =>
      cropBrand.toBlob((b) => res(b as Blob), 'image/jpeg', 0.95)
    );

    return { full, brCrop, topBrandCrop };
  }

  const runOcrServer = useCallback(async (blob: Blob) => {
    const fd = new FormData();
    fd.append('image', new File([blob], 'front.jpg', { type: 'image/jpeg' }));
    const res = await fetch('/api/ocr', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('OCR failed');
    const json = (await res.json()) as { ok?: boolean; text?: string };
    if (!json.ok) throw new Error('OCR failed');
    return json.text || '';
  }, []);

  const lookupUPC = useCallback(async (raw: string) => {
    const { candidates } = normalizeGtin(raw);

    for (const code of candidates) {
      const res = await fetch(`/api/upc?upc=${encodeURIComponent(code)}&debug=1`);
      if (!res.ok) continue;
      const j = (await res.json()) as {
        ok?: boolean;
        found?: boolean;
        product?: { brand?: string; name?: string; size?: string; category?: string };
      };
      if (j.ok && j.found && j.product) {
        return {
          brand: j.product.brand ?? '',
          name: j.product.name ?? '',
          size: j.product.size,
          category: j.product.category,
        };
      }
    }
    return null;
  }, []);

  // ---------- flows ----------
  async function handleFrontFile(file: File) {
    setBusy(true);
    setError('');
    setHint('Reading label…');
    try {
      const previewUrl = URL.createObjectURL(file);
      const { full, brCrop, topBrandCrop } = await preprocessFrontImage(file);

      // full image OCR
      const raw = await runOcrServer(full);
      const cleaned = cleanOcrText(raw);

      // size crop OCR
      let sizeFromCrop = '';
      try {
        const rawCrop = await runOcrServer(brCrop);
        sizeFromCrop = extractSize(cleanOcrText(rawCrop));
      } catch {
        // best-effort
      }

      // brand crop OCR
      let brandFromCrop = '';
      try {
        const rawBrand = await runOcrServer(topBrandCrop);
        brandFromCrop = extractBrand(cleanOcrText(rawBrand));
      } catch {
        // best-effort
      }

      // structured draft
      const draftSmart = draftProductFromOcrSmart(cleaned);
      const draftBase: Draft = {
        brand: draftSmart.brand || '',
        name: draftSmart.name || '',
        size: draftSmart.size || '',
        candidates: [draftSmart.brand, draftSmart.name, ...(draftSmart.candidates ?? [])].filter(
          Boolean
        ) as string[],
      };

      // Backfills
      if (!draftBase.size && sizeFromCrop) draftBase.size = sizeFromCrop;
      if (!draftBase.size) {
        const sizeRetry = extractSize(cleaned);
        if (sizeRetry) draftBase.size = sizeRetry;
      }
      if (!draftBase.brand && brandFromCrop) draftBase.brand = brandFromCrop;

      // Clean/proper-case the name (drop duplicated brand if any)
      draftBase.name = properCaseName(
        stripBrandFromName(draftBase.name, draftBase.brand || brandFromCrop || draftSmart.brand)
      );

      // Base labels from OCR
      let labels = Array.from(new Set([...classifyFromText(cleaned), ...(draftSmart.labels ?? [])]));
      // Prefer subtype (e.g., Kidney Beans) over family (Beans)
      labels = labelsWithPreferredSubtype(labels, cleaned);

      const allergens = scanAllergens(cleaned);

      const matches = matchCanonical(
        { ...draftBase, labels },
        catalog,
        { topK: 5 }
      ) as Canonical[];

      // Brand backfill from catalog (permissive)
      let brandFinal = draftBase.brand;
      if (!brandFinal && matches.length) {
        const top = matches[0];
        if ((top.score ?? 0) >= 0.12 && top.brand) brandFinal = top.brand;
      }
      const draft: Draft = { ...draftBase, brand: brandFinal };

      setResult({ source: 'ocr', text: cleaned, draft, labels, allergens, matches, previewUrl });
      setHint('Done! If something looks off, try a sharper front photo.');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Front-label read failed.';
      setError(msg);
      setHint('Try again with less glare and fill the frame.');
    } finally {
      setBusy(false);
    }
  }

  async function handleBarcode(upc: string) {
  setBusy(true);
  setError('');
  setHint(`Barcode ${upc} found. Looking up product…`);

  try {
    const prod = await lookupUPC(upc);

    if (prod) {
      // 1) Clean brand + name from provider
      const rawBrand = (prod.brand || '').trim();
      const rawName  = (prod.name  || '').trim();

      // Strip brand from name (so "Trader Joe's Organic Kidney Beans" -> "Organic Kidney Beans")
      const nameNoBrand = properCaseName(
        stripBrandFromName(rawName, rawBrand) || rawName
      );

      // 2) Build labels from a brandless-focused string
      const classifierInput = `${nameNoBrand} ${rawBrand}`.trim();

      let labels = classifyFromText(classifierInput);
      labels = labelsWithPreferredSubtype(labels, classifierInput);

      // 3) Sanitize the UPC size (hide serving sizes / weird formats for pantry use)
      const sizeClean = sanitizeUPCSize(nameNoBrand, prod.size, labels);

      // 4) Infer sensible unit + qty for BARCODE flows
      const { unit, qty } = inferFromBarcodeName(classifierInput);

      const draftBase: Draft = {
        brand: rawBrand,
        name:  nameNoBrand,
        size:  sizeClean,
        candidates: [rawBrand, nameNoBrand].filter(Boolean),
        unit,
        quantity: qty,
      };

      // For the “OCR Text” box / debug area, show our normalized summary
      const text = [rawBrand, nameNoBrand, sizeClean]
        .filter(Boolean)
        .join(' ')
        .trim();

      const allergens: string[] = [];

      const matches = matchCanonical(
        { ...draftBase, labels },
        catalog,
        { topK: 5 }
      ) as Canonical[];

      // 5) Brand backfill from catalog (permissive)
      let brandFinal = draftBase.brand;
      if (!brandFinal && matches.length) {
        const top = matches[0];
        if ((top.score ?? 0) >= 0.12 && top.brand) {
          brandFinal = top.brand;
        }
      }

      const draft: Draft = { ...draftBase, brand: brandFinal };

      setResult({
        source: 'upc',
        text,
        draft,
        labels,
        allergens,
        matches,
        previewUrl: null,
      });

      setHint(
        'Found by barcode. (Add a front photo if you want nutrition & allergens.)'
      );
    } else {
      setHint('Barcode not in database. Capture the FRONT label instead.');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Barcode lookup failed.';
    setError(msg);
  } finally {
    setBusy(false);
  }
}

  async function handleBarcodeFile(file: File) {
    setBusy(true);
    setError('');
    setHint('Reading barcode from photo…');
    try {
      const code = await decodeBarcodeFromFile(file);
      if (code) await handleBarcode(code);
      else setHint('Couldn’t read that barcode photo. Try again or use the live scanner.');
    } finally {
      setBusy(false);
    }
  }

  async function startScanner() {
    setError('');
    setCamState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      stream.getTracks().forEach((t) => t.stop());
      setCamState('running');
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'name' in e) {
        const n = String((e as { name?: string }).name || '');
        if (n === 'NotAllowedError') setCamState('denied');
        else if (n === 'NotFoundError' || n === 'OverconstrainedError') setCamState('notfound');
        else setError(e instanceof Error ? e.message : 'Camera error');
      } else {
        setError('Camera error');
      }
    }
  }

  const ResultBlock = useMemo(() => {
    if (!result) return null;
    const { draft, labels, allergens, matches, text, previewUrl, source } = result;

    const showBrand =
      (source === 'upc' && !!draft.brand) ||
      (source === 'ocr' && !!draft.brand && BRAND_ALLOW_RE.test(draft.brand));

    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mt-6">
        <div>
          <h2 className="text-xl font-semibold mb-3">Result</h2>
          <div className="space-y-1">
            <div>
              <span className="font-medium">Brand:</span> {showBrand ? draft.brand : '—'}
            </div>
            <div>
              <span className="font-medium">Name:</span> {draft.name || '—'}
            </div>
            <div>
              <span className="font-medium">Size:</span> {draft.size || '—'}
            </div>
          </div>

          <div className="mt-4">
            <h3 className="font-medium mb-1">Labels</h3>
            <ul className="list-disc list-inside text-sm">
              {labels.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>

          <div className="mt-4">
            <h3 className="font-medium mb-1">Allergens (from label)</h3>
            {allergens.length ? (
              <ul className="list-disc list-inside text-sm">
                {allergens.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-neutral-500">None detected</div>
            )}
          </div>

          <div className="mt-4">
            <h3 className="font-medium mb-1">Canonical matches</h3>
            {matches.length ? (
              <ol className="list-decimal list-inside text-sm space-y-1">
                {matches.map((m, i) => (
                  <li key={`${m.id}-${i}`}>
                    {m.brand} — {m.name} {m.category ? `(${m.category})` : ''}{' '}
                    {typeof m.score === 'number' ? `— score ${m.score.toFixed(3)}` : ''}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="text-sm text-neutral-500">No close catalog matches</div>
            )}
          </div>

          <div className="mt-4">
            <h3 className="font-medium mb-1">OCR Text</h3>
            <pre className="text-xs whitespace-pre-wrap bg-neutral-50 border rounded p-3">
              {text}
            </pre>
          </div>
        </div>

        <div>
          <h2 className="text-xl font-semibold mb-3">Preview</h2>
          <div className="w-full border rounded overflow-hidden flex items-center justify-center p-2 bg-black/5">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Front" className="max-w-full h-auto object-contain" />
            ) : (
              <div className="text-neutral-500 text-sm">No image</div>
            )}
          </div>
        </div>
      </div>
    );
  }, [result]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold">Scan</h1>
      <p className="mt-2 text-sm text-neutral-700">{hint}</p>

      <div className="mt-4 grid md:grid-cols-2 gap-6">
        {/* Barcode */}
        <div>
          <h3 className="font-medium mb-2">Scan Barcode</h3>

          {!mounted ? (
            <div /> // (or a tiny skeleton if you want)
          ) : canUseCamera ? (
            camState === 'running' ? (
              <BarcodeScanner
               onDetected={handleBarcode}
               onError={setError}
               maxWidth={360}    // tighter video width
               boxFrac={0.56}    // smaller inner aim box
               //showTorch        
               />
            ) : (
              <div className="space-y-2">
                <button onClick={startScanner} className="px-3 py-2 rounded-xl border text-sm">
                  {camState === 'requesting' ? 'Requesting camera…' : 'Start Scanner'}
                </button>
                {camState === 'denied' && (
                  <p className="text-xs text-red-600">Camera access was denied.</p>
                )}
                {camState === 'notfound' && (
                  <p className="text-xs text-red-600">
                    No camera found. Use “Upload Barcode Photo”.
                  </p>
                )}
              </div>
            )
          ) : (
            <div className="text-sm text-neutral-500 mb-2">Camera not available in this browser.</div>
          )}

          <div className="mt-2 flex gap-2">
            <button
              onClick={() => fileBarcodeRef.current?.click()}
              className="px-3 py-2 rounded-xl border text-sm"
            >
              Upload Barcode Photo
            </button>
            <input
              ref={fileBarcodeRef}
              type="file"
              accept="image/*,.jpg,.jpeg,.png,.webp,.heic,.heif"
              onChange={(e) => e.target.files?.[0] && handleBarcodeFile(e.target.files[0])}
              className="hidden"
            />
          </div>
        </div>

        {/* Front photo */}
        <div>
          <h3 className="font-medium mb-2">Front Label</h3>
          <div className="flex gap-2">
            <button
              onClick={() => fileFrontRef.current?.click()}
              className="px-3 py-2 rounded-xl border text-sm"
              disabled={busy}
            >
              Upload Photo
            </button>
            <button
              onClick={() => setResult(null)}
              className="px-3 py-2 rounded-xl border text-sm"
              disabled={busy}
            >
              Clear
            </button>
          </div>
          <input
            ref={fileFrontRef}
            type="file"
            accept="image/*,.jpg,.jpeg,.png,.webp,.heic,.heif"
            onChange={(e) => e.target.files?.[0] && handleFrontFile(e.target.files[0])}
            className="hidden"
          />
        </div>
      </div>

      {busy && <div className="mt-3 text-sm">Working…</div>}
      {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

      {ResultBlock}
    </div>
  );
}