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

const FORMAT_MARKS = /[​-‏‪-‮⁦-⁩﻿]/g;

function clean(s) {
  return String(s).replace(FORMAT_MARKS, "").normalize("NFC").trim();
}

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
      // Store names arrive wrapped in bidi and zero-width marks (U+200E on
      // every iOS name, U+202A on CAKE's), which break search and matching.
      appName: clean(a.appName),
      bankName: clean(a.bankName),
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
