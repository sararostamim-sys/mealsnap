-- Ensure recipe_id is UUID (only cast if needed)
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_meal_plan_recipes'
      and column_name = 'recipe_id'
      and data_type <> 'uuid'
  ) then
    alter table public.user_meal_plan_recipes
      alter column recipe_id type uuid using recipe_id::uuid;
  end if;
end$$;

-- Add FK recipe_id -> recipes(id) if missing
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_plan_recipe_recipeid'
  ) then
    alter table public.user_meal_plan_recipes
      add constraint fk_plan_recipe_recipeid
      foreign key (recipe_id)
      references public.recipes(id)
      on delete cascade;
  end if;
end$$;

-- Unique slot per plan (plan_id, position)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_meal_plan_recipes_plan_pos_key'
  ) then
    alter table public.user_meal_plan_recipes
      add constraint user_meal_plan_recipes_plan_pos_key
      unique (plan_id, "position");
  end if;
end$$;

-- Helpful indexes (idempotent)
create index if not exists idx_user_meal_plan_user
  on public.user_meal_plan(user_id);

create index if not exists idx_plan_recipes_plan
  on public.user_meal_plan_recipes(plan_id);

create index if not exists idx_plan_recipes_recipe
  on public.user_meal_plan_recipes(recipe_id);