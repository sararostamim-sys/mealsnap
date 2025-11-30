// src/lib/pricing.ts

// Minimal shape we need (matches your shopping rows)
export type BasicItem = {
  name: string;
  qty: number;
  unit: string;
};

export type StoreId = 'none' | 'sf_safeway' | 'sf_trader_joes';

export const STORES: { id: StoreId; label: string }[] = [
  { id: 'none',          label: 'No store selected' },
  { id: 'sf_safeway',    label: 'Safeway (SF – example data)' },
  { id: 'sf_trader_joes', label: 'Trader Joe’s (example data)' },
];

// ⚠️ Example-only, static price book.
// Keys should match normalized item names, e.g. "onion", "milk", "pasta".
const PRICE_BOOK: Record<StoreId, Record<string, { price: number; unit: string }>> = {
  none: {},
  sf_safeway: {
    avocado:        { price: 1.29, unit: 'each' },
    banana:         { price: 0.25, unit: 'each' },
    basil:          { price: 1.99, unit: 'bunch' },
    beef:           { price: 6.99, unit: 'lb' },
    'bell pepper':  { price: 1.29, unit: 'each' },
    cheese:         { price: 4.99, unit: 'block' },
    chickpea:       { price: 1.29, unit: 'can' },
    couscous:       { price: 2.49, unit: 'box' },
    cucumber:       { price: 0.99, unit: 'each' },
    dill:           { price: 1.99, unit: 'bunch' },
    egg:            { price: 3.99, unit: 'dozen' },
    feta:           { price: 3.99, unit: 'block' },
    flatbread:      { price: 3.99, unit: 'pack' },
    garlic:         { price: 0.50, unit: 'head' },
    lemon:          { price: 0.69, unit: 'each' },
    milk:           { price: 4.49, unit: 'carton' },
    mozzarella:     { price: 4.49, unit: 'block' },
    oat:            { price: 4.99, unit: 'bag' },
    'olive oil':    { price: 8.99, unit: 'bottle' },
    onion:          { price: 0.79, unit: 'each' },
    pasta:          { price: 1.49, unit: 'box' },
    salt:           { price: 1.29, unit: 'container' },
    spinach:        { price: 3.99, unit: 'bag' },
    'tomato sauce': { price: 2.49, unit: 'jar' },
    tortilla:       { price: 3.49, unit: 'pack' },
    yogurt:         { price: 1.29, unit: 'cup' },
  },
  sf_trader_joes: {
    avocado:        { price: 1.19, unit: 'each' },
    banana:         { price: 0.19, unit: 'each' },
    basil:          { price: 1.79, unit: 'bunch' },
    beef:           { price: 6.49, unit: 'lb' },
    'bell pepper':  { price: 1.19, unit: 'each' },
    cheese:         { price: 4.49, unit: 'block' },
    chickpea:       { price: 0.99, unit: 'can' },
    couscous:       { price: 2.29, unit: 'box' },
    cucumber:       { price: 0.99, unit: 'each' },
    dill:           { price: 1.79, unit: 'bunch' },
    egg:            { price: 3.49, unit: 'dozen' },
    feta:           { price: 3.49, unit: 'block' },
    flatbread:      { price: 3.79, unit: 'pack' },
    garlic:         { price: 0.50, unit: 'head' },
    lemon:          { price: 0.59, unit: 'each' },
    milk:           { price: 3.99, unit: 'carton' },
    mozzarella:     { price: 3.99, unit: 'block' },
    oat:            { price: 4.49, unit: 'bag' },
    'olive oil':    { price: 7.99, unit: 'bottle' },
    onion:          { price: 0.79, unit: 'each' },
    pasta:          { price: 1.29, unit: 'box' },
    salt:           { price: 1.19, unit: 'container' },
    spinach:        { price: 3.29, unit: 'bag' },
    'tomato sauce': { price: 1.99, unit: 'jar' },
    tortilla:       { price: 3.29, unit: 'pack' },
    yogurt:         { price: 1.19, unit: 'cup' },
  },
};

export type PriceEstimate = {
  price: number | null;
  unitLabel: string | null;
  source: 'none' | 'static-example';
};

// Single abstraction we will evolve over time.
// Later this can use categories, user CSVs, or external APIs without changing callers.
export function getPriceEstimate(item: BasicItem, storeId: StoreId): PriceEstimate {
  if (storeId === 'none') {
    return { price: null, unitLabel: null, source: 'none' };
  }

  const table = PRICE_BOOK[storeId];
  if (!table) {
    return { price: null, unitLabel: null, source: 'none' };
  }

  const key = item.name.toLowerCase();
  const entry = table[key];
  if (!entry) {
    return { price: null, unitLabel: null, source: 'static-example' };
  }

  return {
    price: entry.price,
    unitLabel: entry.unit,
    source: 'static-example',
  };
}