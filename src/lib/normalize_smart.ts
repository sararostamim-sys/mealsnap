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
  if (category) L.add(category);
  if (/\bbeans?\b/i.test(text)) L.add('Beans');
  if (/\bpasta\b/i.test(text)) L.add('Pasta');
  if (/\brice\b/i.test(text)) L.add('Rice');
  if (/\btomato(?:es)?\b/i.test(text)) L.add('Tomatoes');
  if (/\bbroth|stock\b/i.test(text)) L.add('Broth');
  if (/\bflour\b/i.test(text)) L.add('Flour');
  if (/\bsugar\b/i.test(text)) L.add('Sugar');
  if (/\bmilk|almond|oat|soy|coconut\b/i.test(text)) L.add('Milk');
  if (/\boil\b/i.test(text)) L.add('Oil');
  if (/\bvinegar\b/i.test(text)) L.add('Vinegar');
  if (/\btuna|salmon|sardines?|anchov(?:y|ies)|mackerel\b/i.test(text)) L.add('Fish');
  if (descriptors.find(d => d.toLowerCase() === 'organic')) L.add('Organic');
  if (/gluten\s*free/i.test(text)) L.add('Gluten Free');
  if (/no\s+salt\s+added|low\s+sodium/i.test(text)) L.add('Low Sodium');
  return Array.from(L);
}

export { scanAllergens };
