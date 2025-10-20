// src/app/vision-test/page.tsx
'use client';

import { useMemo } from 'react';
import { asArray } from '@/lib/helpers';
import { normalizeOcr, scanAllergens } from '@/lib/normalize';
import { draftProductFromOcrSmart } from '@/lib/normalize_smart';
import products from '@/data/products.json';
import { matchCanonical } from '@/lib/match';

type CanonicalMatch = {
  id: string;
  brand: string;
  name: string;
  category?: string;
  score?: number;
};

// Light type for the catalog JSON
type ProductSeed = { id: string; brand: string; name: string; category?: string };
const catalog = products as unknown as ProductSeed[];

export default function VisionTestPage() {
  // Demo text; in your app you likely pass OCR text into this page.
  const sampleText = `
    TRADER JOE'S
    ORGANIC BROWN RICE & QUINOA
    FUSILLI PASTA
    GLUTEN FREE  SODIUM FREE  NET WT. 16 OZ
  `;

  const { draft, labelTags, allergens, matches, text } = useMemo(() => {
    // normalizeOcr returns an object; we want the cleaned text string
    const norm = normalizeOcr(sampleText || '');
    const text = norm.cleanedText || '';

    // Feed the *string* into the smart drafter
    const rawDraft = draftProductFromOcrSmart(text || '');

    // SAFETY: coerce to a well-formed object so reads never crash
    const draft = {
      brand: rawDraft?.brand ?? '',
      name: rawDraft?.name ?? '',
      size: rawDraft?.size ?? '',
      candidates: asArray<string>(rawDraft?.candidates),
    };

    const labelTags = (() => {
      const t = (text || '').toLowerCase();
      const out = new Set<string>(['Food', 'Label']);
      if (/\bpasta|spaghetti|penne|farfalle|fusilli|rigatoni\b/.test(t)) out.add('Pasta');
      if (/\bvegan\b/.test(t)) out.add('Vegan');
      if (/\borganic\b/.test(t)) out.add('Organic');
      if (/\bgluten[- ]?free\b/.test(t)) out.add('Gluten-free');
      return Array.from(out);
    })();

    const allergens = asArray(scanAllergens(text || ''));

    const matches = matchCanonical(
  {
    brand: draft.brand,
    name: draft.name,
    size: draft.size,
    candidates: asArray(draft.candidates),
  },
  catalog,
  { topK: 5 }
) as CanonicalMatch[];

    return { draft, labelTags, allergens, matches, text };
  }, [sampleText]);

  const candidateList = asArray(draft?.candidates);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-4">Vision Test</h1>

      <div className="space-y-2">
        <div><span className="font-medium">Brand:</span> {draft?.brand || '—'}</div>
        <div><span className="font-medium">Name:</span> {draft?.name || '—'}</div>
        <div><span className="font-medium">Size:</span> {draft?.size || '—'}</div>
        {!!candidateList.length && (
          <div>
            <span className="font-medium">Candidates:</span> {candidateList.join(', ')}
          </div>
        )}
      </div>

      <div className="mt-6">
        <h3 className="font-medium mb-1">Labels</h3>
        {labelTags.length ? (
          <ul className="list-disc list-inside text-sm">
            {labelTags.map((l) => <li key={l}>{l}</li>)}
          </ul>
        ) : <div className="text-sm text-neutral-500">None</div>}
      </div>

      <div className="mt-6">
        <h3 className="font-medium mb-1">Allergens</h3>
        {allergens.length ? (
          <ul className="list-disc list-inside text-sm">
            {allergens.map((a) => <li key={a}>{a}</li>)}
          </ul>
        ) : <div className="text-sm text-neutral-500">None detected</div>}
      </div>

      <div className="mt-6">
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
        ) : <div className="text-sm text-neutral-500">No close catalog matches</div>}
      </div>

      <div className="mt-6">
        <h3 className="font-medium mb-1">OCR Text</h3>
        <pre className="text-xs whitespace-pre-wrap bg-neutral-50 border rounded p-3">{text}</pre>
      </div>
    </div>
  );
}