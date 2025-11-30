// src/lib/groceryLinks.ts

// Simple helpers for external grocery search links

export type GroceryPlatform = 'instacart' | 'walmart';

/** Normalize an ingredient name into a clean store-search term */
function normalizeSearchTerm(raw: string | null | undefined): string {
  if (!raw) return '';

  return raw
    // Drop anything in parentheses: "(about 1 cup)", "(optional)", etc.
    .replace(/\(.*?\)/g, '')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build an Instacart search URL for a single search term */
export function buildInstacartUrl(term: string): string {
  const cleaned = normalizeSearchTerm(term);

  // If we somehow still have nothing, just send them to the store search home
  if (!cleaned) {
    // This avoids every possible "...undefined" situation
    return 'https://www.instacart.com/store';
  }

  const q = encodeURIComponent(cleaned);

  // Path-style search tends to be more stable than ?q= for Instacart
  return `https://www.instacart.com/store/search/${q}`;
}

/** Build a Walmart search URL for a single search term */
export function buildWalmartUrl(term: string): string {
  const cleaned = normalizeSearchTerm(term);
  const q = encodeURIComponent(cleaned || 'groceries');
  return `https://www.walmart.com/search?q=${q}`;
}

/** Build an Amazon Fresh search URL for a single search term */
export function buildAmazonFreshUrl(term: string): string {
  const q = encodeURIComponent((term ?? '').trim());
  // "i=amazonfresh" scopes the search to Amazon Fresh
  return `https://www.amazon.com/s?k=${q}&i=amazonfresh`;
}