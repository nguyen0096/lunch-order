-- An office is founded one way, and a bank account belongs to one office.
--
-- `organizations_insert` was `with check (true)` and `authenticated` held
-- INSERT on the table, so anybody holding a JWT (an anonymous Telegram sign-in
-- included) could POST a row straight into /rest/v1/organizations. That skipped
-- everything `create_organization` stands for: the `office_creation` switch,
-- and the owner membership written in the same transaction. Worse, it could
-- carry `payment_config`, and the SePay webhook routes a delivery by the
-- account number in there. A row naming somebody else's account made that
-- account ambiguous, the webhook answered `ambiguous_account` with a 200, and
-- every real transfer into the victim's office was thrown away without a retry.
--
-- So: no direct insert at all, and one live office per account number.
--
-- The number is compared with every whitespace character removed, not
-- btrim'd: "0123 456 789" and "0123456789" are one account to a bank, and the
-- web form already strips spaces (normalizeAccountNumber in src/shared/banks.ts).
-- A deleted office gives its account up, so an owner who deleted an office by
-- mistake and founded a new one is not locked out of their own bank account.

------------------------------------------------------------ no direct insert

drop policy if exists organizations_insert on public.organizations;
revoke insert on public.organizations from anon, authenticated;

------------------------------------------------------------- one per account

create or replace function private.account_number(p_config jsonb)
returns text
language sql
immutable
set search_path to ''
as $fn$
  select nullif(regexp_replace(coalesce(p_config #>> '{vietqr,accountNumber}', ''),
                               '\s', '', 'g'), '');
$fn$;

-- EXECUTE for authenticated is load-bearing: the unique index below is on this
-- expression, and an index expression is evaluated with the privileges of
-- whoever writes the row, so an owner saving the payment account would
-- otherwise get "permission denied for function account_number".
revoke execute on function private.account_number(jsonb) from public, anon;
grant  execute on function private.account_number(jsonb) to authenticated;

-- Refuses rather than picking one: which office was right is a question for a
-- person, and this migration must not quietly break either office's webhook.
do $$
declare v_dupes text;
begin
  select string_agg(format('%s (offices %s)', acct, ids), '; ')
    into v_dupes
    from (select private.account_number(o.payment_config) as acct,
                 string_agg(o.id::text, ', ' order by o.id) as ids
            from public.organizations o
           where o.deleted_at is null
             and private.account_number(o.payment_config) is not null
           group by 1
          having count(*) > 1) d;
  if v_dupes is not null then
    raise exception 'more than one live office banks with the same account: %. '
                    'Give all but one of them a different account, then re-run.', v_dupes;
  end if;
end $$;

create unique index if not exists organizations_account_number_uk
  on public.organizations (private.account_number(payment_config))
  where deleted_at is null and private.account_number(payment_config) is not null;

-- The index is the guarantee; this is the sentence. A unique violation reaches
-- the owner as "that change conflicts with something else", which does not say
-- which thing, and the account number is the one they just typed.
create or replace function public.normalize_payment_account()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_acct text;
begin
  if new.payment_config #>> '{vietqr,accountNumber}' is not null then
    v_acct := coalesce(private.account_number(new.payment_config), '');
    if v_acct !~ '^[0-9A-Za-z]{4,19}$' then
      raise exception 'that account number is not one a bank would accept: 4 to 19 letters or digits'
        using errcode = 'check_violation';
    end if;
    new.payment_config := jsonb_set(new.payment_config, '{vietqr,accountNumber}', to_jsonb(v_acct));
  end if;

  v_acct := private.account_number(new.payment_config);
  if v_acct is not null and new.deleted_at is null
     and exists (select 1 from public.organizations o
                  where o.id <> new.id and o.deleted_at is null
                    and private.account_number(o.payment_config) = v_acct) then
    raise exception 'another office already receives its lunch payments into account %. One bank account can serve one office.',
      v_acct using errcode = 'unique_violation';
  end if;
  return new;
end $fn$;

revoke execute on function public.normalize_payment_account() from public, anon, authenticated;

drop trigger if exists organizations_payment_account on public.organizations;
create trigger organizations_payment_account
  before insert or update of payment_config, deleted_at on public.organizations
  for each row execute function public.normalize_payment_account();
