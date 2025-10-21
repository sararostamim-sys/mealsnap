-- USERS (if you rely on Supabase auth, a public "profiles" mirror is handy)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz default now()
);

-- PREFERENCES
create table if not exists preferences (
  user_id uuid primary key references profiles(id) on delete cascade,
  diet text check (diet in ('none','vegetarian','vegan','halal','kosher','gluten-free')) default 'none',
  allergies text[] default '{}',
  disliked_ingredients text[] default '{}',
  budget_level text check (budget_level in ('low','medium','high')) default 'medium',
  max_prep_time integer default 45,
  servings integer default 2,
  updated_at timestamptz default now()
);

-- INVENTORY
create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  product_id text,             -- canonical key (from taxonomy)
  name text not null,          -- display name (e.g., "2% Milk 1L")
  qty numeric default 1,
  unit text,                   -- "g", "ml", "pcs"
  expiry date,
  confidence numeric default 0.8,
  source_photo_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists inventory_user_idx on inventory_items(user_id);

-- RECIPES
create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  time_min integer,
  cuisine text,
  diet_tags text[] default '{}',
  cost_estimate numeric,
  created_at timestamptz default now()
);

create table if not exists recipe_ingredients (
  recipe_id uuid references recipes(id) on delete cascade,
  product_id text,             -- canonical key to match taxonomy
  name text not null,          -- ingredient display (e.g., "Greek yogurt")
  qty numeric,
  unit text,
  optional boolean default false,
  primary key (recipe_id, name)
);

-- PLANS
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  start_date date not null default (now()::date),
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists plan_meals (
  plan_id uuid references plans(id) on delete cascade,
  day integer check (day between 1 and 7),
  meal_type text check (meal_type in ('breakfast','lunch','dinner')),
  recipe_id uuid references recipes(id),
  primary key (plan_id, day, meal_type)
);

-- SHOPPING LISTS
create table if not exists shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  plan_id uuid references plans(id) on delete cascade,
  total_estimate numeric,
  created_at timestamptz default now()
);

create table if not exists shopping_list_items (
  list_id uuid references shopping_lists(id) on delete cascade,
  product_id text,
  name text not null,
  qty numeric,
  unit text,
  store_hint text,
  price_estimate numeric,
  category text,
  primary key (list_id, name)
);