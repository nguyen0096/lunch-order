-- A reference gains the office it belongs to, so one bank account can serve
-- more than one of them.
--
-- The reference is `PERS_LUNCH_NGUY_39`: office, the word, person, ISO week.
-- Only the middle two decide anything. `private.payer_from_memo` strips every
-- non-alphanumeric and looks for `memberships.payment_ref` inside what is
-- left, so `PERS_LUNCH_NGUY_39` normalises to `PERSLUNCHNGUY39`, which still
-- contains `LUNCHNGUY`. Matching is unchanged and needs no migration; this
-- only gives the two decorative parts something true to say.
--
-- The office code earns its place: an admin whose SePay account also receives
-- their own money, or who runs two offices, reads it in the bank statement.
-- The week number does not decide anything at all -- money lands on a person
-- and fills their oldest unpaid week first, whatever week the memo names --
-- but it tells an admin reading a statement when the payer thought they were
-- paying for, which is the question they ask when a number looks wrong.

alter table public.organizations add column if not exists short_code text;

/**
 * Four characters from the slug, which is the office's own chosen name and
 * already unique. Not initials, unlike a member's: most office names are one
 * word, and one letter is not a code.
 */
update public.organizations o
   set short_code = upper(substring(regexp_replace(o.slug, '[^a-zA-Z0-9]', '', 'g') from 1 for 4))
 where short_code is null;

-- Two offices whose slugs share four characters would collide, and the
-- reference is read by a human off a bank statement, so the collision has to
-- be visible rather than silently shared.
create unique index if not exists organizations_short_code_uk
  on public.organizations (short_code) where short_code is not null;

create or replace function public.set_org_short_code()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.short_code is null then
    new.short_code :=
      upper(substring(regexp_replace(new.slug, '[^a-zA-Z0-9]', '', 'g') from 1 for 4));
  end if;
  return new;
end $function$;

drop trigger if exists organizations_short_code on public.organizations;
create trigger organizations_short_code
  before insert on public.organizations
  for each row execute function public.set_org_short_code();

revoke all on function public.set_org_short_code() from public, anon, authenticated;
