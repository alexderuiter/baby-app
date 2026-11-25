-- Daily vitamin K and D drops: one entry per day it was given (type 'vitamin', kind 'k' or 'd').
-- Safe to run more than once; only widens the allowed values of type and kind.

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.entries'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) like '%kind%' or pg_get_constraintdef(oid) like '%''diaper''%')
  loop
    execute format('alter table public.entries drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.entries add constraint entries_type_check
  check (type in ('feed', 'diaper', 'vitamin'));

alter table public.entries add constraint entries_kind_check check (
  (type = 'feed'    and kind in ('session', 'left', 'right', 'bottle')) or
  (type = 'diaper'  and kind in ('wet', 'dirty', 'both')) or
  (type = 'vitamin' and kind in ('k', 'd'))
);
