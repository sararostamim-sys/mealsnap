// src/app/api/ocr/route.ts
import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
// NOTE: we lazy-load tesseract.js below to avoid build/bundle issues.
// import Tesseract from 'tesseract.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** ---------------- Tesseract typed lazy loader ---------------- */
type TessWord = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
};
type TessData = { text?: string; words?: TessWord[]; orientation?: { degrees?: number } };
type TessModule = {
  recognize: (
    image: Buffer | Uint8Array | string,
    lang: string,
    options?: Record<string, string | number | boolean>
  ) => Promise<{ data: TessData }>;
  detect: (
    image: Buffer | Uint8Array | string
  ) => Promise<{ data?: { orientation?: { degrees?: number } } }>;
};

async function getTesseract(): Promise<TessModule> {
  const mod = await import('tesseract.js');
  const maybe = mod as unknown as { default?: TessModule };
  return maybe.default ?? (mod as unknown as TessModule);
}

/** ---------------- geometry & scoring helpers ---------------- */
type Box = { left: number; top: number; width: number; height: number };

const clamp = (b: Box, W: number, H: number): Box => ({
  left: Math.max(0, Math.min(b.left, W - 1)),
  top: Math.max(0, Math.min(b.top, H - 1)),
  width: Math.max(40, Math.min(b.width, W - b.left)),
  height: Math.max(40, Math.min(b.height, H - b.top)),
});

const clean = (t: string) =>
  (t || '').replace(/[|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

function score(t: string) {
  const s = (t || '').toLowerCase();
  const uni =
    (s.match(
      /\b(trader|joe'?s|brown|rice|quinoa|fusilli|pasta|organic|beans?|kidney|black|pinto|oz|lb|g|ml|net\s*wt|organics)\b/g
    ) || []).length;
  const big = [/brown\s+rice/, /gluten[-\s]+free/, /quinoa\s+fusilli/, /net\s*wt/i, /red\s+kidney\s+beans?/i, /o\s*organics/i].reduce(
    (n, rx) => n + (rx.test(s) ? 1 : 0),
    0
  );
  const letters = (s.match(/[a-z]/g) || []).length;
  const garbage = (s.match(/[^a-z0-9&' \-\/,.\n():]/gi) || []).length;
  return big * 500 + uni * 120 + letters - garbage * 30;
}

const CFGS_GENERAL: Array<Record<string, string | number>> = [
  {
    tessedit_pageseg_mode: '6',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&' -/,.%()",
  },
  {
    tessedit_pageseg_mode: '7',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&' -/,.%()",
  },
  {
    tessedit_pageseg_mode: '11',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&' -/,.%()",
  },
];

const CFGS_SIZE_ONLY: Array<Record<string, string | number>> = [
  {
    tessedit_pageseg_mode: '6',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: 'NETWT0123456789OZFLLBGS() ./:kgmlKGMLozlb',
  },
  {
    tessedit_pageseg_mode: '7',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: '0123456789OZFL LBGS() ./:kgmlKGMLozlb',
  },
];

const CFGS_BRAND_ONLY: Array<Record<string, string | number>> = [
  {
    tessedit_pageseg_mode: '7',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
  },
  {
    tessedit_pageseg_mode: '11',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
  },
  {
    tessedit_pageseg_mode: '6',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
  },
];

/** ---------------- image variants ---------------- */
async function buildVariants(input: Buffer) {
  const baseBuf = await sharp(input)
    .rotate()
    .removeAlpha()
    .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: false })
    .toBuffer();

  // Auto orientation from Tesseract
  let deg = 0;
  try {
    const { detect } = await getTesseract();
    const det = await detect(baseBuf);
    deg = Math.round((det?.data?.orientation?.degrees ?? 0) / 90) * 90;
  } catch {
    // best-effort
  }
  const img = sharp(baseBuf).rotate(deg);
  const meta = await img.metadata();
  const W = meta.width || 1600;
  const H = meta.height || 2000;

  // Regions
  const top = clamp({ left: 0, top: Math.round(H * 0.06), width: W, height: Math.round(H * 0.26) }, W, H);
  const mid = clamp({ left: 0, top: Math.round(H * 0.42), width: W, height: Math.round(H * 0.22) }, W, H);
  const low = clamp({ left: 0, top: Math.round(H * 0.62), width: W, height: Math.round(H * 0.18) }, W, H);
  const center = clamp({ left: Math.round(W * 0.15), top: Math.round(H * 0.15), width: Math.round(W * 0.7), height: Math.round(H * 0.7) }, W, H);
  const sizeBox = clamp({ left: Math.round(W * 0.6), top: Math.round(H * 0.7), width: Math.round(W * 0.36), height: Math.round(H * 0.25) }, W, H);
  const brandBox = clamp({ left: Math.round(W * 0.15), top: 0, width: Math.round(W * 0.7), height: Math.round(H * 0.3) }, W, H);

  const mk = (s: sharp.Sharp) => s.jpeg({ quality: 94 }).toBuffer();

  const general: Buffer[] = [];
  const sizeOnly: Buffer[] = [];
  const brandOnly: Buffer[] = [];

  const add = async (
    which: 'general' | 'size' | 'brand',
    b: Box,
    opts: { thresh?: number; negate?: boolean; sharpen?: number; gray?: boolean } = {}
  ) => {
    let s = img.clone().extract(b);
    if (opts.gray !== false) s = s.grayscale();
    s = s.normalise();
    if (opts.thresh) s = s.threshold(opts.thresh);
    if (opts.negate) s = s.negate();
    if (opts.sharpen) s = s.sharpen(opts.sharpen);
    const buf = await mk(s);
    (which === 'general' ? general : which === 'size' ? sizeOnly : brandOnly).push(buf);
  };

  // GENERAL
  await add('general', { left: 0, top: 0, width: W, height: H }, { sharpen: 1 });
  await add('general', top, { sharpen: 1.2 });
  await add('general', mid, { sharpen: 1.2 });
  await add('general', low, { sharpen: 1.2 });
  await add('general', center, { sharpen: 1 });
  await add('general', mid, { thresh: 170 });
  await add('general', low, { thresh: 170 });
  await add('general', { left: 0, top: 0, width: W, height: H }, { thresh: 170 });

  // SIZE guesses
  await add('size', sizeBox, { thresh: 160 });
  await add('size', sizeBox, { thresh: 180, negate: true });

  // BRAND guesses
  await add('brand', brandBox, { sharpen: 1.3 });
  await add('brand', brandBox, { thresh: 170 });
  await add('brand', brandBox, { thresh: 180, negate: true });

  // Oriented full image for ROI
  const orientedFull = await mk(img.clone());

  return { general, sizeOnly, brandOnly, orientedFull, W, H };
}

/** ---------------- ROI discovery (size area) ---------------- */
async function findSizeROIs(fullJpeg: Buffer, W: number, H: number) {
  const { recognize } = await getTesseract();
  const { data } = await recognize(
    fullJpeg,
    'eng',
    {
      langPath: 'https://tessdata.projectnaptha.com/4.0.0_best/',
      oem: 1,
      tessedit_pageseg_mode: '6',
      user_defined_dpi: '300',
      preserve_interword_spaces: '1',
    }
  );

  const words: TessWord[] = (data?.words || []) as TessWord[];

  // Score words that look like size tokens
  const anchors = words
    .map((w): TessWord & { score: number } => {
      const t = (w.text || '').toLowerCase();
      const isNum = /^\d{1,4}(\.\d+)?$/.test(t);
      const unit =
        /\b(fl|net|wt|oz|lb|g|gram|grams|ml)\b/.test(t) ||
        /oz|lb|g|ml/.test(t);
      const bonus =
        (/\bnet\b/.test(t) ? 3 : 0) +
        (/\bwt\b/.test(t) ? 3 : 0) +
        (/\boz\b/.test(t) ? 2 : 0) +
        (/\blb\b/.test(t) ? 2 : 0) +
        (/\bg\b/.test(t) ? 1 : 0) +
        (/\bfl\b/.test(t) ? 1 : 0);
      const sc = (isNum ? 1 : 0) + (unit ? 1 : 0) + bonus + (w.confidence || 0) / 50;
      return { ...w, score: sc };
    })
    .filter((w) => w.score >= 2);

  const sorted = anchors.sort((a, b) => b.score - a.score).slice(0, 6);
  const boxes: Box[] = [];
  for (const a of sorted) {
    const x0 = Math.max(0, a.bbox.x0 - 40);
    const y0 = Math.max(0, a.bbox.y0 - 40);
    const x1 = Math.min(W, a.bbox.x1 + 220);
    const y1 = Math.min(H, a.bbox.y1 + 160);
    const b = clamp({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }, W, H);
    boxes.push(b);
    if (boxes.length >= 3) break;
  }
  return boxes;
}

/** ---------------- ROI variants ---------------- */
async function makeSizeROIVariants(base: Buffer, rois: Box[]) {
  const out: Buffer[] = [];
  for (const b of rois) {
    const crop = sharp(base).extract(b).grayscale().normalise().resize({
      width: Math.min(1200, b.width * 2),
      height: Math.min(800, b.height * 2),
      fit: 'inside',
      withoutEnlargement: false,
    });

    const baseBuf = await crop.jpeg({ quality: 96 }).toBuffer();
    out.push(baseBuf);

    // Threshold variants
    out.push(await sharp(baseBuf).threshold(160).jpeg({ quality: 96 }).toBuffer());
    out.push(await sharp(baseBuf).threshold(180).negate().jpeg({ quality: 96 }).toBuffer());

    // Small rotations (to counter label curvature / camera tilt)
    for (const deg of [-6, -3, 3, 6]) {
      out.push(await sharp(baseBuf).rotate(deg).jpeg({ quality: 96 }).toBuffer());
      out.push(await sharp(baseBuf).rotate(deg).threshold(170).jpeg({ quality: 96 }).toBuffer());
    }
  }
  return out.slice(0, 24); // cap to keep time in check
}

/** ---------------- recognizers ---------------- */
async function recognizeGeneral(bufs: Buffer[]) {
  const { recognize } = await getTesseract();
  const out: string[] = [];
  for (const b of bufs) {
    for (const cfg of CFGS_GENERAL) {
      const { data } = await recognize(
        b,
        'eng',
        { langPath: 'https://tessdata.projectnaptha.com/4.0.0_best/', oem: 1, ...cfg }
      );
      out.push(clean(data?.text || ''));
    }
  }
  return Array.from(new Set(out.filter(Boolean))).sort((a, b) => score(b) - score(a)).slice(0, 5);
}

async function recognizeBrand(bufs: Buffer[]) {
  const { recognize } = await getTesseract();
  const texts: string[] = [];
  for (const b of bufs) {
    for (const cfg of CFGS_BRAND_ONLY) {
      const { data } = await recognize(
        b,
        'eng',
        { langPath: 'https://tessdata.projectnaptha.com/4.0.0_best/', oem: 1, ...cfg }
      );
      texts.push(clean(data?.text || ''));
    }
  }
  return Array.from(new Set(texts.filter(Boolean)))
    .sort((a, b) => (score(b) - score(a)) || (a.length - b.length))
    .slice(0, 5)
    .join('\n');
}

async function recognizeSize(bufs: Buffer[]) {
  const { recognize } = await getTesseract();
  const texts: string[] = [];
  for (const b of bufs) {
    for (const cfg of CFGS_SIZE_ONLY) {
      const { data } = await recognize(
        b,
        'eng',
        { langPath: 'https://tessdata.projectnaptha.com/4.0.0_best/', oem: 1, ...cfg }
      );
      texts.push(clean(data?.text || ''));
    }
  }
  return Array.from(new Set(texts.filter(Boolean))).join('\n');
}

/** ---------------- handler ---------------- */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('image') as File | null;
    if (!file) return NextResponse.json({ ok: false, error: 'No file provided' }, { status: 400 });

    const buf = Buffer.from(await file.arrayBuffer());
    const { general, sizeOnly, brandOnly, orientedFull, W, H } = await buildVariants(buf);

    // Discover size ROIs from word boxes on the oriented full image
    let roiVariants: Buffer[] = [];
    try {
      const rois = await findSizeROIs(orientedFull, W, H);
      if (rois.length) {
        roiVariants = await makeSizeROIVariants(orientedFull, rois);
      }
    } catch {
      // ROI discovery is best-effort
    }

    const [generalTextTop5, brandText, sizeGuessText, sizeRoiText] = await Promise.all([
      recognizeGeneral(general),
      recognizeBrand(brandOnly),
      recognizeSize(sizeOnly),
      roiVariants.length ? recognizeSize(roiVariants) : Promise.resolve(''),
    ]);

    // Merge: best general candidates + brand strings + all size strings
    const merged = clean(
      [...generalTextTop5, brandText, sizeGuessText, sizeRoiText]
        .filter(Boolean)
        .join('\n')
    );

    return NextResponse.json({ ok: true, text: merged });
  } catch (e) {
    console.error('OCR error:', e);
    return NextResponse.json({ ok: false, error: 'OCR failed' }, { status: 500 });
  }
}