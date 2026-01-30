// src/lib/pantryCategorizer.ts

export type PantryCategory =
  | 'produce'
  | 'protein'
  | 'grains'
  | 'legumes'
  | 'dairy'
  | 'frozen'
  | 'canned'
  | 'snacks'
  | 'condiments'
  | 'spices'
  | 'baking'
  | 'beverages'
  | 'other';

export function autoCategoryFromName(name: string): PantryCategory {
  const n = name.toLowerCase().trim();
  if (!n) return 'other';

  const n2 = n
  .replace(/^(fresh|raw)\s+/i, '')
  .replace(/\(.*?\)/g, '')
  .replace(/,.*$/, '')
  .trim();
  // Herbs: fresh herbs -> Produce; dried/spice-jar herbs -> Spices
  const HERBS = /\b(parsley|basil|dill|cilantro|mint|thyme|rosemary|oregano)\b/;

  const DRIED_OR_SPICE_SIGNALS =
    /\b(dried|dry|ground|powder|flakes|granules|seasoning|spice|spices|rub)\b/;

  const JAR_SIGNALS = /\b(jar|bottle|shaker|container)\b/;

  // Spices that are almost never "fresh produce"
  const ALWAYS_SPICE = /\b(black pepper|peppercorn|salt)\b/;

  // Common spices / blends you want to bucket under "Spices"
  const COMMON_SPICES =
    /\b(cumin|paprika|smoked paprika|sumac|coriander|turmeric|cayenne|chili powder|red pepper flakes|garlic powder|onion powder|cinnamon|nutmeg|clove|allspice|ginger powder|shawarma|za'?atar|five spice)\b/;

  if (ALWAYS_SPICE.test(n2)) return 'spices';

  if (HERBS.test(n2)) {
    if (DRIED_OR_SPICE_SIGNALS.test(n2) || JAR_SIGNALS.test(n2)) return 'spices';
    return 'produce';
  }

  // Condiments, oils, sauces, dressings, pastes (tahini belongs here)
  if (
    /\b(ketchup|mustard|mayo|mayonnaise|soy sauce|tamari|teriyaki sauce|teriyaki|salsa|hot sauce|bbq sauce|barbecue sauce|vinegar|balsamic|olive oil|canola oil|vegetable oil|sesame oil|dressing|pesto|tahini|harissa|harissa paste|miso|gochujang|curry paste)\b/.test(
      n2,
    )
  ) {
    return 'condiments';
  }

  // Broad spice detection (keep BEFORE produce so "garlic powder" isn't produce)
  if (DRIED_OR_SPICE_SIGNALS.test(n2) || JAR_SIGNALS.test(n2) || COMMON_SPICES.test(n2)) {
    return 'spices';
  }

  // Fresh fruit & veg
  if (
  /\b(apple|banana|orange|pear|grape|berry|strawberry|blueberry|raspberry)\b/.test(n2) ||
  /\b(tomato|onion|garlic|bell pepper|cucumber|zucchini|squash|broccoli|cauliflower|carrot|spinach|lettuce|kale|greens|avocado|potato|sweet potato|lime|lemon|cilantro|parsley|basil|mint|dill|mushrooms?|green beans?|string beans?|corn|ginger)\b/.test(n2)
) {
  return 'produce';
}

  // Proteins (meat, fish, tofu, eggs)
if (
  /\b(chicken|beef|pork|ham|bacon|sausage|turkey|salmon|cod|fish|shrimp|tuna|tofu|tempeh|seitan|egg|eggs)\b/.test(
    n2,
  )
) {
  return 'protein';
}

  // Legumes (beans/lentils)
  if (/\b(lentil|lentils|chickpea|chickpeas|garbanzo|black bean|kidney bean|pinto bean|beans)\b/.test(n2)) {
  return 'legumes';
}

  // Grains, pasta, bread, tortillas
if (
  /\b(rice|quinoa|farro|barley|oats|oatmeal|couscous|pasta|spaghetti|penne|fusilli|macaroni|noodle)\b/.test(n2) ||
  /\b(bread|bagel|pita|naan|tortilla|wrap)\b/.test(n2)
) {
  return 'grains';
}

  // Dairy & dairy-like
  if (
  /\b(milk|yogurt|yoghurt|cheese|mozzarella|cheddar|parmesan|feta|butter|cream|half[- ]and[- ]half|sour cream)\b/.test(n2)
) return 'dairy';

  // Frozen items
  if (/frozen/.test(n2)) return 'frozen';

  // Canned / jarred basics
  if (/(canned|can\b|tin\b|tomato sauce|tomato paste|canned tomato|soup)/.test(n2)) {
    return 'canned';
  }

  // Snacks & sweets
  if (/(chip|cracker|cookie|biscuit|candy|chocolate|granola bar|protein bar|snack|pretzel)/.test(n2)) {
    return 'snacks';
  }

  // Baking supplies
  if (/(flour|sugar|brown sugar|baking powder|baking soda|yeast|cocoa powder|chocolate chips|cornstarch|vanilla extract)/.test(n2)) {
    return 'baking';
  }

  // Drinks
  if (/(coffee|espresso|tea|juice|soda|sparkling water|mineral water|seltzer|coconut water)/.test(n2)) {
    return 'beverages';
  }

  return 'other';
}

export function prettyCategoryLabel(cat: PantryCategory): string {
  switch (cat) {
    case 'produce':
      return 'Produce';
    case 'protein':
      return 'Meat & Protein';
    case 'grains':
      return 'Grains';
    case 'legumes':
      return 'Beans & Lentils';
    case 'dairy':
      return 'Dairy';
    case 'frozen':
      return 'Frozen';
    case 'canned':
      return 'Canned';
    case 'snacks':
      return 'Snacks';
    case 'condiments':
      return 'Condiments';
    case 'spices':
      return 'Spices';
    case 'baking':
      return 'Baking';
    case 'beverages':
      return 'Beverages';
    default:
      return 'Other';
  }
}