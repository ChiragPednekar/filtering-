-- Applied to Supabase as `category_case_insensitive_filtering`.
--
-- The sheets spell categories inconsistently ('ai', 'Ai', 'AI', 'Tech ', 'tech').
-- Treating those as distinct makes the category filter unusable, but rewriting the
-- source values would destroy what the sheet actually said. Instead keep `category`
-- verbatim and derive a normalised array to match against.

create or replace function public.lower_array(arr text[])
returns text[]
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
    select array(
        select distinct lower(btrim(x))
        from unnest(arr) as x
        where btrim(x) <> ''
    );
$$;

alter table public.creators
    add column if not exists category_norm text[]
    generated always as (public.lower_array(category)) stored;

create index if not exists creators_category_norm_gin
    on public.creators using gin (category_norm);

-- Filter options for the app's controls. Category case variants collapse to one entry:
-- the most common spelling becomes the label, the lowercase form is the value the
-- query filters on, and `count` drives the frequency ordering in the dropdown.
create or replace function public.creators_filter_options()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    with cats as (
        select lower(btrim(c)) as value, btrim(c) as label
        from public.creators, unnest(category) as c
        where btrim(c) <> ''
    ),
    ranked as (
        select value, label, count(*) as n,
               row_number() over (partition by value order by count(*) desc, label) as rn
        from cats
        group by value, label
    ),
    labelled as (
        select value, label, sum(n) over (partition by value) as total
        from ranked where rn = 1
    )
    select jsonb_build_object(
        'categories', coalesce((
            select jsonb_agg(jsonb_build_object('value', value, 'label', label, 'count', total)
                             order by total desc, label)
            from labelled
        ), '[]'::jsonb),
        'countries', coalesce((
            select jsonb_agg(x order by x)
            from (select distinct btrim(country) as x from public.creators) t
            where x is not null and x <> ''
        ), '[]'::jsonb),
        'languages', coalesce((
            select jsonb_agg(x order by x)
            from (select distinct btrim(language) as x from public.creators) t
            where x is not null and x <> ''
        ), '[]'::jsonb),
        'platforms', coalesce((
            select jsonb_agg(x order by x)
            from (select distinct btrim(platform) as x from public.creators) t
            where x is not null and x <> ''
        ), '[]'::jsonb),
        'currencies', coalesce((
            select jsonb_agg(x order by x)
            from (select distinct commercials_currency as x from public.creators) t
            where x is not null
        ), '[]'::jsonb),
        'source_sheets', coalesce((
            select jsonb_agg(x order by x)
            from (select distinct source_sheet as x from public.creators) t
            where x is not null
        ), '[]'::jsonb),
        'ranges', (
            select jsonb_build_object(
                'subscribers', jsonb_build_object(
                    'min', coalesce(min(subscribers), 0), 'max', coalesce(max(subscribers), 0)),
                'followers', jsonb_build_object(
                    'min', coalesce(min(followers), 0), 'max', coalesce(max(followers), 0)),
                'commercials_amount', jsonb_build_object(
                    'min', coalesce(min(commercials_amount), 0), 'max', coalesce(max(commercials_amount), 0))
            )
            from public.creators
        ),
        'total_rows', (select count(*) from public.creators)
    );
$$;

grant execute on function public.creators_filter_options() to anon, authenticated, service_role;
grant execute on function public.lower_array(text[]) to anon, authenticated, service_role;

-- Applied as `lock_down_trigger_function`.
-- set_updated_at() is a trigger function, but Supabase exposes every public function
-- over /rest/v1/rpc. Being SECURITY DEFINER, it was callable by anon. Triggers run
-- regardless of EXECUTE grants, so revoking is safe and closes the RPC surface.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
