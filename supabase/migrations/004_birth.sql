-- Baby's birth date (and optional time), so the app can show how old she is.
-- Every caregiver of the log can set it. Safe to run more than once.

alter table public.spaces add column if not exists birth_date date;
alter table public.spaces add column if not exists birth_time time;

create or replace function public.set_birth(space uuid, birth_date date, birth_time time) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(space) then raise exception 'Not a caregiver of this log'; end if;
  if birth_date is not null and (birth_date > current_date + 1 or birth_date < date '1990-01-01') then
    raise exception 'Invalid birth date';
  end if;
  update spaces s set birth_date = set_birth.birth_date,
                      birth_time = case when set_birth.birth_date is null then null else set_birth.birth_time end
  where s.id = space;
end $$;

revoke all on function public.set_birth(uuid, date, time) from public;
grant execute on function public.set_birth(uuid, date, time) to authenticated;
