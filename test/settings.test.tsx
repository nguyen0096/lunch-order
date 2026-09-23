import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { SettingsScreen } from "../src/web/components/SettingsScreen.js";
import * as api from "../src/web/api.js";
import { EMPTY_PAYMENT_CONFIG, parsePaymentConfig } from "../src/shared/payment.js";
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
    fetchOrgSettings: vi.fn(),
    setPaymentConfig: vi.fn(),
    setTelegramGroupChatId: vi.fn(),
    setDefaultCutoffLocalTime: vi.fn(),
  };
});

const fetchStandingOrders = vi.mocked(api.fetchStandingOrders);
const setStandingOrder = vi.mocked(api.setStandingOrder);
const fetchTelegramLink = vi.mocked(api.fetchTelegramLink);
const createTelegramLink = vi.mocked(api.createTelegramLink);
const unlinkTelegram = vi.mocked(api.unlinkTelegram);
const setDisplayName = vi.mocked(api.setDisplayName);
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
};

const ME: Me = {
  profileId: "me",
  fullName: "Nguyễn Văn A",
  email: "neyu@example.com",
  orgs: [{ org: ORG, role: "member", shortCode: "NEYU", displayName: "Neyu" }],
};

const LINK = { membershipId: 3, linkToken: "tok-1", linked: false };

/** The card a setting lives in, so three Save buttons stay three. */
function card(title: string): HTMLElement {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (section === null) throw new Error(`no card around the heading ${title}`);
  return section;
}

async function renderSettings(role: Role = "member") {
  render(<SettingsScreen me={ME} org={ORG} role={role} />);
  await screen.findByRole("heading", { name: "Standing days" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
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

    // And the absence is explained rather than silent.
    expect(screen.getByText(/set by an admin of Test Office/)).toBeInTheDocument();
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
    await waitFor(() => expect(createTelegramLink).toHaveBeenCalledWith(7, "me"));

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

describe("the office's bank account", () => {
  async function fillAccount() {
    const money = card("Where the money goes");
    await userEvent.click(within(money).getByRole("combobox"));
    await userEvent.click(await screen.findByText("Vietcombank"));
    await userEvent.type(screen.getByLabelText("Account number"), "0123 456 789");
    await userEvent.type(screen.getByLabelText("Account name"), "NGUYEN VAN A");
    return money;
  }

  it("writes payment_config in the shape parsePaymentConfig defines", async () => {
    await renderSettings("admin");
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
    await renderSettings("admin");
    const money = card("Where the money goes");
    await userEvent.click(within(money).getByRole("combobox"));
    await userEvent.click(await screen.findByText("Techcombank"));

    const save = within(money).getByRole("button", { name: "Save" });
    expect(save).toHaveAccessibleDescription("Add the account number");
    await userEvent.click(save);
    expect(setPaymentConfig).not.toHaveBeenCalled();
  });

  it("insists on the name the payer checks the account against", async () => {
    await renderSettings("admin");
    const money = card("Where the money goes");
    await userEvent.click(within(money).getByRole("combobox"));
    await userEvent.click(await screen.findByText("Vietcombank"));
    await userEvent.type(screen.getByLabelText("Account number"), "0123456789");

    expect(within(money).getByRole("button", { name: "Save" })).toHaveAccessibleDescription(
      "Add the account name, so people can check it before they pay",
    );
  });

  it("refuses an account number that cannot be one", async () => {
    await renderSettings("admin");
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
    await renderSettings("admin");
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
    await renderSettings("admin");
    const money = await fillAccount();
    await userEvent.click(within(money).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        "That did not save. You need to be an admin of this office.",
      ),
    );
    expect(success).not.toHaveBeenCalled();
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
