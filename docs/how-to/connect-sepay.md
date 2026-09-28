# Connect SePay so bank transfers record themselves

Do this once per office, after [setting up where the money goes](set-up-payment.md).
When it is done, a transfer into the office's account appears on **Payments**
within seconds and credits the person whose reference is in the memo, with no
admin typing anything.

Everything here is by hand. The endpoint, `supabase/functions/sepay`, already
exists and CI deploys it; what it cannot do for itself is own a SePay account,
know the office's bank, or hold a key you have not given it.

SePay's dashboard is in Vietnamese, so its labels are quoted as they appear.

## Before you start

- `payment_config.vietqr.accountNumber` is set for the office. The webhook finds
  the office by that number, so it has to be the exact account SePay will watch.
- You can run SQL on the project (dashboard SQL editor, as `postgres`).
- Every member who pays has a reference (`LUNCH` plus their short code). The
  Bill screen shows it.

## 1. Create a SePay account

Register at <https://my.sepay.vn> ([how](https://docs.sepay.vn/dang-ky-sepay.html)).
Plans differ only in how many incoming transactions they count per month, not
in features ([plans](https://docs.sepay.vn/goi-dich-vu.html)), so webhooks work
on the free one.

## 2. Link the bank account

**Ngân hàng** → **+ Kết nối tài khoản**
([docs](https://docs.sepay.vn/them-tai-khoan-ngan-hang.html)).

- **API Banking** if the bank is on SePay's list (Vietcombank, BIDV, VPBank,
  TPBank, ACB, VietinBank, MB, OCB, KienLongBank, MSB, Sacombank). Notifications
  are near instant.
- **SMS Báo số dư** otherwise. SePay gives you a phone number to register with
  the bank as a *balance notification* number only, never for OTP.

Send yourself 1,000 VND and confirm it shows under **Giao dịch**. Nothing past
this point works until SePay sees transactions.

## 3. Filter what SePay syncs

Turn off money-out sync and set the keyword filter to `LUNCH`. The steps and the
reasons are in [Lọc giao dịch SePay theo từ khóa](loc-giao-dich-sepay.md); do not
skip it if the account is also somebody's personal account.

## 4. Confirm the endpoint is live

```bash
npx supabase functions list --project-ref wvtbstticnactealupph
```

`sepay` must be listed with `verify_jwt` **false**. SePay holds no Supabase key,
so with the platform's JWT gate on, every delivery is rejected before the
function runs. The setting lives in `supabase/config.toml`; if it is wrong,
redeploy as [Deploy the Edge Functions](deploy-edge-functions.md) describes
rather than passing a flag.

The URL SePay will call:

```text
https://wvtbstticnactealupph.supabase.co/functions/v1/sepay
```

## 5. Give the office its webhook key

The key is **not** a Supabase secret and `supabase secrets set` is not involved.
It belongs to the office and lives in `public.org_webhook_secrets`, because the
endpoint routes by account number and one shared key would let any office post
payments into any other. An office with no row there refuses every delivery.

Generate it:

```bash
openssl rand -hex 32
```

The table requires at least 32 characters. Store it, replacing any earlier one:

```sql
insert into public.org_webhook_secrets (org_id, secret)
select id, '<the key>' from public.organizations where slug = '<office slug>'
on conflict (org_id) do update set secret = excluded.secret;
```

Check exactly one row was affected. The SQL editor keeps query history, so clear
the key out of that snippet afterwards. Keep the key somewhere safe until step
6; SePay shows it in full only once.

## 6. Create the webhook in SePay

**WebHooks** → **+ Thêm webhook** at <https://my.sepay.vn/webhooks>
([docs](https://docs.sepay.vn/tich-hop-webhooks.html),
[field reference](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook)).

| Field | Set to | Why |
| --- | --- | --- |
| Event | **Có tiền vào** | The handler ignores anything not `transferType: "in"`. |
| Bank account | the account from step 2 | Its number is the routing key. |
| **Bỏ qua nếu nội dung giao dịch không có Code thanh toán** | off | It depends on SePay's own payment-code structure, which is not configured for `LUNCH`. The keyword filter from step 3 already does this job, and does it earlier. |
| URL (**Gọi đến URL**) | the URL from step 4 | |
| **Kiểu chứng thực** | **API Key**, value = the key from step 5 | The only scheme the handler checks. HMAC-SHA256 and OAuth 2.0 are rejected as unauthorized. |
| **Request Content type** | `application/json` | The handler parses JSON only; anything else is a 400. |
| **Gọi lại WebHooks khi** | on non-2xx status | Only a failure of ours answers non-2xx, and that is the case worth retrying. |

SePay then sends `Authorization: Apikey <key>`
([auth docs](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc)). The handler
accepts that with or without a `Bearer` prefix.

## 7. Verify

Work up from what writes nothing to what writes money. Rows in `payments` are
permanent, so do not invent a test payment that matches a real person.

**The office resolves.** No key, a real account number:

```bash
curl -s -X POST https://wvtbstticnactealupph.supabase.co/functions/v1/sepay \
  -H 'Content-Type: application/json' \
  -d '{"id":1,"accountNumber":"<office account>","transferType":"in","transferAmount":1000,"content":"test"}'
```

Expect HTTP 401 and `"result":"unauthorized"`. A 200 with
`"reason":"unknown_account"` means the number does not match `payment_config`.

**The key matches.** Same body, with the key, and a memo without `LUNCH`:

```bash
curl -s -X POST https://wvtbstticnactealupph.supabase.co/functions/v1/sepay \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Apikey <the key>' \
  -d '{"id":1,"accountNumber":"<office account>","transferType":"in","transferAmount":1000,"content":"test"}'
```

Expect 200, `"success":true`, `"reason":"no_lunch_reference"`. Nothing is
written. SePay's own **Gửi thử** button sends a sample account number, so it
usually answers `unknown_account`; that proves reachability, not the key.

**A real transfer.** Pay 2,000 VND into the office account with your own
reference from the Bill screen as the memo. Then:

1. It appears under **Giao dịch** in SePay.
2. **Nhật ký webhooks** (<https://my.sepay.vn/webhookslog>) shows a 200 with
   `"result":"recorded"` and `"matched":true`.
3. In the app, **Payments** shows it against your name and your balance moves.

```sql
select id, provider_txn_id, amount_minor, memo, profile_id, matched_statement_id
  from public.payments where provider = 'sepay' order by id desc limit 5;
```

## When a transfer does not arrive

Start from SePay's webhook log: the response body names the case. Function logs
are in the dashboard under **Edge Functions** → `sepay` → **Logs**.

| What the log shows | Cause | Fix |
| --- | --- | --- |
| No delivery at all | SePay never synced the transaction: memo lacks `LUNCH` and the keyword filter dropped it, or SMS banking has not reported it yet | Check **Giao dịch**; an unsynced payment is recorded by hand |
| 404 `Requested function was not found` | function not deployed | step 4 |
| 401 with a platform message about a JWT or authorization header | `verify_jwt` is on | step 4 |
| 401 `"result":"unauthorized"` | no row in `org_webhook_secrets`, a different key in SePay, or an auth type other than API Key | steps 5 and 6 |
| 400 `body is not JSON` | Request Content type is not JSON | step 6 |
| 400 `no integer id` | SePay changed the payload | read `raw` shape, report it |
| 200 `unknown_account` | SePay's `accountNumber` differs from `payment_config` (spaces or a different account) | fix it in Settings |
| 200 `ambiguous_account` | two offices hold the same account number | only one office may own an account |
| 200 `not_incoming` | the webhook also fires on money out | step 6, event |
| 200 `no_lunch_reference` | memo has no `LUNCH` | expected for anything not a lunch payment |
| 200 `recorded`, `"matched":false` | memo carries `LUNCH` but no member's reference | an admin assigns it under **Payments** → *Money that matched nobody* |
| 200 `duplicate` | a redelivery of something already recorded | nothing; it was credited once |
| 500 `failed` | the database refused or was unreachable | function logs; SePay retries by itself |

SePay retries a failed delivery up to 7 times over at most 5 hours, and also
lets you resend from the log. A redelivery can never credit twice: the insert is
keyed on SePay's `id`.

## Rotating the key

Repeat step 5 with a new key, then paste it into the webhook in SePay. Between
the two, deliveries answer 401 and SePay retries them, so do both within a few
minutes.

## Related

- [Set up where the money goes](set-up-payment.md)
- [Lọc giao dịch SePay theo từ khóa](loc-giao-dich-sepay.md)
- [Deploy the Edge Functions](deploy-edge-functions.md)
- [Backlog: SePay](../backlog.md#sepay-prove-a-payment-arrived), for Bank Hub and why each office does this itself today
