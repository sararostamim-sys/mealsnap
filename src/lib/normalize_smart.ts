// /lib/normalize_smart.ts
import { buildName, normalizeOcr, scanAllergens, detectCategory } from './normalize';

export type Draft = {
  brand: string;
  name: string;
  size: string;
  candidates: string[];
  labels?: string[];
  category?: string;
};

export function draftProductFromOcrSmart(rawOcr: string): Draft {
  const { cleanedText, brandHint, descriptors, size, category } = normalizeOcr(rawOcr);

  const resolvedCategory = category || detectCategory(cleanedText);

  const name = buildName({
    text: cleanedText,
    category: resolvedCategory,
    descriptors,
  });

  const labels = deriveLabels(cleanedText, descriptors, resolvedCategory);

  const candidates = Array.from(new Set([
    name,
    name.replace(/ & /g, ' and '),
  ].filter(Boolean)));

  return {
    brand: brandHint || '',
    name,
    size,
    candidates,
    labels,
    category: resolvedCategory || undefined,
  };
}

function deriveLabels(text: string, descriptors: string[], category?: string | ''): string[] {
  const L = new Set<string>();
  L.add('Food');

  const t = (text || '').toLowerCase();

  // Keep upstream category if present
  if (category) L.add(category);

  // --- Pantry families (prefer subtype over generic where possible) ---

  // Beans: add a specific bean type when detected; avoid also adding generic "Beans"
  let beanSubtype: string | null = null;
  if (/\bkidney\b/.test(t)) beanSubtype = 'Kidney beans';
  else if (/\bblack\b/.test(t)) beanSubtype = 'Black beans';
  else if (/\bgarbanzo\b|\bchickpea\b/.test(t)) beanSubtype = 'Chickpeas';
  else if (/\bpinto\b/.test(t)) beanSubtype = 'Pinto beans';
  else if (/\bcannellini\b/.test(t)) beanSubtype = 'Cannellini beans';
  else if (/\blentil\b/.test(t)) beanSubtype = 'Lentils';

  if (beanSubtype) {
    L.add(beanSubtype);
  } else if (/\bbeans?\b/.test(t)) {
    L.add('Beans');
  }

  if (/\bpasta\b/.test(t)) L.add('Pasta');
  if (/\brice\b/.test(t)) L.add('Rice');
  if (/\btomato(?:es)?\b/.test(t)) L.add('Tomatoes');
  if (/\bbroth\b|\bstock\b/.test(t)) L.add('Broth');
  if (/\bflour\b/.test(t)) L.add('Flour');
  if (/\bsugar\b/.test(t)) L.add('Sugar');
  if (/\bmilk\b|\balmond\b|\boat\b|\bsoy\b|\bcoconut\b/.test(t)) L.add('Milk');
  if (/\boil\b/.test(t)) L.add('Oil');
  if (/\bvinegar\b/.test(t)) L.add('Vinegar');
  if (/\btuna\b|\bsalmon\b|\bsardines?\b|\banchov(?:y|ies)\b|\bmackerel\b/.test(t)) L.add('Fish');

  // --- Descriptors ---
  if ((descriptors || []).some((d) => d.toLowerCase() === 'organic')) L.add('Organic');
  if (/\bgluten\s*free\b/i.test(text)) L.add('Gluten-free');
  if (/\bno\s+salt\s+added\b|\blow\s+sodium\b/i.test(text)) L.add('Low sodium');

  return Array.from(L);
}

export { scanAllergens };
