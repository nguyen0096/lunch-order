import { effectSentence } from "../src/web/components/RemoveMemberDialog.js";

// A meal with no dish yet is named by an aside, which has to close before the
// sentence goes on.
describe("the Remove dialog's sentence for a meal with no dish", () => {
  const noDish = { serviceDate: "2026-10-12", dishes: null, otherName: "Dinh" };

  it("closes the aside before 'is cancelled'", () => {
    expect(effectSentence({ ...noDish, action: "cancel", otherName: null }, "Tèo"))
      .toBe("Tèo's lunch, no dish chosen yet, is cancelled.");
  });

  it("closes it before 'to' on a declined offer", () => {
    expect(effectSentence({ ...noDish, action: "decline" }, "Tèo"))
      .toBe("Dinh's offer of lunch, no dish chosen yet, to Tèo is declined.");
  });

  it("adds nothing after a dish name", () => {
    expect(effectSentence({ ...noDish, action: "cancel", dishes: "Phở bò", otherName: null }, "Tèo"))
      .toBe("Tèo's Phở bò is cancelled.");
  });
});
