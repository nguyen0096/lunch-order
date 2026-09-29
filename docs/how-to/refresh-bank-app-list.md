# Refresh the bank app list

The Bill screen's **Open your bank app** button, on a phone, lists the banking
apps VietQR publishes. The list is not fetched at run time: it is a dated
snapshot in `src/shared/bankApps.snapshot.json`, so the bill renders whether or
not VietQR is up.

## What depends on VietQR, and what does not

| | Depends on VietQR |
| --- | --- |
| Drawing the bill, the QR, **Share QR** / **Download QR** | No. The QR payload is built in the browser (`src/shared/vietqr.ts`) and the image is drawn from it |
| The list in the picker | No. It is the vendored snapshot |
| Tapping **Open &lt;app&gt;** | Yes. The link is `https://dl.vietqr.io/pay?app=<appId>&ba=<account>@<bin>&am=<amount>&tn=<reference>`, and `dl.vietqr.io` answers with the app's own scheme. If it is down, the tap lands on an error page and nothing else on the bill is affected |

The tap sends the office's account number, the amount owed and the member's
reference to `dl.vietqr.io`, once, when the member asks. Nothing is sent to
VietQR while the bill merely renders.

On 2026-09-28 the redirector dropped `ba`, `am` and `tn` for every app, on both
platforms, including the five the lists mark `autofill: 1` (VietinBank iPay,
BIDV SmartBanking, OCB OMNI, ACB One, MB Bank). The app opens on its home
screen. See [Decisions](../decisions.md), under Interface.

## Refresh it

```sh
npm run gen:bank-apps
git diff src/shared/bankApps.snapshot.json
```

The script reads
[the Android list](https://api.vietqr.io/v2/android-app-deeplinks) and
[the iOS list](https://api.vietqr.io/v2/ios-app-deeplinks), keeps each app's
id, name, bank and `autofill` flag, drops the logo URLs, and stamps
`fetchedOn`. Review the diff before committing: an app that disappears is one a
member may have remembered on their phone, and the button falls back to asking
again for them.

## Check whether prefill has started working

Ask the redirector the way a phone would and read where it sends you:

```sh
curl -s -o /dev/null -D - \
  -A "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" \
  "https://dl.vietqr.io/pay?app=acb&ba=0123456789@970416&am=12345&tn=TEST" | grep -i location

curl -s -A "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" \
  "https://dl.vietqr.io/pay?app=acb&ba=0123456789@970416&am=12345&tn=TEST" | grep DEEPLINK
```

If the target carries the account, amount or memo, the copy under the button in
`src/web/components/bill/PayFromPhone.tsx` and the Bill section of
[Screens](../reference/screens.md) are the two places that say it does not.

VietQR's own page for this is
[Deeplink app ngân hàng](https://www.vietqr.io/danh-sach-api/deeplink-app-ngan-hang).
