import { composePaymentRef, displayPaymentRef } from "../src/shared/paymentRef.js";
import { foldMemo } from "../src/shared/sepay.js";
import { vietQrPayload } from "../src/shared/vietqr.js";

/**
 * The reference is composed for display and matched on something smaller.
 *
 * Every test here is ultimately about one invariant: whatever a member is
 * shown, `private.payer_from_memo` must still find `memberships.payment_ref`
 * inside it after folding the memo to letters and digits. That is the whole
 * reason the composition is safe to do in the UI alone, so it is asserted
 * rather than asserted in a comment.
 */

describe("composePaymentRef", () => {
  it("composes the office, the word and the person", () => {
    expect(composePaymentRef({ officeCode: "TEST", memberCode: "DINH" })).toBe(
      "TEST LUNCH DINH",
    );
  });

  it("is one string per person, whatever is owed", () => {
    // It names no week, so it can be saved as a repeating transfer and
    // somebody three weeks behind is not asked which week they are paying for.
    expect(composePaymentRef({ officeCode: "PERS", memberCode: "NGUY" })).toBe(
      "PERS LUNCH NGUY",
    );
    expect(composePaymentRef({ officeCode: "PERS", memberCode: "NGUY" })).not.toMatch(/\d/);
  });

  it("separates with single spaces and never with an underscore", () => {
    // Letters, digits and spaces are what a Vietnamese transfer note carries
    // through; `_` and `-` are refused or dropped by several banks.
    const ref = composePaymentRef({ officeCode: "TEST", memberCode: "DINH" });
    expect(ref).toMatch(/^[A-Z0-9]+( [A-Z0-9]+)*$/);
    expect(ref).not.toContain("_");
  });

  it("folds a stray space or diacritic out of a code rather than passing it on", () => {
    // A shorter reference is a cost. A reference the QR cannot encode is a
    // member with no way to pay.
    expect(composePaymentRef({ officeCode: " te st ", memberCode: "đinh" })).toBe(
      "TEST LUNCH DINH",
    );
  });

  it("drops the office segment rather than inventing one", () => {
    expect(composePaymentRef({ officeCode: "", memberCode: "DINH" })).toBe("LUNCH DINH");
  });
});

describe("the matchable core survives", () => {
  it.each([
    ["an office with a code", { officeCode: "TEST", memberCode: "DINH" }],
    ["an office with none", { officeCode: "", memberCode: "DINH" }],
    ["the longest member code the database allows", {
      officeCode: "PERS",
      memberCode: "NGUYENDN",
    }],
  ] as const)("%s still contains payment_ref once folded", (_name, ref) => {
    expect(foldMemo(composePaymentRef(ref))).toContain(`LUNCH${ref.memberCode}`);
  });

  it("survives the mangling a bank does on the way through", () => {
    // Doubled spaces, lower case and the bank's own words around it, which is
    // what arrives in production. The database folds all of it away.
    const memo = `CK  ${composePaymentRef({
      officeCode: "TEST",
      memberCode: "DINH",
    }).toLowerCase()}  tu NGUYEN VAN A`;
    expect(foldMemo(memo)).toContain("LUNCHDINH");
  });
});

describe("displayPaymentRef", () => {
  it("shows the composed reference while it carries the core", () => {
    expect(
      displayPaymentRef({ officeCode: "TEST", memberCode: "DINH", paymentRef: "LUNCHDINH" }),
    ).toBe("TEST LUNCH DINH");
  });

  it("falls back to the bare reference when composing would lose it", () => {
    // `payment_ref` and `short_code` are two columns kept in step by a trigger,
    // not one derived from the other. If they ever disagree, a plainer string
    // is the cost; a reference that reaches nobody is money never seen again.
    expect(
      displayPaymentRef({
        officeCode: "TEST",
        memberCode: "DINH",
        paymentRef: "LUNCHOLDCODE",
      }),
    ).toBe("LUNCHOLDCODE");
  });

  it("shows nothing rather than a decorated blank", () => {
    expect(displayPaymentRef({ officeCode: "TEST", memberCode: "", paymentRef: "" })).toBe("");
  });
});

describe("what the QR will accept", () => {
  const ACCOUNT = { bankBin: "970416", accountNumber: "4286427" };

  it("encodes the reference with and without an amount", () => {
    const ref = composePaymentRef({ officeCode: "TEST", memberCode: "DINH" });
    expect(vietQrPayload({ ...ACCOUNT, paymentRef: ref, amountMinor: 45_000 })).not.toBeNull();
    expect(vietQrPayload({ ...ACCOUNT, paymentRef: ref })).not.toBeNull();
  });

  it("stays inside the 24-character ceiling at its longest", () => {
    // Asserted rather than trusted: office 4, " LUNCH ", and the longest
    // member code the database's own check constraint allows, 8.
    const longest = composePaymentRef({ officeCode: "TEST", memberCode: "NGUYENDN" });
    expect(longest).toBe("TEST LUNCH NGUYENDN");
    expect(longest).toHaveLength(19);
    expect(vietQrPayload({ ...ACCOUNT, paymentRef: longest })).not.toBeNull();
  });

  it("is long enough at its shortest, where a code is two characters", () => {
    // The floor is 4 and the shortest legal composition is well clear of it.
    const shortest = composePaymentRef({ officeCode: "", memberCode: "BQ" });
    expect(shortest).toBe("LUNCH BQ");
    expect(vietQrPayload({ ...ACCOUNT, paymentRef: shortest })).not.toBeNull();
  });
});
