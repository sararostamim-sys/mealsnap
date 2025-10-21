alter table inventory_items enable row level security;
create policy "dev_read_all_inventory" on inventory_items for select using (true);
create policy "dev_write_all_inventory" on inventory_items for insert with check (true);
create policy "dev_update_all_inventory" on inventory_items for update using (true);
create policy "dev_delete_all_inventory" on inventory_items for delete using (true);

-- repeat similar blocks for preferences, plans, plan_meals, shopping_lists, shopping_list_items...