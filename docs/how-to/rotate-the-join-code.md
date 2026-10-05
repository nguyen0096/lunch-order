# Rotate the Telegram join code

Do this when the code has reached somebody outside the office, or when someone
who should not be in the org appears in the member list.

Rotating stops the old code working immediately. **People who already joined keep
their access**, because their membership no longer depends on the code. Removing
somebody is a separate action, below.

## From the app

People → Join code → **Rotate**. Confirm. The new code and its QR replace the old
one on the same screen, ready to share.

## From SQL

```sql
update public.organizations
   set telegram_join_code = 'NEWCODE'
 where slug = 'test-office';
```

The code must match `^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6,12}$`. That alphabet
excludes `I`, `O`, `0` and `1` on purpose, because people retype these from a
group chat and those four are the pairs they get wrong. It must also be unique
across every org.

## Removing somebody who got in

Rotating does not remove them. Remove the membership:

```sql
update public.memberships
   set status = 'inactive'
 where org_id = (select id from public.organizations where slug = 'test-office')
   and profile_id = '<their profile id>';
```

Or use **Remove** on the People screen, which is the same thing. Either way the
`memberships_removal` trigger stamps `removed_at`, so the old or the new join
code will not bring them back.

`private.my_org_ids()` filters on `status = 'active'`, so this takes effect on
their next request: every policy stops matching and they see nothing. In the
same transaction their lunch on every day still open for ordering is cancelled
and taken off the bill. Days past their cutoff and past orders stay on the
bill, which is deliberate: the caterer has the count, or they ate the food.

## Afterwards

Share the new code where the old one lived, and check the People screen's recent
joins over the next few days. A leaked code is not prevented, it is **noticed**,
and an unfamiliar name appearing is the signal.

## Related

- [Join codes](../explanation/join-codes.md) for why the code works this way
