import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { SettingsScreen } from "../src/web/components/SettingsScreen.js";
import * as api from "../src/web/api.js";
import { EMPTY_PAYMENT_CONFIG, parsePaymentConfig } from "../src/shared/payment.js";
import { formatMoney } from "../src/shared/money.js";
import type { Me, Org, Role } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. `humanError` and the screen's own rules stay
// real, because they are most of what these tests are about.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchStandingOrders: vi.fn(),
    setStandingOrder: vi.fn(),
    fetchTelegramLink: vi.fn(),
    createTelegramLink: vi.fn(),
    unlinkTelegram: vi.fn(),
    setDisplayName: vi.fn(),
    setShortCode: vi.fn(),
    fetchOrgSettings: vi.fn(),
    setPaymentConfig: vi.fn(),
    setTelegramGroupChatId: vi.fn(),
    setDefaultCutoffLocalTime: vi.fn(),
    fetchLeaveStanding: vi.fn(),
    fetchOfficeDebt: vi.fn(),
    leaveOffice: vi.fn(),
    deleteOffice: vi.fn(),
  };
});

const fetchStandingOrders = vi.mocked(api.fetchStandingOrders);
const setStandingOrder = vi.mocked(api.setStandingOrder);
const fetchTelegramLink = vi.mocked(api.fetchTelegramLink);
const createTelegramLink = vi.mocked(api.createTelegramLink);
const unlinkTelegram = vi.mocked(api.unlinkTelegram);
const setDisplayName = vi.mocked(api.setDisplayName);
const setShortCode = vi.mocked(api.setShortCode);
const fetchLeaveStanding = vi.mocked(api.fetchLeaveStanding);
const fetchOfficeDebt = vi.mocked(api.fetchOfficeDebt);
const leaveOffice = vi.mocked(api.leaveOffice);
const deleteOffice = vi.mocked(api.deleteOffice);
const fetchOrgSettings = vi.mocked(api.fetchOrgSettings);
const setPaymentConfig = vi.mocked(api.setPaymentConfig);
const setTelegramGroupChatId = vi.mocked(api.setTelegramGroupChatId);
const setDefaultCutoffLocalTime = vi.mocked(api.setDefaultCutoffLocalTime);
const success = vi.mocked(toast.success);
const failure = vi.mocked(toast.error);

/* ------------------------------------------------------------------ fixture */

const ORG: Org = {
  id: 7,
  slug: "test-office",
  name: "Test Office",
  timezone: "Asia/Ho_Chi_Minh",
  currency: { code: "VND", minorUnits: 0, locale: "vi-VN" },
  defaultCutoffLocalTime: "21:00:00",
  billingWeekStartsOn: 1,
  businessDayStartsAt: "08:30",
  businessDayEndsAt: "17:30",
};

const ME: Me = {
  profileId: "me",
  fullName: "Nguyễn Văn A",
  email: "neyu@example.com",
  mayFoundOffice: true,
  orgs: [{ org: ORG, role: "member", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" }],
};

const LINK = { membershipId: 3, linkToken: "tok-1", linked: false };

/** The card a setting lives in, so three Save buttons stay three. */
function card(title: string): HTMLElement {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (section === null) throw new Error(`no card around the heading ${title}`);
  return section;
}

/** Called in place of the reload, so a test can see where the person lands. */
let gone: ReturnType<typeof vi.fn>;

async function renderSettings(role: Role = "member", me: Me = ME) {
  render(<SettingsScreen me={me} org={ORG} role={role} onGone={gone} />);
  await screen.findByRole("heading", { name: "Standing days" });
  // The leaving section loads its own facts, so waiting for the control it
  // gates keeps a later state update from landing after the test has finished.
  await screen.findByRole("button", { name: "Leave" });
}

const leaveButton = () => within(card("Leave this office")).getByRole("button", { name: "Leave" });
const deleteButton = () =>
  within(card("Delete this office")).getByRole("button", { name: "Delete this office" });
const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  gone = vi.fn();
  fetchLeaveStanding.mockResolvedValue({ owedMinor: 0, ownerCount: 2 });
  fetchOfficeDebt.mockResolvedValue({ outstandingMinor: 0, peopleOwing: 0 });
  leaveOffice.mockResolvedValue(undefined);
  deleteOffice.mockResolvedValue(undefined);
  setShortCode.mockImplementation(async (a) => a.shortCode.trim().toUpperCase());
  fetchStandingOrders.mockResolvedValue(new Set<number>());
  fetchTelegramLink.mockResolvedValue(null);
  fetchOrgSettings.mockResolvedValue({
    payment: EMPTY_PAYMENT_CONFIG,
    telegramGroupChatId: null,
    defaultCutoffLocalTime: "21:00:00",
  });
  setStandingOrder.mockResolvedValue(undefined);
  createTelegramLink.mockResolvedValue({ ...LINK });
  unlinkTelegram.mockResolvedValue(undefined);
  setDisplayName.mockResolvedValue(undefined);
  setPaymentConfig.mockResolvedValue(undefined);
  setTelegramGroupChatId.mockResolvedValue(undefined);
  setDefaultCutoffLocalTime.mockResolvedValue(undefined);
});

/* ---------------------------------------------------- who sees what, and why */

describe("the two audiences", () => {
  it("shows a member their own settings and no admin control at all", async () => {
    await renderSettings("member");

    expect(screen.getByRole("heading", { name: "Telegram" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Display name" })).toBeInTheDocument();

    // Not greyed out: absent. A member cannot read a refusal off a dead control.
    expect(screen.queryByRole("heading", { name: "Where the money goes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Telegram group chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "When ordering closes" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Default cutoff")).not.toBeInTheDocument();
    expect(fetchOrgSettings).not.toHaveBeenCalled();

    // And the absence is explained rather than silent, naming both roles: the
    // bank account stopped being an admin's when the owner-only guard landed.
    expect(screen.getByText(/set by an admin of Test Office/)).toBeInTheDocument();
    expect(
      screen.getByText(/the bank account bills are paid into is set by an owner/),
    ).toBeInTheDocument();
  });

  it("gives every unavailable control on the member's page a reason", async () => {
    await renderSettings("member");
    const unavailable = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-disabled") === "true");
    expect(unavailable.length).toBeGreaterThan(0);
    for (const b of unavailable) expect(b).toHaveAccessibleDescription();
  });

  it("shows an admin the office settings as well", async () => {
    await renderSettings("admin");
    expect(await screen.findByRole("heading", { name: "Where the money goes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Telegram group chat" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "When ordering closes" })).toBeInTheDocument();
    expect(fetchOrgSettings).toHaveBeenCalledWith(7);
    expect(screen.queryByText(/set by an admin of/)).not.toBeInTheDocument();
  });

  it("treats an owner as an admin", async () => {
    await renderSettings("owner");
    expect(await screen.findByRole("heading", { name: "Where the money goes" })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------ standing days */

describe("standing days", () => {
  it("turns a day on and names the day it saved", async () => {
    await renderSettings("member");
    await userEvent.click(screen.getByRole("button", { name: "Wednesday" }));

    await waitFor(() =>
      expect(setStandingOrder).toHaveBeenCalledWith({
        orgId: 7,
        profileId: "me",
        weekday: 3,
        enabled: true,
      }),
    );
    expect(success).toHaveBeenCalledWith("Wednesday added");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Wednesday" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("turns a day off", async () => {
    fetchStandingOrders.mockResolvedValue(new Set([1, 3]));
    await renderSettings("member");
    expect(screen.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Monday" }));
    await waitFor(() =>
      expect(setStandingOrder).toHaveBeenCalledWith({
        orgId: 7,
        profileId: "me",
        weekday: 1,
        enabled: false,
      }),
    );
    expect(success).toHaveBeenCalledWith("Monday removed");
  });

  it("says what to do when no day is set", async () => {
    await renderSettings("member");
    expect(within(card("Standing days")).getByText(/No standing days/)).toBeInTheDocument();
  });

  it("reports a refused toggle with the database's own sentence", async () => {
    setStandingOrder.mockRejectedValue(new Error("ordering for 24/09 closed at 21:00 23/09"));
    await renderSettings("member");
    await userEvent.click(screen.getByRole("button", { name: "Friday" }));
    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith("ordering for 24/09 closed at 21:00 23/09"),
    );
    expect(screen.getByRole("button", { name: "Friday" })).toHaveAttribute("aria-pressed", "false");
  });
});

/* ---------------------------------------------------------------- telegram */

describe("the Telegram connection", () => {
  it("mints the link only when asked, and shows the raw /start command with no bot configured", async () => {
    await renderSettings("member");
    expect(createTelegramLink).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Connect Telegram/ }));
    await waitFor(() => expect(createTelegramLink).toHaveBeenCalledWith(7));

    // No VITE_TELEGRAM_BOT, so there is no link to tap -- but the command works.
    expect(await screen.findByText("/start tok-1")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open Telegram/ })).not.toBeInTheDocument();
  });

  it("offers the t.me deep link when a bot username is configured", async () => {
    vi.stubEnv("VITE_TELEGRAM_BOT", "LunchBot");
    fetchTelegramLink.mockResolvedValue({ ...LINK });
    await renderSettings("member");

    expect(screen.getByRole("link", { name: /Open Telegram/ })).toHaveAttribute(
      "href",
      "https://t.me/LunchBot/?start=tok-1",
    );
    expect(screen.queryByText("/start tok-1")).not.toBeInTheDocument();
  });

  it("disconnects a connected chat and says so on the card", async () => {
    fetchTelegramLink.mockResolvedValue({ ...LINK, linked: true });
    await renderSettings("member");
    expect(within(card("Telegram")).getByText("Connected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(unlinkTelegram).toHaveBeenCalledWith(3));
    expect(success).toHaveBeenCalledWith("Disconnected");
    expect(await within(card("Telegram")).findByText("Not connected")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------ display name */

describe("display name", () => {
  it("opens on the name this office calls you", async () => {
    await renderSettings("member");
    expect(screen.getByLabelText("Display name")).toHaveValue("Neyu");
  });

  it("will not save an unchanged name, and says why on the control", async () => {
    await renderSettings("member");
    const save = within(card("Display name")).getByRole("button", { name: "Save" });
    expect(save).toHaveAccessibleDescription("Nothing to save");

    await userEvent.click(save);
    expect(setDisplayName).not.toHaveBeenCalled();
  });

  it("will not save a blank name, and says why on the control", async () => {
    await renderSettings("member");
    await userEvent.clear(screen.getByLabelText("Display name"));
    expect(within(card("Display name")).getByRole("button", { name: "Save" }))
      .toHaveAccessibleDescription("A display name cannot be blank");
  });

  it("saves a changed name against the membership", async () => {
    await renderSettings("member");
    const input = screen.getByLabelText("Display name");
    await userEvent.clear(input);
    await userEvent.type(input, "Neyu Nguyễn");

    await userEvent.click(within(card("Display name")).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setDisplayName).toHaveBeenCalledWith({
        orgId: 7,
        profileId: "me",
        displayName: "Neyu Nguyễn",
      }),
    );
    expect(success).toHaveBeenCalledWith("Saved");
  });
});

/* --------------------------------------------------------- where money goes */

/**
 * guard_owner_only_settings() refuses a payment_config change from anybody who
 * is not an owner, with "only an owner can change where the money goes". So the
 * form is an owner's; an admin gets the account as facts, because they read
 * bills and chase payments and still need to know which account this is.
 */
describe("the office's bank account", () => {
  const OWNER_ONLY = "Only an owner can change where the money goes.";

  async function fillAccount() {
    const money = card("Where the money goes");
    await userEvent.click(within(money).getByRole("combobox"));
    await userEvent.click(await screen.findByText("Vietcombank"));
    await userEvent.type(screen.getByLabelText("Account number"), "0123 456 789");
    await userEvent.type(screen.getByLabelText("Account name"), "NGUYEN VAN A");
    return money;
  }

  it("writes payment_config in the shape parsePaymentConfig defines", async () => {
    await renderSettings("owner");
    const money = await fillAccount();
    await userEvent.type(screen.getByLabelText("Note under the QR"), "Cash to Chi is fine too");
    await userEvent.click(within(money).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setPaymentConfig).toHaveBeenCalled());
    const call = setPaymentConfig.mock.calls[0];
    expect(call?.[0]).toBe(7);
    const config = call?.[1];
    expect(config).toEqual({
      // The BIN, not the name: this is what the QR payload carries.
      vietqr: {
        bankBin: "970436",
        accountNumber: "0123456789",
        accountName: "NGUYEN VAN A",
      },
      note: "Cash to Chi is fine too",
    });
    // What the bill will read back out of jsonb has to be what was put in.
    expect(parsePaymentConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
    expect(success).toHaveBeenCalledWith("Saved");
  });

  it("refuses half an account, naming the half that is missing", async () => {
    await renderSettings("owner");
    const money = card("Where the money goes");
    await userEvent.click(within(money).getByRole("combobox"));
    await userEvent.click(await screen.findByText("Techcombank"));

    const save = within(money).getByRole("button", { name: "Save" });
    expect(save).toHaveAccessibleDescription("Add the account number");
    await userEvent.click(save);
    expect(setPaymentConfig).not.toHaveBeenCalled();
  });

  it("insists on the name the payer checks the account against", async () => {
    await renderSettings("owner");
    const money = card("Where the money goes");
    await userEvent.click(within(money).getByRole("combobox"));
    await userEvent.click(await screen.findByText("Vietcombank"));
    await userEvent.type(screen.getByLabelText("Account number"), "0123456789");

    expect(within(money).getByRole("button", { name: "Save" })).toHaveAccessibleDescription(
      "Add the account name, so people can check it before they pay",
    );
  });

  it("refuses an account number that cannot be one", async () => {
    await renderSettings("owner");
    const money = card("Where the money goes");
    await userEvent.click(within(money).getByRole("combobox"));
    await userEvent.click(await screen.findByText("Vietcombank"));
    await userEvent.type(screen.getByLabelText("Account number"), "12");

    expect(within(money).getByRole("button", { name: "Save" })).toHaveAccessibleDescription(
      "An account number is 4 to 19 letters or digits",
    );
  });

  it("opens on the account already stored and has nothing to save", async () => {
    fetchOrgSettings.mockResolvedValue({
      payment: {
        vietqr: { bankBin: "970415", accountNumber: "0987654321", accountName: "CHI" },
        note: null,
      },
      telegramGroupChatId: null,
      defaultCutoffLocalTime: "21:00:00",
    });
    await renderSettings("owner");
    const money = card("Where the money goes");
    expect(within(money).getByRole("combobox")).toHaveTextContent("VietinBank");
    expect(screen.getByLabelText("Account number")).toHaveValue("0987654321");
    expect(within(money).getByRole("button", { name: "Save" })).toHaveAccessibleDescription(
      "Nothing to save",
    );
  });

  it("reports a refused save with the database's own sentence", async () => {
    setPaymentConfig.mockRejectedValue(
      new Error("That did not save. You need to be an admin of this office."),
    );
    await renderSettings("owner");
    const money = await fillAccount();
    await userEvent.click(within(money).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        "That did not save. You need to be an admin of this office.",
      ),
    );
    expect(success).not.toHaveBeenCalled();
  });

  describe("to an owner", () => {
    it("is a form, with no talk of who else may touch it", async () => {
      await renderSettings("owner");
      const money = card("Where the money goes");

      expect(within(money).getByRole("combobox")).toBeInTheDocument();
      expect(within(money).getByLabelText("Account number")).toBeInTheDocument();
      expect(within(money).getByLabelText("Account name")).toBeInTheDocument();
      expect(within(money).getByLabelText("Note under the QR")).toBeInTheDocument();
      expect(within(money).getByRole("button", { name: "Save" })).toBeInTheDocument();
      expect(within(money).queryByText("Owner only")).not.toBeInTheDocument();
      expect(within(money).queryByText(new RegExp(OWNER_ONLY))).not.toBeInTheDocument();
    });
  });

  describe("to an admin who is not an owner", () => {
    const ACCOUNT = {
      payment: {
        vietqr: { bankBin: "970415", accountNumber: "0987654321", accountName: "CHI" },
        note: "Pay Chi in cash if you prefer",
      },
      telegramGroupChatId: null,
      defaultCutoffLocalTime: "21:00:00",
    };

    it("shows the account, because they read bills and chase payments", async () => {
      fetchOrgSettings.mockResolvedValue(ACCOUNT);
      await renderSettings("admin");
      const money = card("Where the money goes");

      // 970415 is VietinBank. Named, not a BIN: an admin chasing a payment
      // reads this against a bank statement.
      expect(within(money).getByText("VietinBank")).toBeInTheDocument();
      expect(within(money).getByText("0987654321")).toBeInTheDocument();
      expect(within(money).getByText("CHI")).toBeInTheDocument();
      expect(within(money).getByText("Pay Chi in cash if you prefer")).toBeInTheDocument();
    });

    it("says an office with no account set has none, rather than showing nothing", async () => {
      await renderSettings("admin");
      expect(
        within(card("Where the money goes")).getByText(
          "No account set yet, so bills show the amount and no QR code.",
        ),
      ).toBeInTheDocument();
    });

    it("offers no form, so nothing is filled in that the database will refuse", async () => {
      fetchOrgSettings.mockResolvedValue(ACCOUNT);
      await renderSettings("admin");
      const money = card("Where the money goes");

      expect(within(money).queryByRole("combobox")).not.toBeInTheDocument();
      expect(within(money).queryByLabelText("Account number")).not.toBeInTheDocument();
      expect(within(money).queryByLabelText("Account name")).not.toBeInTheDocument();
      expect(within(money).queryByLabelText("Note under the QR")).not.toBeInTheDocument();
      expect(within(money).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    });

    it("says why the control is not theirs, and cannot be pressed into saving", async () => {
      fetchOrgSettings.mockResolvedValue(ACCOUNT);
      await renderSettings("admin");
      const money = card("Where the money goes");

      expect(within(money).getByText("Owner only")).toBeInTheDocument();
      const change = within(money).getByRole("button", { name: "Change the account" });
      expect(change).toHaveAttribute("aria-disabled", "true");
      expect(change).toHaveAccessibleDescription(OWNER_ONLY);

      await userEvent.click(change);
      fireEvent.keyDown(change, { key: "Enter" });
      expect(setPaymentConfig).not.toHaveBeenCalled();
    });

    it("names what is still theirs, so the section does not read as a demotion", async () => {
      await renderSettings("admin");
      expect(
        within(card("Where the money goes")).getByText(
          `${OWNER_ONLY} When ordering closes and where the bot posts are still yours to set.`,
        ),
      ).toBeInTheDocument();
      // And those two really are still theirs.
      expect(within(card("When ordering closes")).getByRole("button", { name: "Save" }))
        .toBeInTheDocument();
      expect(within(card("Telegram group chat")).getByRole("button", { name: "Save" }))
        .toBeInTheDocument();
    });
  });
});

/* ------------------------------------------------------------- group chat */

describe("the group chat id", () => {
  it("says the bot has nowhere to post while it is unset", async () => {
    await renderSettings("admin");
    const chat = card("Telegram group chat");
    expect(within(chat).getByText("Not set")).toBeInTheDocument();
    expect(within(chat).getByText(/no group to post in/)).toBeInTheDocument();
    // Named as the fallback it is, not as the way this normally happens.
    expect(within(chat).getByText(/normally fills this in itself/)).toBeInTheDocument();
  });

  it("saves the id as a number", async () => {
    await renderSettings("admin");
    await userEvent.type(screen.getByLabelText("Chat id"), "-1001234567890");
    await userEvent.click(within(card("Telegram group chat")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setTelegramGroupChatId).toHaveBeenCalledWith(7, -1001234567890));
    expect(success).toHaveBeenCalledWith("Saved");
  });

  it("clears the id when the field is emptied", async () => {
    fetchOrgSettings.mockResolvedValue({
      payment: EMPTY_PAYMENT_CONFIG,
      telegramGroupChatId: -1001234567890,
      defaultCutoffLocalTime: "21:00:00",
    });
    await renderSettings("admin");
    const chat = card("Telegram group chat");
    expect(within(chat).getByText("Set")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Chat id"));
    await userEvent.click(within(chat).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setTelegramGroupChatId).toHaveBeenCalledWith(7, null));
    expect(success).toHaveBeenCalledWith("Cleared");
  });

  it("refuses something that is not an id, on the control", async () => {
    await renderSettings("admin");
    await userEvent.type(screen.getByLabelText("Chat id"), "lunch");
    expect(
      within(card("Telegram group chat")).getByRole("button", { name: "Save" }),
    ).toHaveAccessibleDescription("A chat id is a whole number, like -1001234567890");
    expect(setTelegramGroupChatId).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------ order cutoff */

describe("the office's default cutoff", () => {
  /**
   * A native time input commits a whole `HH:MM` at once -- the OS wheel and the
   * spinner both do -- and it refuses selection, so it is changed here the way
   * the browser changes it rather than keystroke by keystroke.
   */
  function setCutoff(value: string): HTMLElement {
    const field = screen.getByLabelText("Default cutoff");
    fireEvent.change(field, { target: { value } });
    return field;
  }

  const saveButton = () => within(card("When ordering closes")).getByRole("button", { name: "Save" });

  it("opens on the time the column holds, with its seconds dropped", async () => {
    fetchOrgSettings.mockResolvedValue({
      payment: EMPTY_PAYMENT_CONFIG,
      telegramGroupChatId: null,
      defaultCutoffLocalTime: "16:00:00",
    });
    await renderSettings("admin");

    // `time without time zone` reads back as HH:MM:SS; the control takes HH:MM.
    expect(screen.getByLabelText("Default cutoff")).toHaveValue("16:00");
    expect(saveButton()).toHaveAccessibleDescription("Nothing to save");
  });

  it("writes a changed time back in the column's own spelling", async () => {
    await renderSettings("admin");
    expect(screen.getByLabelText("Default cutoff")).toHaveValue("21:00");

    setCutoff("16:30");
    await userEvent.click(saveButton());

    await waitFor(() => expect(setDefaultCutoffLocalTime).toHaveBeenCalledWith(7, "16:30:00"));
    expect(success).toHaveBeenCalledWith("Saved");
    // And the card now agrees with the database, without waiting for a refetch.
    await waitFor(() => expect(saveButton()).toHaveAccessibleDescription("Nothing to save"));
  });

  it("will not save a blank cutoff, and says why on the control", async () => {
    await renderSettings("admin");
    setCutoff("");

    expect(saveButton()).toHaveAccessibleDescription("A cutoff cannot be blank");
    await userEvent.click(saveButton());
    expect(setDefaultCutoffLocalTime).not.toHaveBeenCalled();
  });

  it("says a day closes the evening before, and follows the time being typed", async () => {
    await renderSettings("admin");
    const cutoff = card("When ordering closes");
    expect(within(cutoff).getByText(/closes the evening before/)).toBeInTheDocument();
    expect(within(cutoff).getByText("21:00 on Monday")).toBeInTheDocument();

    setCutoff("16:30");
    expect(within(cutoff).getByText("16:30 on Monday")).toBeInTheDocument();
  });

  it("warns that a menu already published does not move, and where that is done", async () => {
    await renderSettings("admin");
    const cutoff = card("When ordering closes");
    expect(
      within(cutoff).getByText(/does not move a menu that is already published/),
    ).toBeInTheDocument();
    expect(within(cutoff).getByText(/on the Menu screen/)).toBeInTheDocument();
  });

  it("names the timezone the time is read in, which is not set here", async () => {
    await renderSettings("admin");
    expect(
      within(card("When ordering closes")).getByText(/Asia\/Ho_Chi_Minh/),
    ).toBeInTheDocument();
  });

  it("reports a save RLS declined rather than looking like it worked", async () => {
    // Zero rows affected is not an error: this is the sentence updateOrg throws
    // in its place, and a demoted admin has to see it.
    setDefaultCutoffLocalTime.mockRejectedValue(
      new Error("That did not save. You need to be an admin of this office."),
    );
    await renderSettings("admin");
    setCutoff("16:30");
    await userEvent.click(saveButton());

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        "That did not save. You need to be an admin of this office.",
      ),
    );
    expect(success).not.toHaveBeenCalled();
    // Still unsaved work, and the control still offers to save it.
    expect(screen.getByLabelText("Default cutoff")).toHaveValue("16:30");
    expect(saveButton()).not.toHaveAccessibleDescription();
  });
});

/* --------------------------------------------------------- loading and error */

describe("loading and failure", () => {
  it("shows a skeleton, not the word Loading", async () => {
    fetchStandingOrders.mockReturnValue(new Promise(() => {}));
    render(<SettingsScreen me={ME} org={ORG} role="member" />);
    expect(await screen.findAllByRole("status")).not.toHaveLength(0);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("says what did not load, with the reason, and can try again", async () => {
    fetchTelegramLink.mockRejectedValueOnce(new Error("upstream connect error"));
    render(<SettingsScreen me={ME} org={ORG} role="member" />);

    expect(await screen.findByRole("heading", { name: "Settings did not load" })).toBeInTheDocument();
    expect(screen.getByText("upstream connect error")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Standing days" })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------- short code */

describe("the short code", () => {
  const codeCard = () => card("Short code");
  const save = () => within(codeCard()).getByRole("button", { name: "Save" });

  it("opens on the code this office knows you by, with nothing to save", async () => {
    await renderSettings("member");
    expect(screen.getByLabelText("Short code")).toHaveValue("NEYU");
    expect(save()).toHaveAccessibleDescription("Nothing to save");
  });

  it("says what the code is for, which is the bank memo and not the board", async () => {
    await renderSettings("member");
    expect(within(codeCard()).getByText(/memo of a bank transfer/)).toBeInTheDocument();
    // And that changing it leaves references already issued alone.
    expect(within(codeCard()).getByText(/does not rewrite a bill you already have/))
      .toBeInTheDocument();
  });

  it("uppercases as it is typed, because the CHECK would refuse it silently", async () => {
    await renderSettings("member");
    const field = screen.getByLabelText("Short code");
    await userEvent.clear(field);
    await userEvent.type(field, "quytu");

    expect(field).toHaveValue("QUYTU");
    await userEvent.click(save());
    await waitFor(() =>
      expect(setShortCode).toHaveBeenCalledWith({
        orgId: 7,
        profileId: "me",
        shortCode: "QUYTU",
      }),
    );
    expect(success).toHaveBeenCalledWith("Saved");
    // That was the member's one change, and the card knows it without a refetch.
    await waitFor(() =>
      expect(save()).toHaveAccessibleDescription(
        "You have used your one change. An admin can change it for you.",
      ),
    );
    expect(field).toBeDisabled();
  });

  it("says a member has one change, before they spend it", async () => {
    await renderSettings("member");
    expect(within(codeCard()).getByText(/You can change it once/)).toBeInTheDocument();
  });

  it("offers nothing to a member who has used their change, and says who can", async () => {
    await renderSettings("member", {
      ...ME,
      orgs: ME.orgs.map((o) => ({ ...o, shortCodeChangesLeft: 0 })),
    });
    expect(screen.getByLabelText("Short code")).toBeDisabled();
    expect(save()).toHaveAccessibleDescription(
      "You have used your one change. An admin can change it for you.",
    );
  });

  it("lets an admin change their own code as often as they need to", async () => {
    await renderSettings("admin", {
      ...ME,
      orgs: ME.orgs.map((o) => ({ ...o, role: "admin" as const, shortCodeChangesLeft: 0 })),
    });
    const field = screen.getByLabelText("Short code");
    expect(field).toBeEnabled();
    for (const next of ["NEY", "NEYU"]) {
      await userEvent.clear(field);
      await userEvent.type(field, next);
      await userEvent.click(save());
      await waitFor(() => expect(save()).toHaveAccessibleDescription("Nothing to save"));
    }
    expect(setShortCode).toHaveBeenCalledTimes(2);
  });

  it("shows the database's refusal of a code too close to a colleague's as it is", async () => {
    const sentence =
      "TEOX is too close to TEO in this office: one would match a transfer meant for the other. Pick a code that neither contains nor sits inside another person's.";
    setShortCode.mockRejectedValue(Object.assign(new Error(sentence), { code: "23505" }));
    await renderSettings("member");
    const field = screen.getByLabelText("Short code");
    await userEvent.clear(field);
    await userEvent.type(field, "TEOX");
    await userEvent.click(save());
    await waitFor(() => expect(failure).toHaveBeenCalledWith(sentence));
  });

  it("names the rule the format broke rather than sending it to the CHECK", async () => {
    await renderSettings("member");
    const field = screen.getByLabelText("Short code");

    await userEvent.clear(field);
    expect(save()).toHaveAccessibleDescription("A short code cannot be blank");

    await userEvent.type(field, "Q");
    expect(save()).toHaveAccessibleDescription("A short code is 2 characters at least");

    await userEvent.type(field, " T");
    expect(save()).toHaveAccessibleDescription(
      "A short code is letters and digits only, with no spaces",
    );

    await userEvent.click(save());
    expect(setShortCode).not.toHaveBeenCalled();
  });

  it("lets the clash come back from the server, with a sentence that says what to do", async () => {
    // RLS can hide the colleague already holding the code, so a duplicate is
    // only ever a server answer. setShortCode names the code; humanError, for
    // any other path that meets the same constraint, says what to do.
    expect(
      api.humanError(
        new Error('duplicate key value violates unique constraint "memberships_code_uk"'),
      ),
    ).toBe("Somebody in this office already uses that short code. Pick a different one.");

    setShortCode.mockRejectedValue(
      new Error("Somebody in this office already uses QUYT. Pick a different one."),
    );
    await renderSettings("member");
    const field = screen.getByLabelText("Short code");
    await userEvent.clear(field);
    await userEvent.type(field, "QUYT");
    await userEvent.click(save());

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        "Somebody in this office already uses QUYT. Pick a different one.",
      ),
    );
    expect(success).not.toHaveBeenCalled();
    // Still their work, and the control still offers to save it.
    expect(screen.getByLabelText("Short code")).toHaveValue("QUYT");
  });
});

/* --------------------------------------------------- leaving, and deleting */

describe("who is offered what at the bottom of the page", () => {
  it("offers a member leaving, and does not mention deleting at all", async () => {
    await renderSettings("member");

    expect(screen.getByRole("heading", { name: "Leave this office" })).toBeInTheDocument();
    // Absent, not greyed: a member has no use for "only an owner can do that"
    // on a control they were never going to press.
    expect(screen.queryByRole("heading", { name: "Delete this office" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Leaving" })).toBeInTheDocument();
    // And the office's books are never even asked for.
    expect(fetchOfficeDebt).not.toHaveBeenCalled();
  });

  it("does not offer deleting to an admin either", async () => {
    await renderSettings("admin");
    expect(screen.getByRole("heading", { name: "Leave this office" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Delete this office" })).not.toBeInTheDocument();
    expect(fetchOfficeDebt).not.toHaveBeenCalled();
  });

  it("offers an owner both, under a heading that names both", async () => {
    await renderSettings("owner");
    expect(screen.getByRole("heading", { name: "Leave this office" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delete this office" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Leaving and deleting" })).toBeInTheDocument();
    expect(fetchOfficeDebt).toHaveBeenCalledWith(7);
  });
});

describe("leaving an office", () => {
  it("says what leaving does not do, before offering it", async () => {
    await renderSettings("member");
    const leave = card("Leave this office");
    expect(within(leave).getByText(/stay on the office's books/)).toBeInTheDocument();
    expect(within(leave).getByText(/join code puts you back/)).toBeInTheDocument();
  });

  it("is unavailable while money is owed, and names the amount", async () => {
    fetchLeaveStanding.mockResolvedValue({ owedMinor: 180000, ownerCount: 2 });
    await renderSettings("member");

    expect(leaveButton()).toHaveAccessibleDescription(
      `You still owe ${formatMoney(180000, ORG.currency)}. Settle up before you leave.`,
    );
    expect(leaveButton()).toHaveAccessibleDescription(/180\.000/);

    await userEvent.click(leaveButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(leaveOffice).not.toHaveBeenCalled();
  });

  it("is unavailable to the only owner, and points at the two real ways out", async () => {
    fetchLeaveStanding.mockResolvedValue({ owedMinor: 0, ownerCount: 1 });
    await renderSettings("owner");

    expect(leaveButton()).toHaveAccessibleDescription(
      "You are the only owner. Make somebody else an owner first, or delete the office.",
    );
    await userEvent.click(leaveButton());
    expect(leaveOffice).not.toHaveBeenCalled();

    // Option one is a screen, so it is a link rather than a sentence.
    expect(screen.getByRole("link", { name: "Make somebody an owner" })).toHaveAttribute(
      "href",
      "#/o/test-office/people",
    );
    // Option two is the card immediately below.
    expect(screen.getByRole("heading", { name: "Delete this office" })).toBeInTheDocument();
  });

  it("does not offer the sole-owner way out to somebody who is not stuck", async () => {
    await renderSettings("owner");
    expect(leaveButton()).not.toHaveAccessibleDescription();
    expect(screen.queryByRole("link", { name: "Make somebody an owner" })).not.toBeInTheDocument();
  });

  it("confirms, calls leave_office, and does not leave you standing where you were", async () => {
    await renderSettings("member");
    expect(leaveButton()).not.toHaveAccessibleDescription();

    await userEvent.click(leaveButton());
    expect(await screen.findByRole("heading", { name: "Leave Test Office?" })).toBeInTheDocument();
    expect(leaveOffice).not.toHaveBeenCalled();

    await userEvent.click(within(dialog()).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(leaveOffice).toHaveBeenCalledWith(7));
    expect(success).toHaveBeenCalledWith("Left Test Office");
    // The office is no longer theirs, so the screen showing it cannot stay up.
    await waitFor(() => expect(gone).toHaveBeenCalled());
  });

  it("can be backed out of, and then nothing has happened", async () => {
    await renderSettings("member");
    await userEvent.click(leaveButton());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(leaveOffice).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  it("surfaces the database's own refusal rather than a generic one", async () => {
    // The client said it was fine and the function disagreed: a week was billed
    // between the page loading and the button being pressed. The function is
    // the enforcement, so its sentence is the one that has to arrive.
    leaveOffice.mockRejectedValue(
      new Error("you still owe this office money; settle up before you leave"),
    );
    await renderSettings("member");
    await userEvent.click(leaveButton());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Leave" }));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        "you still owe this office money; settle up before you leave",
      ),
    );
    expect(success).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  it("says nothing about what you owe until it knows, and then says why", async () => {
    fetchLeaveStanding.mockRejectedValue(new Error("upstream connect error"));
    render(<SettingsScreen me={ME} org={ORG} role="member" onGone={gone} />);

    // The rest of Settings is untouched: a billing read that failed is not a
    // reason to replace the display name field with an error page.
    expect(await screen.findByRole("heading", { name: "Standing days" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Leave" })).toHaveAccessibleDescription(
      "Your bill did not load, so this cannot say yet whether you can leave. Reload the page.",
    );
  });
});

describe("deleting an office", () => {
  it("says it is a soft delete, and that this app cannot undo it", async () => {
    await renderSettings("owner");
    const remove = card("Delete this office");
    expect(within(remove).getByText(/Nothing is erased/)).toBeInTheDocument();
    expect(within(remove).getByText(/cannot bring it back from here/)).toBeInTheDocument();
    expect(within(remove).getByText(/including anyone who still owes money/)).toBeInTheDocument();
  });

  it("names the outstanding amount in the confirmation, not afterwards", async () => {
    fetchOfficeDebt.mockResolvedValue({ outstandingMinor: 540000, peopleOwing: 3 });
    await renderSettings("owner");

    // On the card, so it is read before the dialog is even opened.
    expect(within(card("Delete this office")).getByText(/540\.000/)).toBeInTheDocument();

    await userEvent.click(deleteButton());
    const confirmation = within(await screen.findByRole("dialog"));
    expect(confirmation.getByText(/540\.000/)).toBeInTheDocument();
    expect(confirmation.getByText(/3 people/)).toBeInTheDocument();
    expect(confirmation.getByText(/does not collect it/)).toBeInTheDocument();
  });

  it("says so plainly when nobody owes anything", async () => {
    await renderSettings("owner");
    await userEvent.click(deleteButton());
    expect(
      within(await screen.findByRole("dialog")).getByText(/Nobody owes Test Office anything/),
    ).toBeInTheDocument();
  });

  it("refuses a name that is not the office's, and says what to type", async () => {
    await renderSettings("owner");
    await userEvent.click(deleteButton());
    const confirm = within(dialog()).getByRole("button", { name: "Delete" });

    expect(confirm).toHaveAccessibleDescription("Type Test Office exactly to confirm");
    await userEvent.click(confirm);
    expect(deleteOffice).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("Type Test Office to confirm"), "Test Offic");
    expect(confirm).toHaveAccessibleDescription("Type Test Office exactly to confirm");
    await userEvent.click(confirm);
    expect(deleteOffice).not.toHaveBeenCalled();
  });

  it("deletes on the typed name, and does not leave you standing where you were", async () => {
    await renderSettings("owner");
    await userEvent.click(deleteButton());
    await userEvent.type(screen.getByLabelText("Type Test Office to confirm"), "Test Office");

    const confirm = within(dialog()).getByRole("button", { name: "Delete" });
    expect(confirm).not.toHaveAccessibleDescription();

    await userEvent.click(confirm);
    await waitFor(() => expect(deleteOffice).toHaveBeenCalledWith(7));
    expect(success).toHaveBeenCalledWith("Deleted Test Office");
    await waitFor(() => expect(gone).toHaveBeenCalled());
  });

  it("forgets a half-typed name when the confirmation is closed", async () => {
    await renderSettings("owner");
    await userEvent.click(deleteButton());
    await userEvent.type(screen.getByLabelText("Type Test Office to confirm"), "Test Office");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Keep the office" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteOffice).not.toHaveBeenCalled();

    await userEvent.click(deleteButton());
    expect(await screen.findByLabelText("Type Test Office to confirm")).toHaveValue("");
    expect(within(dialog()).getByRole("button", { name: "Delete" })).toHaveAccessibleDescription(
      "Type Test Office exactly to confirm",
    );
  });

  it("surfaces the database's own refusal rather than a generic one", async () => {
    deleteOffice.mockRejectedValue(new Error("only an owner can delete an office"));
    await renderSettings("owner");
    await userEvent.click(deleteButton());
    await userEvent.type(screen.getByLabelText("Type Test Office to confirm"), "Test Office");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith("only an owner can delete an office"),
    );
    expect(gone).not.toHaveBeenCalled();
  });
});
