-- Weight: an entry of type 'weight' (kind 'weight') each time the baby is weighed, in whole grams.
-- Safe to run more than once; adds one nullable column and widens the allowed values of type and kind.

alter table public.entries
  add column if not exists weight_g integer check (weight_g is null or weight_g between 300 and 30000);

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
  check (type in ('feed', 'diaper', 'vitamin', 'weight'));

alter table public.entries add constraint entries_kind_check check (
  (type = 'feed'    and kind in ('session', 'left', 'right', 'bottle')) or
  (type = 'diaper'  and kind in ('wet', 'dirty', 'both')) or
  (type = 'vitamin' and kind in ('k', 'd')) or
  (type = 'weight'  and kind = 'weight')
);

-- Caregivers may correct a weighing afterwards.
grant update (weight_g) on public.entries to authenticated;
