-- A meal passed to somebody who leaves goes back to whoever passed it.
--
-- Leaving (or being removed) cancelled only the person's own open orders. A
-- meal somebody passed to them and they accepted stayed on their bill, eaten
-- by nobody, and an offer still waiting for them stayed pending with nobody
-- left to answer it.
--
-- The owner's rule (2026-10-05), in the same transaction as the leaving:
--
-- * An accepted pass TO the leaver, on a day still open for ordering, is
--   undone: the meal is the giver's again and on the giver's bill, as an
--   admin's `undo_pass` would leave it. If the giver has gone too (left
--   earlier, or is leaving in the same statement) the meal is cancelled
--   instead, as their own leaving would have cancelled it. The accepted pass
--   then stays as it is: a cancelled order bills nobody.
-- * A pass TO the leaver past the cutoff stays: the leaver keeps that meal
--   and its bill, as they keep their own meals past the cutoff.
-- * A pending offer TO the leaver, on a meal still placed, is declined, on
--   any day outside a settled week. Nothing moves on the bill: the meal was
--   the giver's all along.
--
-- The giver is told, as for any pass that changes their bill: a
-- `bill_correction` when the meal comes back, a `transfer_decided` when the
-- offer is declined. Neither goes to the leaver. No `order_corrections` row is
-- written: like the leaver's own cancellations, this is the system acting, and
-- the pass row says what happened (`undone_at`/`undone_by`, `decided_at`/
-- `decided_by`, and a reason when the pass carried none).
--
-- Who did it: `decided_by` and `undone_by` are whoever made the person go,
-- the leaver themselves or the admin who removed them. `undone_by` cannot be
-- null (`transfers_undone_ck`), so when the service role removes somebody it
-- names the leaver.
--
-- Concurrency. The giver's membership is not held: a pass undone onto a giver
-- who is leaving at the same moment is settled by the publish lock, which
-- every leaving takes before it reads anything (`cancel_leavers_open_orders`
-- below). Whichever leaving holds it first finishes; the second then reads the
-- first's outcome: a giver now gone gets the meal cancelled, and a giver
-- leaving after the meal came back has it cancelled with their own open
-- orders. Holding the giver's row as well would deadlock two people who
-- passed each other meals and leave at once.

-- What a leaving would do, without doing it: one row per order or pass it
-- would touch, with the leaver it is for.
--
--   cancel         an open order of the leaver's own, not passed on and accepted
--   cancel_passed  an open order passed to the leaver and accepted, whose giver
--                  has gone or is in the same set
--   return         an open order passed to the leaver and accepted, whose giver
--                  is still here: the pass is undone
--   decline        a pending offer to the leaver on a meal still placed,
--                  outside a settled week, and not itself being cancelled here.
--                  An offer left waiting on a cancelled meal is not one: nobody
--                  can accept it, and the giver can withdraw it.
--
-- Read-only and lock-free, so both the leaving (twice: before its locks to
-- find what to lock, and again under them) and the People screen's preview ask
-- the same question.
create or replace function private.leaving_effects(p_org_ids bigint[], p_profile_ids uuid[])
returns table (org_id bigint, leaver uuid, action text, order_id bigint, transfer_id bigint)
language sql stable security definer set search_path to '' as $fn$
  with gone as (
    select distinct w.org_id, w.profile_id
      from unnest(p_org_ids, p_profile_ids) as w(org_id, profile_id)
  ),
  open_order as (
    select o.id, o.org_id, o.profile_id, o.service_date
      from public.orders o
      join public.menus m on m.id = o.menu_id
     where o.status = 'placed'
       and m.status = 'published' and m.order_cutoff_at > now()
       and not exists (select 1 from public.billing_periods bp
                        where bp.org_id = o.org_id and bp.status = 'closed'
                          and o.service_date between bp.period_start and bp.period_end)
  ),
  own as (
    select g.org_id, g.profile_id as leaver, oo.id as order_id
      from gone g
      join open_order oo on oo.org_id = g.org_id and oo.profile_id = g.profile_id
     where not exists (select 1 from public.meal_transfers t
                        where t.order_id = oo.id and t.status = 'accepted')
  ),
  received as (
    select g.org_id, g.profile_id as leaver, oo.id as order_id, t.id as transfer_id,
           (exists (select 1 from gone x
                     where x.org_id = t.org_id and x.profile_id = t.from_profile_id)
            or not exists (select 1 from public.memberships ms
                            where ms.org_id = t.org_id and ms.profile_id = t.from_profile_id
                              and ms.status = 'active')) as giver_gone
      from gone g
      join public.meal_transfers t
        on t.org_id = g.org_id and t.to_profile_id = g.profile_id and t.status = 'accepted'
      join open_order oo on oo.id = t.order_id
  ),
  offered as (
    select g.org_id, g.profile_id as leaver, t.order_id, t.id as transfer_id
      from gone g
      join public.meal_transfers t
        on t.org_id = g.org_id and t.to_profile_id = g.profile_id and t.status = 'pending'
      join public.orders o on o.id = t.order_id
     where o.status = 'placed'
       and not exists (select 1 from public.billing_periods bp
                        where bp.org_id = o.org_id and bp.status = 'closed'
                          and o.service_date between bp.period_start and bp.period_end)
       -- An offer on a meal cancelled here is withdrawn with it instead.
       and not exists (select 1 from own where own.order_id = t.order_id)
  )
  select own.org_id, own.leaver, 'cancel', own.order_id, null::bigint from own
  union all
  select r.org_id, r.leaver, case when r.giver_gone then 'cancel_passed' else 'return' end,
         r.order_id, r.transfer_id
    from received r
  union all
  select f.org_id, f.leaver, 'decline', f.order_id, f.transfer_id from offered f;
$fn$;

revoke execute on function private.leaving_effects(bigint[], uuid[]) from public, anon, authenticated;

-- What the giver reads when a leaving changes their pass, from where they
-- stand. `returned`: the meal is theirs again; `declined`: their offer was.
create or replace function private.leaver_pass_body(p_transfer_id bigint, p_event text)
returns text
language sql stable set search_path to '' as $fn$
  select private.member_name(t.org_id, t.to_profile_id)
      || case when ms.removed_at is null then ' left the office'
              else ' was removed from the office' end
      || case p_event
           when 'returned' then
             ', so your lunch on ' || to_char(o.service_date, 'DD/MM')
             || ' (' || private.meal_phrase(o.id) || ') is yours again and back on your bill.'
             || ' Cancel it before ' || to_char(m.order_cutoff_at at time zone org.timezone, 'HH24:MI DD/MM')
             || ' if you will not eat it.'
             || E'\n' || private.balance_line(t.org_id, t.from_profile_id)
           else
             ', so your offer of lunch on ' || to_char(o.service_date, 'DD/MM')
             || ' was declined. It is still yours and still on your bill.'
         end
    from public.meal_transfers t
    join public.orders o on o.id = t.order_id
    join public.menus m on m.id = o.menu_id
    join public.organizations org on org.id = t.org_id
    join public.memberships ms on ms.org_id = t.org_id and ms.profile_id = t.to_profile_id
   where t.id = p_transfer_id;
$fn$;

revoke execute on function private.leaver_pass_body(bigint, text) from public, anon, authenticated;

create or replace function private.cancel_leavers_open_orders(
  p_org_ids bigint[], p_profile_ids uuid[])
returns integer
language plpgsql security definer set search_path to '' as $fn$
declare
  v_orders  bigint[];
  v_passes  bigint[];
  v_own     bigint[];
  v_cancel  bigint[];
  v_return  bigint[];
  v_decline bigint[];
  v_billed  bigint[];
  v_periods bigint[];
  v_n       integer;
  r         record;
begin
  -- The publish lock first, so a publish in flight finishes (and its standing
  -- orders become visible here) or waits until the membership is inactive. It
  -- also puts two leavings in one office one after the other, which is what
  -- decides a pass between two people leaving at once (see the header).
  for r in select distinct w.org_id from unnest(p_org_ids) as w(org_id) order by 1 loop
    perform private.lock_office_materialize(r.org_id);
  end loop;

  select array_agg(distinct e.order_id),
         array_agg(distinct e.transfer_id) filter (where e.transfer_id is not null)
    into v_orders, v_passes
    from private.leaving_effects(p_org_ids, p_profile_ids) e;
  if v_orders is null then return 0; end if;
  v_passes := coalesce(v_passes, '{}');

  perform 1 from public.menus m
   where m.id in (select o.menu_id from public.orders o where o.id = any (v_orders))
     and m.status = 'published' and m.order_cutoff_at > now()
   order by m.org_id, m.service_date, m.id
     for share;

  perform 1 from public.meal_transfers t
   where (t.order_id = any (v_orders) and t.status = 'pending')
      or t.id = any (v_passes)
   order by t.id
     for no key update;

  for r in
    select distinct o.org_id, o.service_date from public.orders o
     where o.id = any (v_orders) order by 1, 2
  loop
    perform private.lock_office_week(r.org_id, r.service_date);
  end loop;

  for r in
    select distinct bp.id, bp.org_id, bp.period_start
      from public.billing_periods bp
      join public.orders o
        on o.org_id = bp.org_id and o.service_date between bp.period_start and bp.period_end
     where o.id = any (v_orders) and bp.status <> 'void'
     order by bp.org_id, bp.period_start
  loop
    perform pg_advisory_xact_lock(hashtext('lunch.run_billing'), r.id::int);
  end loop;

  perform 1 from public.orders o where o.id = any (v_orders) order by o.id for no key update;

  -- Read again under the locks, and act only on what was found and locked
  -- before. The guards exempt this function, so `leaving_effects` keeps out
  -- of a settled week itself.
  select array_agg(e.order_id order by e.order_id) filter (where e.action = 'cancel'),
         array_agg(e.order_id order by e.order_id) filter (where e.action in ('cancel', 'cancel_passed')),
         array_agg(e.transfer_id order by e.transfer_id) filter (where e.action = 'return'),
         array_agg(e.transfer_id order by e.transfer_id) filter (where e.action = 'decline'),
         array_agg(e.order_id order by e.order_id) filter (where e.action <> 'decline'),
         count(distinct (e.leaver, o.service_date)) filter (where e.action <> 'decline')
    into v_own, v_cancel, v_return, v_decline, v_billed, v_n
    from private.leaving_effects(p_org_ids, p_profile_ids) e
    join public.orders o on o.id = e.order_id
   where e.order_id = any (v_orders)
     and (e.transfer_id is null or e.transfer_id = any (v_passes));

  perform private.withdraw_pending_pass(o.id,
            case when ms.removed_at is null
                 then 'withdrawn: the meal was cancelled when its owner left the office'
                 else 'withdrawn: the meal was cancelled when its owner was removed from the office'
            end)
     from public.orders o
     join public.memberships ms on ms.org_id = o.org_id and ms.profile_id = o.profile_id
    where o.id = any (coalesce(v_own, '{}'))
      and exists (select 1 from public.meal_transfers t
                   where t.order_id = o.id and t.status = 'pending');

  -- Each week is re-billed once, below, and the giver is told below in this
  -- function's words rather than the member-style message.
  perform set_config('lunch.pass_withdrawn_with_meal', 'on', true);
  perform set_config('lunch.pass_by_admin', 'on', true);

  update public.meal_transfers t
     set status = 'declined', decided_at = now(), decided_by = (select auth.uid()),
         reason = coalesce(t.reason,
                    case when ms.removed_at is null
                         then 'declined: the person it was offered to left the office'
                         else 'declined: the person it was offered to was removed from the office'
                    end)
    from public.memberships ms
   where t.id = any (coalesce(v_decline, '{}')) and t.status = 'pending'
     and ms.org_id = t.org_id and ms.profile_id = t.to_profile_id;

  update public.meal_transfers t
     set status = 'undone', undone_at = now(),
         undone_by = coalesce((select auth.uid()), t.to_profile_id),
         reason = coalesce(t.reason,
                    case when ms.removed_at is null
                         then 'undone: the person it was passed to left the office'
                         else 'undone: the person it was passed to was removed from the office'
                    end)
    from public.memberships ms
   where t.id = any (coalesce(v_return, '{}')) and t.status = 'accepted'
     and ms.org_id = t.org_id and ms.profile_id = t.to_profile_id;

  perform set_config('lunch.pass_by_admin', '', true);
  perform set_config('lunch.pass_withdrawn_with_meal', '', true);

  update public.orders o
     set status = 'cancelled', cancelled_at = now()
   where o.id = any (coalesce(v_cancel, '{}'));

  select array_agg(x.id order by x.org_id, x.period_start) into v_periods
    from (select distinct bp.id, bp.org_id, bp.period_start
            from public.billing_periods bp
            join public.orders o
              on o.org_id = bp.org_id and o.service_date between bp.period_start and bp.period_end
           where o.id = any (coalesce(v_billed, '{}')) and bp.status not in ('closed', 'void')) x;

  for r in select p.id from unnest(coalesce(v_periods, '{}'::bigint[])) with ordinality as p(id, n)
            order by p.n loop
    perform public.run_billing(r.id);
  end loop;

  -- After the re-bill, so the balance line is the one the giver now has. Only
  -- a giver still here with Telegram linked; a declined offer on a meal that is
  -- no longer placed says nothing, as a member's own answer would not.
  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode,
     related_billing_period_id)
  select t.org_id,
         case when t.status = 'undone'
              then 'org:' || t.org_id || ':bill_correction:transfer:' || t.id || ':returned:profile:'
                   || t.from_profile_id::text
              else 'org:' || t.org_id || ':transfer_decided:' || t.id || ':declined'
         end,
         case when t.status = 'undone' then 'bill_correction' else 'transfer_decided' end,
         tl.chat_id,
         t.from_profile_id,
         private.leaver_pass_body(t.id, case when t.status = 'undone' then 'returned' else 'declined' end),
         'none',
         (select bp.id from public.billing_periods bp
           where bp.org_id = o.org_id and o.service_date between bp.period_start and bp.period_end
             and bp.status <> 'void')
    from public.meal_transfers t
    join public.orders o on o.id = t.order_id
    join public.memberships mem
      on mem.org_id = t.org_id and mem.profile_id = t.from_profile_id and mem.status = 'active'
    join public.telegram_links tl on tl.membership_id = mem.id and tl.chat_id is not null
   where (t.id = any (coalesce(v_return, '{}')) and t.status = 'undone')
      or (t.id = any (coalesce(v_decline, '{}')) and t.status = 'declined' and o.status = 'placed')
  on conflict (dedupe_key) do nothing;

  return coalesce(v_n, 0);
end $fn$;

revoke execute on function private.cancel_leavers_open_orders(bigint[], uuid[])
  from public, anon, authenticated;
