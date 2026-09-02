-- Unified creator table built from the influencer Google Sheets.
--
-- Key design note: channel_link ALONE is not unique in the source data. 1,363 sheet
-- rows cover 1,059 distinct creators, and 100 of those creators carry genuinely
-- different negotiated fees across tabs (e.g. @timexplainsai is $700 in Sheet2 and
-- $800 in Sheet7). Some also appear twice inside one tab with different deliverable
-- packages. The uniqueness is therefore (channel_link, source_sheet, variant_no),
-- which preserves every real offer and still makes re-runs idempotent.

create table if not exists public.creators (
    id                    bigint generated always as identity primary key,

    -- Canonical profile/channel URL: scheme-normalised, no 'www.', no trailing '?' or '/'.
    channel_link          text        not null,
    -- The URL exactly as written in the sheet, only when it differs from channel_link.
    profile_link          text,

    mail                  text,
    email_id              text,

    category              text[]      not null default '{}',
    country               text,
    language              text,
    platform              text,

    -- YouTube populates subscribers; Instagram/TikTok populate followers.
    subscribers           integer,
    followers             integer,

    deliverables          text,

    -- Original fee string, kept verbatim for reference.
    commercials           text,
    -- Parsed from `commercials`. Where a cell lists several prices (an integration
    -- rate and a dedicated rate, say) this holds the LOWEST; every parsed value is
    -- kept in raw_data->'fee_parsed'.
    commercials_amount    numeric(14,2),
    commercials_currency  text,

    -- Which tab this row came from.
    source_sheet          text        not null,
    -- Distinguishes multiple genuine offers for one creator within one tab.
    variant_no            smallint    not null default 1,
    -- Content hash of the mapped row; changes when the source row is edited.
    row_fingerprint       text,

    -- Full original row plus every parsing note (unparsed fees, non-email values
    -- such as 'DM' or a WhatsApp link, multi-address emails, tax exclusions).
    raw_data              jsonb       not null default '{}'::jsonb,

    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),

    constraint creators_channel_link_not_blank check (length(btrim(channel_link)) > 0),
    constraint creators_subscribers_non_negative check (subscribers is null or subscribers >= 0),
    constraint creators_followers_non_negative   check (followers   is null or followers   >= 0),
    constraint creators_commercials_amount_non_negative
        check (commercials_amount is null or commercials_amount >= 0),
    constraint creators_currency_shape
        check (commercials_currency is null or commercials_currency ~ '^[A-Z]{3}$')
);

-- The upsert conflict target.
create unique index if not exists creators_natural_key_idx
    on public.creators (channel_link, source_sheet, variant_no);

create index if not exists creators_channel_link_idx  on public.creators (channel_link);
create index if not exists creators_platform_idx      on public.creators (platform);
create index if not exists creators_country_idx       on public.creators (country);
create index if not exists creators_source_sheet_idx  on public.creators (source_sheet);
create index if not exists creators_amount_idx        on public.creators (commercials_currency, commercials_amount);
create index if not exists creators_category_gin      on public.creators using gin (category);
create index if not exists creators_raw_data_gin      on public.creators using gin (raw_data jsonb_path_ops);

-- Keep updated_at honest across upserts.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists creators_set_updated_at on public.creators;
create trigger creators_set_updated_at
    before update on public.creators
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: service role only, nothing public.
-- ---------------------------------------------------------------------------
-- RLS is enabled with NO policies. Postgres denies every row to any role that RLS
-- applies to, so anon and authenticated (the keys shipped to browsers) can read and
-- write nothing. The service_role key bypasses RLS entirely, so the ETL still works.
-- Adding a policy later would open this up -- do that deliberately, not by accident.

alter table public.creators enable row level security;

-- Defence in depth: remove the table grants Supabase hands those roles by default,
-- so even a future policy cannot be reached without an explicit grant.
revoke all on public.creators from anon, authenticated;

grant all on public.creators to service_role;

comment on table public.creators is
    'Unified creator/influencer records from the source Google Sheets. RLS enabled '
    'with no policies: service_role only. Natural key (channel_link, source_sheet, variant_no).';
