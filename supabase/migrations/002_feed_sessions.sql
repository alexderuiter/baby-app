-- Feeding sessions: one feed row per session instead of one per breast/bottle.
-- A session starts at occurred_at and ends at ended_at (null while it is still running).
-- Safe to run on top of supabase/schema.sql; only adds nullable columns.

alter table public.entries
  add column if not exists ended_at         timestamptz,
  add column if not exists left_sec         integer check (left_sec  is null or left_sec  between 0 and 36000),
  add column if not exists right_sec        integer check (right_sec is null or right_sec between 0 and 36000),
  add column if not exists timer_side       text    check (timer_side is null or timer_side in ('left', 'right')),
  add column if not exists timer_started_at timestamptz,
  add column if not exists tags             text[]  not null default '{}';

-- Allow kind = 'session' for feeds (old rows keep 'left' / 'right' / 'bottle').
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.entries'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table public.entries drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.entries add constraint entries_kind_check check (
  (type = 'feed'   and kind in ('session', 'left', 'right', 'bottle')) or
  (type = 'diaper' and kind in ('wet', 'dirty', 'both'))
);

-- With sign-in enabled, updates are limited per column; allow the new session fields.
grant update (ended_at, left_sec, right_sec, timer_side, timer_started_at, tags, amount_ml, note, occurred_at)
  on public.entries to authenticated;
