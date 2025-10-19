create table if not exists favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  recipe_id uuid not null references recipes(id) on delete cascade,
  title text not null,
  image_url text,
  source_url text,
  data jsonb,
  created_at timestamptz default now(),
  unique (user_id, recipe_id)
);