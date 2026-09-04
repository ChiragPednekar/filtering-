-- Applied to Supabase as `sheet_sync_log_and_prune`, `prune_by_sync_watermark`
-- and `sync_cron_schedule`. See SYNC.md for how the pieces fit together.

create table if not exists public.sync_log (
    id            bigint generated always as identity primary key,
    trigger       text        not null,
    status        text        not null check (status in ('running','ok','error')),
    started_at    timestamptz not null default now(),
    finished_at   timestamptz,
    rows_upserted integer,
    rows_deleted  integer,
    sheet_hash    text,
    error         text,
    detail        jsonb
);
create index if not exists sync_log_started_idx on public.sync_log (started_at desc);
alter table public.sync_log enable row level security;
drop policy if exists sync_log_read_all on public.sync_log;
create policy sync_log_read_all on public.sync_log for select to anon, authenticated using (true);
grant select on public.sync_log to anon, authenticated;
grant all on public.sync_log to service_role;

-- Each sync stamps every row it writes; the prune then deletes whatever it did not
-- stamp. Shipping one key per row instead meant a ~1,255-element text[] through
-- PostgREST, which failed converting JSON to text.
alter table public.creators add column if not exists last_synced_at timestamptz;
create index if not exists creators_last_synced_idx on public.creators (source_sheet, last_synced_at);

create or replace function public.sync_prune_creators(p_tabs text[], p_run_at timestamptz)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
    v_total integer; v_doomed integer; v_deleted integer;
begin
    if p_tabs is null or array_length(p_tabs, 1) is null then return 0; end if;

    select count(*) into v_total from public.creators where source_sheet = any(p_tabs);
    select count(*) into v_doomed from public.creators
     where source_sheet = any(p_tabs)
       and (last_synced_at is null or last_synced_at < p_run_at);

    -- A bad export or half-written edit must not be able to wipe the table.
    if v_total > 0 and v_doomed::numeric / v_total > 0.20 then
        raise exception
            'refusing to prune % of % rows (>20%%); sheet may be truncated or mis-parsed',
            v_doomed, v_total;
    end if;

    with gone as (
        delete from public.creators
         where source_sheet = any(p_tabs)
           and (last_synced_at is null or last_synced_at < p_run_at)
        returning 1
    )
    select count(*) into v_deleted from gone;
    return v_deleted;
end;
$$;
revoke execute on function public.sync_prune_creators(text[], timestamptz) from public, anon, authenticated;
grant execute on function public.sync_prune_creators(text[], timestamptz) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- A token the database generates for itself, so the scheduled job never needs the
-- shared secret written into cron.job.command (readable by anyone with DB access).
create table if not exists public.sync_auth (
    id         smallint primary key default 1 check (id = 1),
    token      text not null default encode(extensions.gen_random_bytes(32), 'hex'),
    created_at timestamptz not null default now()
);
alter table public.sync_auth enable row level security;
revoke all on public.sync_auth from anon, authenticated;
grant all on public.sync_auth to service_role;
insert into public.sync_auth (id) values (1) on conflict (id) do nothing;

create or replace function public.trigger_sheet_sync(p_trigger text default 'cron')
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_token text; v_id bigint;
begin
    select token into v_token from public.sync_auth where id = 1;
    select net.http_post(
        url     := 'https://akqhuzgekjsvrizysfmp.supabase.co/functions/v1/sync-sheet',
        headers := jsonb_build_object('Content-Type','application/json','x-sync-secret',v_token),
        body    := jsonb_build_object('trigger', p_trigger),
        timeout_milliseconds := 120000
    ) into v_id;
    return v_id;
end;
$$;
revoke execute on function public.trigger_sheet_sync(text) from public, anon, authenticated;
grant execute on function public.trigger_sheet_sync(text) to service_role;

-- Safety net behind the Apps Script trigger.
select cron.unschedule('sheet-sync') where exists (select 1 from cron.job where jobname = 'sheet-sync');
select cron.schedule('sheet-sync', '*/15 * * * *', $cron$ select public.trigger_sheet_sync('cron'); $cron$);

-- Applied as `reinstall_pg_net_in_extensions_schema`.
-- pg_net installed itself into `public`, putting http_post on the API surface, and it
-- does not support SET SCHEMA -- so it has to be recreated in `extensions`.
drop extension if exists pg_net cascade;
create extension pg_net with schema extensions;
-- (trigger_sheet_sync is recreated above/after this in the applied migration.)

-- Note: the row-level repairs (placeholder clearing, Category/Language/Country
-- reordering, fee cells holding deliverables text) live in the Edge Function and
-- etl.py, not in SQL -- see supabase/functions/sync-sheet/repair.ts and the matching
-- helpers in etl.py. They are applied on every sync.

-- Applied as `every_minute_sync_with_overlap_guard`.
-- Cadence changed from */15 to every minute: freshness matters more than the cost of
-- re-reading an unchanged sheet. trigger_sheet_sync() now skips a scheduled tick while
-- a run is still in flight (started under 5 minutes ago and unfinished), which removes
-- the race where a newer run's prune could delete rows an older, slower run had not
-- yet re-stamped. Also adds a nightly prune keeping 7 days of successful sync_log rows;
-- errors are kept indefinitely.

-- Applied as `multi_sheet_sources_and_brand` + `brand_scoped_prune_and_registration`.
--
-- Multiple brands, each with its own Google Sheet, registered in sheet_sources.
-- The blocking problem was the natural key: (channel_link, source_sheet, variant_no)
-- where source_sheet is just a tab name, so a second brand whose workbook also has a
-- "Sheet2" would overwrite the first brand's rows -- and the prune would then delete
-- whatever it did not recognise. brand is therefore part of the key, and
-- sync_prune_creators takes a brand so syncing one sheet never prunes another's rows.

-- Applied as `manually_added_creators`.
-- Creators typed into the app rather than read from a sheet. Without the flag they
-- would be deleted within a minute: the prune removes any row in a synced brand that
-- the latest run did not stamp, and a hand-added row never is. Flagging them keeps
-- them safe under any brand, so a manual creator can sit alongside a brand's sheet rows.
