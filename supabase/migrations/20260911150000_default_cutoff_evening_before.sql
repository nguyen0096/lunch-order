-- Ordering closes the evening before, not the same afternoon.
--
-- The cutoff instant is still stored per menu; this is only the default the
-- editor starts from. 21:00 the previous day means the admin can send the
-- caterer a headcount first thing, and nobody has to remember to edit two
-- fields for every menu.
alter table public.organizations
  alter column default_cutoff_local_time set default '21:00';

-- Existing orgs were created under the old default.
update public.organizations
   set default_cutoff_local_time = '21:00'
 where default_cutoff_local_time = '16:00';
