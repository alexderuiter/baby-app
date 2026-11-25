-- Baby log: schema for Supabase (run once in the SQL editor).
--
-- Sharing model:
--   * Everyone signs in with their email (Supabase Auth, magic link or 6-digit code).
--   * A "space" is one baby's shared log. Its caregivers are rows in `members`.
--   * Any caregiver can make an invite link (a random token that expires after 7 days).
--     Opening it and signing in adds you to the space via `accept_invite()`.
--   * Row-level security: you only see and change data of spaces you are a member of.
--
-- Upgrading from the first version (x-space-id header): that version only held test
-- data, so drop it first:  drop table if exists public.entries cascade;

-- ---------- tables ----------

create table if not exists public.spaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.members (
  space_id     uuid not null references public.spaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  role         text not null default 'caregiver' check (role in ('owner', 'caregiver')),
  joined_at    timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index if not exists members_user_idx on public.members (user_id);

create table if not exists public.invites (
  token       text primary key check (char_length(token) >= 16),
  space_id    uuid not null references public.spaces (id) on delete cascade,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  revoked_at  timestamptz
);
create index if not exists invites_space_idx on public.invites (space_id);

create table if not exists public.entries (
  id              uuid primary key default gen_random_uuid(),
  space_id        uuid not null references public.spaces (id) on delete cascade,
  type            text not null check (type in ('feed', 'diaper')),
  kind            text not null check (
                    (type = 'feed'   and kind in ('left', 'right', 'bottle')) or
                    (type = 'diaper' and kind in ('wet', 'dirty', 'both'))
                  ),
  amount_ml       integer check (amount_ml is null or (amount_ml > 0 and amount_ml < 1000)),
  note            text check (note is null or char_length(note) <= 500),
  -- Who logged it: the account, plus their name at that moment (kept if they leave).
  created_by_user uuid default auth.uid() references auth.users (id) on delete set null,
  created_by      text check (created_by is null or char_length(created_by) <= 40),
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists entries_space_time_idx
  on public.entries (space_id, occurred_at desc);

-- ---------- helpers (security definer so policies don't recurse) ----------

create or replace function public.is_member(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where space_id = s and user_id = auth.uid())
$$;

create or replace function public.is_owner(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where space_id = s and user_id = auth.uid() and role = 'owner')
$$;

-- Create a space and become its owner in one step.
create or replace function public.create_space(baby_name text, my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into spaces (name, created_by) values (trim(baby_name), auth.uid()) returning id into new_id;
  insert into members (space_id, user_id, display_name, role)
    values (new_id, auth.uid(), trim(my_name), 'owner');
  return new_id;
end $$;

-- What an invite link points to, so the join screen can say "Alex invited you to Mila's log".
-- Callable before signing in; only works if you have the token.
drop function if exists public.invite_preview(text);
create function public.invite_preview(invite_token text)
returns table (space_id uuid, space_name text, invited_by text, expires_at timestamptz, usable boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.name,
         (select m.display_name from members m where m.space_id = i.space_id and m.user_id = i.created_by),
         i.expires_at,
         i.revoked_at is null and i.expires_at > now()
  from invites i join spaces s on s.id = i.space_id
  where i.token = invite_token
$$;

-- Join the space an invite link points to. Safe to call twice.
create or replace function public.accept_invite(invite_token text, my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv invites;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into inv from invites where token = invite_token;
  if not found then raise exception 'This invite link is not valid'; end if;
  if exists (select 1 from members where space_id = inv.space_id and user_id = auth.uid()) then
    return inv.space_id;
  end if;
  if inv.revoked_at is not null or inv.expires_at <= now() then
    raise exception 'This invite link has expired. Ask for a new one.';
  end if;
  insert into members (space_id, user_id, display_name)
    values (inv.space_id, auth.uid(), trim(my_name));
  return inv.space_id;
end $$;

revoke all on function public.create_space(text, text) from public, anon;
revoke all on function public.accept_invite(text, text) from public, anon;
grant execute on function public.create_space(text, text)  to authenticated;
grant execute on function public.accept_invite(text, text) to authenticated;
grant execute on function public.invite_preview(text)      to anon, authenticated;

-- ---------- row-level security ----------

alter table public.spaces  enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.entries enable row level security;

-- Column-level limits on top of RLS: you can rename yourself but not change your role,
-- make or revoke an invite but not choose its expiry, and not move an entry to another space or author.
revoke update on public.members from anon, authenticated;
grant  update (display_name) on public.members to authenticated;
revoke update on public.invites from anon, authenticated;
grant  update (revoked_at) on public.invites to authenticated;
revoke insert on public.invites from anon, authenticated;
grant  insert (token, space_id) on public.invites to authenticated;
revoke update on public.entries from anon, authenticated;
grant  update (kind, amount_ml, note, occurred_at) on public.entries to authenticated;

do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('spaces', 'members', 'invites', 'entries')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- spaces: members see it, the owner can rename or delete it. Created via create_space().
create policy "members read space" on public.spaces
  for select to authenticated using (public.is_member(id));
create policy "owner renames space" on public.spaces
  for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));
create policy "owner deletes space" on public.spaces
  for delete to authenticated using (public.is_owner(id));

-- members: see your fellow caregivers, rename yourself, leave, or (owner) remove someone.
-- Added via create_space() / accept_invite(). The owner can't be removed this way.
create policy "members read members" on public.members
  for select to authenticated using (public.is_member(space_id));
create policy "rename yourself" on public.members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "leave or remove caregiver" on public.members
  for delete to authenticated
  using (role <> 'owner' and (user_id = auth.uid() or public.is_owner(space_id)));

-- invites: any caregiver can make one and cancel open ones.
create policy "members read invites" on public.invites
  for select to authenticated using (public.is_member(space_id));
create policy "members create invites" on public.invites
  for insert to authenticated
  with check (public.is_member(space_id) and created_by = auth.uid());
create policy "members revoke invites" on public.invites
  for update to authenticated
  using (public.is_member(space_id)) with check (public.is_member(space_id));

-- entries: every caregiver in the space can read, add, fix and delete.
-- New entries are stamped with your account (or none, when restoring someone else's via Undo).
create policy "members read entries" on public.entries
  for select to authenticated using (public.is_member(space_id));
create policy "members add entries" on public.entries
  for insert to authenticated
  with check (public.is_member(space_id) and (created_by_user is null or created_by_user = auth.uid()));
create policy "members edit entries" on public.entries
  for update to authenticated
  using (public.is_member(space_id)) with check (public.is_member(space_id));
create policy "members delete entries" on public.entries
  for delete to authenticated using (public.is_member(space_id));

-- ---------- live updates ----------
-- Realtime "postgres_changes" respects the policies above.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'entries')
  then
    alter publication supabase_realtime add table public.entries;
  end if;
end $$;
