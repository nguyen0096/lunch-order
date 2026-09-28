// Description: refreshes src/shared/bankApps.snapshot.json from VietQR's
// published deeplink lists. Run with `npm run gen:bank-apps`, review the diff,
// and commit it. The app never fetches these lists itself.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCES = {
  android: "https://api.vietqr.io/v2/android-app-deeplinks",
  ios: "https://api.vietqr.io/v2/ios-app-deeplinks",
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../src/shared/bankApps.snapshot.json");

async function list(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const { apps } = await res.json();
  if (!Array.isArray(apps) || apps.length === 0) throw new Error(`${url} returned no apps`);
  return apps.map((a) => {
    if (typeof a.appId !== "string" || !/^[a-z0-9-]+$/.test(a.appId)) {
      throw new Error(`${url}: unexpected appId ${JSON.stringify(a.appId)}`);
    }
    return {
      appId: a.appId,
      // The iOS list prefixes every App Store name with U+200E.
      appName: String(a.appName).replace(/[‎‏]/g, "").trim(),
      bankName: String(a.bankName).trim(),
      autofill: a.autofill === 1,
    };
  });
}

const snapshot = {
  fetchedOn: new Date().toISOString().slice(0, 10),
  sources: SOURCES,
  android: await list(SOURCES.android),
  ios: await list(SOURCES.ios),
};

writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`wrote ${out}: ${snapshot.android.length} Android, ${snapshot.ios.length} iOS`);
