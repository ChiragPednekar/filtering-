-- Applied to Supabase as `creators_read_access_and_filter_options`.
--
-- Read-only access for the desktop app's publishable/anon key.
-- SELECT only: inserts and updates still require the service role.
grant select on public.creators to anon, authenticated;

drop policy if exists creators_read_all on public.creators;
create policy creators_read_all
    on public.creators
    for select
    to anon, authenticated
    using (true);

-- Distinct filter options in one round trip. `category` is text[], so it needs
-- unnesting; computing this client-side would mean pulling every row just to build
-- dropdowns, which stops working as the table grows.
--
-- Superseded by 0003, which adds case-insensitive category grouping. Kept here so the
-- migration history replays in order.
