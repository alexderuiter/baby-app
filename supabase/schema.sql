-- Baby log: schema for Supabase (run once in the SQL editor).
--
-- v1 sharing model (placeholder until real sign-in lands):
-- every entry belongs to a "space" identified by a long random code.
-- The app sends that code in an `x-space-id` request header, and the
-- row-level security policies below only expose rows whose space_id
-- matches that header. Knowing the code = having access, like a share link.

create table if not exists public.entries (
  id          uuid primary key default gen_random_uuid(),
  space_id    text not null check (char_length(space_id) >= 16),
  type        text not null check (type in ('feed', 'diaper')),
  kind        text not null check (
                (type = 'feed'   and kind in ('left', 'right', 'bottle')) or
                (type = 'diaper' and kind in ('wet', 'dirty', 'both'))
              ),
  amount_ml   integer check (amount_ml is null or (amount_ml > 0 and amount_ml < 1000)),
  note        text check (note is null or char_length(note) <= 500),
  created_by  text check (created_by is null or char_length(created_by) <= 40),
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists entries_space_time_idx
  on public.entries (space_id, occurred_at desc);

alter table public.entries enable row level security;

create or replace function public.request_space_id() returns text
language sql stable as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-space-id', '')
$$;

drop policy if exists "space members can read"   on public.entries;
drop policy if exists "space members can insert" on public.entries;
drop policy if exists "space members can update" on public.entries;
drop policy if exists "space members can delete" on public.entries;

create policy "space members can read" on public.entries
  for select to anon, authenticated using (space_id = public.request_space_id());

create policy "space members can insert" on public.entries
  for insert to anon, authenticated with check (space_id = public.request_space_id());

create policy "space members can update" on public.entries
  for update to anon, authenticated
  using (space_id = public.request_space_id())
  with check (space_id = public.request_space_id());

create policy "space members can delete" on public.entries
  for delete to anon, authenticated using (space_id = public.request_space_id());
