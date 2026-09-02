-- Applied to Supabase as `creator_name_and_usd_normalised_fees` and
-- `filter_options_native_currency_and_names`.
--
-- Three changes:
--   1. fx_rates -- auditable, refreshable conversion rates (see refresh_fx.py)
--   2. creator_name -- derived from the profile handle; the sheets have no name column
--   3. fees normalised to USD, with the quoted figure preserved
--
-- Why USD: filtering "under 500" previously mixed $500 with EUR 500 (~$580) and
-- INR 500 (~$5), so one filter meant several different things. Fees are now stored
-- in USD; commercials_amount_native keeps what the creator actually quoted, because
-- when you negotiate with a UK creator you need £500, not $676.

create table if not exists public.fx_rates (
    currency      text primary key,
    usd_per_unit  numeric(18,10) not null check (usd_per_unit > 0),
    as_of         date           not null,
    source        text,
    updated_at    timestamptz    not null default now()
);

alter table public.fx_rates enable row level security;
drop policy if exists fx_rates_read_all on public.fx_rates;
create policy fx_rates_read_all on public.fx_rates for select to anon, authenticated using (true);
grant select on public.fx_rates to anon, authenticated;
grant all on public.fx_rates to service_role;

-- Rates as of 2026-09-02 (exchangerate-api.com) are seeded by the applied migration;
-- refresh_fx.py --apply replaces them. See out/fx_rates.json for the full set.

create or replace function public.creator_name_from_url(url text)
returns text
language sql immutable strict parallel safe
set search_path = ''
as $$
    select nullif(
        btrim(ltrim(split_part(regexp_replace(url, '^https?://[^/]+/?', ''), '/', 1), '@'), ' .'),
        ''
    );
$$;

alter table public.creators
    add column if not exists creator_name text
    generated always as (public.creator_name_from_url(channel_link)) stored;

create index if not exists creators_creator_name_idx on public.creators (lower(creator_name));
create index if not exists creators_creator_name_trgm_idx
    on public.creators (creator_name text_pattern_ops);

alter table public.creators
    add column if not exists commercials_amount_native   numeric(14,2),
    add column if not exists commercials_currency_native text,
    add column if not exists fx_rate                     numeric(18,10),
    add column if not exists fx_rate_date                date;

-- Guarded so re-running can never double-convert.
update public.creators
set commercials_amount_native   = commercials_amount,
    commercials_currency_native = commercials_currency
where commercials_currency_native is null and commercials_currency is not null;

update public.creators c
set commercials_amount   = round(c.commercials_amount_native * r.usd_per_unit, 2),
    commercials_currency = 'USD',
    fx_rate              = r.usd_per_unit,
    fx_rate_date         = r.as_of
from public.fx_rates r
where r.currency = c.commercials_currency_native
  and c.commercials_amount_native is not null
  and c.fx_rate is null;

comment on column public.creators.commercials_amount is
    'Fee in USD, converted from commercials_amount_native at fx_rate on fx_rate_date.';
comment on column public.creators.commercials_amount_native is
    'Fee as quoted in the source sheet, in commercials_currency_native.';

-- creators_filter_options() was also updated so the currency filter offers the
-- currency each fee was QUOTED in (commercials_currency_native), since every stored
-- commercials_currency is now 'USD'. It additionally returns an 'fx' object carrying
-- the rate date, which the UI shows next to the fee filter.
