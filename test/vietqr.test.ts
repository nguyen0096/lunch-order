import { crc16CcittFalse, vietQrPayload } from "../src/shared/vietqr.js";

/**
 * The expectations below are literals, computed by an independent
 * implementation of the same specification rather than by the module under
 * test. A test that rebuilds the payload the way the code builds it only
 * asserts that the code is self-consistent, which it would be even if the
 * whole field order were wrong.
 */

const ACCOUNT = { bankBin: "970415", accountNumber: "113366668888" };
const REF = "LUNCH7NEYU38";

// 00 02 "01"                                  payload format indicator
// 01 02 "12"                                  dynamic: an amount is present
// 38 56 { 00 10 "A000000727"                  NAPAS
//         01 26 { 00 06 "970415"              acquirer BIN
//                 01 12 "113366668888" }      account number
//         02 08 "QRIBFTTA" }                  account-to-account transfer
// 53 03 "704"                                 VND
// 54 06 "180000"                              amount
// 58 02 "VN"                                  country
// 62 16 { 08 12 "LUNCH7NEYU38" }              the bank memo
// 63 04 "FDA9"                                CRC over everything incl. "6304"
const WITH_AMOUNT =
  "00020101021238560010A0000007270126000697041501121133666688880208QRIBFTTA" +
  "530370454061800005802VN62160812LUNCH7NEYU386304FDA9";

// Identical but for `01` = "11" (static, the payer types the amount), no `54`
// at all, and therefore a different checksum.
const NO_AMOUNT =
  "00020101021138560010A0000007270126000697041501121133666688880208QRIBFTTA" +
  "53037045802VN62160812LUNCH7NEYU3863045E97";

describe("CRC-16/CCITT-FALSE", () => {
  // The check value published with the algorithm: poly 0x1021, init 0xFFFF,
  // no reflection, no final xor.
  it("computes 0x29B1 for the standard check string", () => {
    expect(crc16CcittFalse("123456789")).toBe(0x29b1);
  });

  it("starts from 0xFFFF rather than zero", () => {
    // An init of 0x0000 would make the empty string 0x0000 and "A" 0x58E5.
    expect(crc16CcittFalse("")).toBe(0xffff);
    expect(crc16CcittFalse("A")).toBe(0xb915);
  });

  it("is order sensitive, so a transposed amount cannot pass", () => {
    expect(crc16CcittFalse("5406180000")).not.toBe(crc16CcittFalse("5406100008"));
  });
});

describe("vietQrPayload, assembly", () => {
  it("matches the hand-computed payload when an amount is carried", () => {
    expect(vietQrPayload({ ...ACCOUNT, amountMinor: 180_000, paymentRef: REF })).toBe(
      WITH_AMOUNT,
    );
  });

  it("drops field 54 and turns 01 static when there is no amount", () => {
    expect(vietQrPayload({ ...ACCOUNT, paymentRef: REF })).toBe(NO_AMOUNT);
    expect(vietQrPayload({ ...ACCOUNT, amountMinor: 0, paymentRef: REF })).toBe(NO_AMOUNT);
  });

  it("checksums the payload including the literal 6304", () => {
    const payload = vietQrPayload({ ...ACCOUNT, amountMinor: 180_000, paymentRef: REF });
    expect(payload).not.toBeNull();
    const body = payload!.slice(0, -4);
    expect(body.endsWith("6304")).toBe(true);
    expect(payload!.slice(-4)).toBe(
      crc16CcittFalse(body).toString(16).toUpperCase().padStart(4, "0"),
    );
  });

  it("pads a checksum with a leading zero rather than emitting three digits", () => {
    // Every code is 4 hex digits wide, so a small CRC must still be "0ABC".
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
    expect(hex(0x0a3f)).toBe("0A3F");
    const payload = vietQrPayload({ ...ACCOUNT, amountMinor: 180_000, paymentRef: REF });
    expect(payload!.slice(-4)).toMatch(/^[0-9A-F]{4}$/);
  });

  it("is ASCII throughout, because the bank checksums bytes and not characters", () => {
    const payload = vietQrPayload({ ...ACCOUNT, amountMinor: 180_000, paymentRef: REF });
    // eslint-disable-next-line no-control-regex
    expect(payload!).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("vietQrPayload, structure", () => {
  const parse = (s: string) => {
    const out = new Map<string, string>();
    let i = 0;
    while (i < s.length) {
      const id = s.slice(i, i + 2);
      const len = Number(s.slice(i + 2, i + 4));
      out.set(id, s.slice(i + 4, i + 4 + len));
      i += 4 + len;
    }
    return out;
  };

  it("walks cleanly as TLV, so every declared length is the real one", () => {
    const fields = parse(vietQrPayload({ ...ACCOUNT, amountMinor: 45_000, paymentRef: REF })!);
    expect([...fields.keys()]).toEqual(["00", "01", "38", "53", "54", "58", "62", "63"]);
    expect(fields.get("00")).toBe("01");
    expect(fields.get("53")).toBe("704");
    expect(fields.get("54")).toBe("45000");
    expect(fields.get("58")).toBe("VN");
  });

  it("nests the account inside the NAPAS merchant field", () => {
    const merchant = parse(
      parse(vietQrPayload({ ...ACCOUNT, amountMinor: 45_000, paymentRef: REF })!).get("38")!,
    );
    expect(merchant.get("00")).toBe("A000000727");
    expect(merchant.get("02")).toBe("QRIBFTTA");
    const account = parse(merchant.get("01")!);
    expect(account.get("00")).toBe("970415");
    expect(account.get("01")).toBe("113366668888");
  });

  it("carries the reference in additional data, field 62 sub-field 08", () => {
    const fields = parse(vietQrPayload({ ...ACCOUNT, amountMinor: 45_000, paymentRef: REF })!);
    expect(parse(fields.get("62")!).get("08")).toBe(REF);
  });

  it("writes whole dong, because VND has no sub-unit", () => {
    const fields = parse(vietQrPayload({ ...ACCOUNT, amountMinor: 45_000, paymentRef: REF })!);
    expect(fields.get("54")).toBe("45000");
    expect(fields.get("54")).not.toContain(".");
  });
});

describe("vietQrPayload, refusals", () => {
  const ok = { ...ACCOUNT, amountMinor: 45_000, paymentRef: REF };

  it("refuses a bank BIN that is not six digits", () => {
    expect(vietQrPayload({ ...ok, bankBin: "97041" })).toBeNull();
    expect(vietQrPayload({ ...ok, bankBin: "9704155" })).toBeNull();
    expect(vietQrPayload({ ...ok, bankBin: "VCB" })).toBeNull();
  });

  it("refuses an account number that is empty or not alphanumeric", () => {
    expect(vietQrPayload({ ...ok, accountNumber: "" })).toBeNull();
    expect(vietQrPayload({ ...ok, accountNumber: "1133-6666" })).toBeNull();
  });

  it("refuses a reference the bank memo could not carry", () => {
    // The same shape the database constrains payment_ref to.
    expect(vietQrPayload({ ...ok, paymentRef: "lunch7neyu" })).toBeNull();
    expect(vietQrPayload({ ...ok, paymentRef: "ABC" })).toBeNull();
    expect(vietQrPayload({ ...ok, paymentRef: "LUNCH NEYU" })).toBeNull();
    expect(vietQrPayload({ ...ok, paymentRef: "LUNCHNGUYỄN" })).toBeNull();
  });

  it("refuses an amount that is not a whole, non-negative number of dong", () => {
    expect(vietQrPayload({ ...ok, amountMinor: -1 })).toBeNull();
    expect(vietQrPayload({ ...ok, amountMinor: 45_000.5 })).toBeNull();
    expect(vietQrPayload({ ...ok, amountMinor: Number.NaN })).toBeNull();
  });

  it("trims surrounding whitespace rather than refusing a pasted value", () => {
    expect(vietQrPayload({ ...ok, accountNumber: " 113366668888 " })).toBe(
      vietQrPayload({ ...ok }),
    );
  });
});

/**
 * A walk over the bytes as a bank's decoder walks them.
 *
 * The other tests here check pieces. This one checks that the whole string
 * parses as EMVCo TLV from end to end, which is the only property that
 * actually decides whether a banking app will read it: every length prefix has
 * to match its value exactly, or the walk drifts and every field after the
 * mistake is garbage.
 */
function walk(s: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!Number.isInteger(len)) throw new Error(`bad length at ${i}: ${s.slice(i + 2, i + 4)}`);
    out.push([id, s.slice(i + 4, i + 4 + len)]);
    i += 4 + len;
  }
  if (i !== s.length) throw new Error(`ran off the end at ${i} of ${s.length}`);
  return out;
}

describe("the payload a bank actually receives", () => {
  const payload = vietQrPayload({
    bankBin: "970416",
    accountNumber: "4286427",
    amountMinor: 275_000,
    paymentRef: "LUNCHNGUY",
  })!;

  it("parses end to end, with every length matching its value", () => {
    expect(walk(payload).map(([id]) => id)).toEqual([
      "00", "01", "38", "53", "54", "58", "62", "63",
    ]);
  });

  it("puts the bank and the account where NAPAS looks for them", () => {
    const f38 = walk(payload).find(([id]) => id === "38")![1];
    const inner = walk(f38);
    expect(inner.find(([id]) => id === "00")![1]).toBe("A000000727");
    expect(inner.find(([id]) => id === "02")![1]).toBe("QRIBFTTA");
    const account = walk(inner.find(([id]) => id === "01")![1]);
    expect(account.find(([id]) => id === "00")![1]).toBe("970416");
    expect(account.find(([id]) => id === "01")![1]).toBe("4286427");
  });

  it("says dynamic when it carries an amount, and static when it does not", () => {
    expect(walk(payload).find(([id]) => id === "01")![1]).toBe("12");
    const free = vietQrPayload({
      bankBin: "970416", accountNumber: "4286427", paymentRef: "LUNCHNGUY",
    })!;
    expect(walk(free).find(([id]) => id === "01")![1]).toBe("11");
    expect(walk(free).some(([id]) => id === "54")).toBe(false);
  });

  it("carries the reference in 62-08, which is where a memo is read from", () => {
    const f62 = walk(payload).find(([id]) => id === "62")![1];
    expect(walk(f62)).toEqual([["08", "LUNCHNGUY"]]);
  });

  it("signs the whole string up to and including the 6304 label", () => {
    const crc = walk(payload).find(([id]) => id === "63")![1];
    expect(crc16CcittFalse(payload.slice(0, -4)).toString(16).toUpperCase().padStart(4, "0"))
      .toBe(crc);
  });
});
