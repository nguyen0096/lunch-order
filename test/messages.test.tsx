import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { MessagesScreen } from "../src/web/components/MessagesScreen.js";
import * as api from "../src/web/api.js";
import {
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_KINDS,
  type AnnouncementPerson,
  type NotificationSetting,
} from "../src/web/api.js";
import { EMPTY_PAYMENT_CONFIG } from "../src/shared/payment.js";
import type { Me, Org } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. `humanError` and every sentence this screen
// counts people with stay real, because the counts are most of what is under
// test: "sent" is not an answer and "sent to 9, 4 heard nothing" is.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchNotificationSettings: vi.fn(),
    saveNotificationSetting: vi.fn(),
    sendAnnouncement: vi.fn(),
    sendTestNotification: vi.fn(),
    fetchAnnouncementAudience: vi.fn(),
    fetchOrgSettings: vi.fn(),
    fetchJoinCode: vi.fn(),
  };
});

const fetchNotificationSettings = vi.mocked(api.fetchNotificationSettings);
const saveNotificationSetting = vi.mocked(api.saveNotificationSetting);
const sendAnnouncement = vi.mocked(api.sendAnnouncement);
const sendTestNotification = vi.mocked(api.sendTestNotification);
const fetchAnnouncementAudience = vi.mocked(api.fetchAnnouncementAudience);
const fetchOrgSettings = vi.mocked(api.fetchOrgSettings);
const fetchJoinCode = vi.mocked(api.fetchJoinCode);
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
  fullName: "Neyu",
  email: "neyu@example.com",
  mayFoundOffice: true,
  orgs: [
    { org: ORG, role: "admin", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" },
  ],
};

/**
 * Four people, three of them on Telegram, two of them owing money. The one who
 * is not connected is the whole reason this screen reports two numbers.
 */
const PEOPLE: AnnouncementPerson[] = [
  { profileId: "dinh", name: "Dinh", connected: false, owedMinor: 0 },
  { profileId: "me", name: "Neyu", connected: true, owedMinor: 0 },
  { profileId: "quy", name: "Quy", connected: true, owedMinor: 55_000 },
  { profileId: "teo", name: "Tèo", connected: true, owedMinor: 135_000 },
];

/** No row for any kind, which is the state every office is in today. */
function untouched(): NotificationSetting[] {
  return NOTIFICATION_KINDS.map((kind) => ({
    kind,
    ...NOTIFICATION_DEFAULTS[kind],
    stored: false,
  }));
}

function serve(
  over: {
    settings?: NotificationSetting[];
    people?: AnnouncementPerson[];
    groupChatId?: number | null;
    joinCode?: string | null;
  } = {},
) {
  fetchNotificationSettings.mockResolvedValue(over.settings ?? untouched());
  fetchAnnouncementAudience.mockResolvedValue(over.people ?? PEOPLE);
  fetchOrgSettings.mockResolvedValue({
    payment: EMPTY_PAYMENT_CONFIG,
    telegramGroupChatId: over.groupChatId === undefined ? null : over.groupChatId,
    defaultCutoffLocalTime: "21:00:00",
  });
  fetchJoinCode.mockResolvedValue({
    code: over.joinCode === undefined ? "ABCD2345" : over.joinCode,
    setAt: null,
  });
}

function renderScreen() {
  return render(<MessagesScreen me={ME} org={ORG} role="admin" />);
}

/** Waits for the screen to land, whatever it landed on. */
async function ready() {
  await screen.findByRole("heading", { name: "Messages" });
  await screen.findByRole("heading", { name: "Ordering closes" });
}

/** The card one message lives in, so five Save buttons stay five. */
function card(title: string): HTMLElement {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (section === null) throw new Error(`no card around the heading ${title}`);
  return section;
}

const LAST_CALL = "Ordering closes";
const BILL = "The weekly bill";
const MENU = "A new menu is published";
const ANNOUNCEMENT = "Send an announcement";

/** Each card and the control that turns that message on, which names it. */
const TOGGLES: ReadonlyArray<[string, string]> = [
  [MENU, "Announce a new menu"],
  [LAST_CALL, "Send a last call"],
  [BILL, "Send the weekly bill"],
];

/** Types an announcement and gets as far as the confirmation. */
async function compose(
  user: ReturnType<typeof userEvent.setup>,
  text = "No lunch on Friday, the caterer is closed.",
) {
  const panel = card(ANNOUNCEMENT);
  await user.type(within(panel).getByLabelText("The message"), text);
  await user.click(within(panel).getByRole("button", { name: "Send" }));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  serve();
  // Echoes the save back, the way the table does, so a test is about what the
  // screen sent rather than about a fixture written twice.
  saveNotificationSetting.mockImplementation(async (a) => ({
    kind: a.kind,
    enabled: a.enabled,
    minutesBefore: a.minutesBefore,
    atLocalHour: a.atLocalHour,
    stored: true,
  }));
  sendAnnouncement.mockResolvedValue({ queued: 3, unreachable: 1 });
  sendTestNotification.mockResolvedValue({ queued: 1 });
});

/* --------------------------------------------------- the automatic messages */

describe("Messages, what the office sends by itself", () => {
  it("shows the timings the office has run on all along, before anybody has saved one", async () => {
    renderScreen();
    await ready();

    expect(
      screen.getByText(
        "Nothing here has ever been changed, so these are the timings this office has run on all along.",
      ),
    ).toBeInTheDocument();
    expect(within(card(LAST_CALL)).getByLabelText("Minutes before the cutoff")).toHaveValue("70");
    expect(within(card(BILL)).getByLabelText("Hour of the day")).toHaveValue("9");
    for (const [title, toggle] of TOGGLES) {
      expect(within(card(title)).getByRole("button", { name: toggle })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
  });

  it("offers the menu announcement no time to set, and says why rather than showing an empty box", async () => {
    renderScreen();
    await ready();

    const panel = card(MENU);
    expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(panel).getByText("This one has no time to set.")).toBeInTheDocument();
    expect(
      within(panel).getByText("A new menu is announced as soon as you publish it."),
    ).toBeInTheDocument();
  });

  it("has nothing to save until something changes", async () => {
    renderScreen();
    await ready();

    const save = within(card(BILL)).getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(within(card(BILL)).getAllByText("Nothing to save").length).toBeGreaterThan(0);
  });

  it("turns one message off and saves that kind alone", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    const panel = card(LAST_CALL);
    await user.click(within(panel).getByRole("button", { name: "Send a last call" }));
    expect(within(panel).getByRole("button", { name: "Send a last call" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(saveNotificationSetting).toHaveBeenCalledWith({
        orgId: 7,
        kind: "cutoff_warning",
        enabled: false,
        minutesBefore: 70,
        atLocalHour: null,
      }),
    );
    expect(saveNotificationSetting).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith("No last call goes out.");
  });

  it("marks a change as not yet true until it is saved", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    const panel = card(LAST_CALL);
    expect(
      within(panel).getByText("The last call goes out 70 minutes before ordering closes."),
    ).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Send a last call" }));
    expect(within(panel).getByText("Once saved: no last call goes out.")).toBeInTheDocument();
    expect(within(panel).queryByText("No last call goes out.")).not.toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByText("No last call goes out.")).toBeInTheDocument();
  });

  it("saves a new number of minutes before the cutoff", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    const panel = card(LAST_CALL);
    await user.clear(within(panel).getByLabelText("Minutes before the cutoff"));
    await user.type(within(panel).getByLabelText("Minutes before the cutoff"), "120");
    await user.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(saveNotificationSetting).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "cutoff_warning", minutesBefore: 120, enabled: true }),
      ),
    );
    expect(success).toHaveBeenCalledWith(
      "The last call goes out 120 minutes before ordering closes.",
    );
  });

  it("refuses a last call that would fall between two of the bot's hours", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    const panel = card(LAST_CALL);
    await user.clear(within(panel).getByLabelText("Minutes before the cutoff"));
    await user.type(within(panel).getByLabelText("Minutes before the cutoff"), "30");

    const save = within(panel).getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(
      within(panel).getAllByText("Between 60 and 1440 minutes before the cutoff").length,
    ).toBeGreaterThan(0);

    await user.click(save);
    expect(saveNotificationSetting).not.toHaveBeenCalled();
  });

  it("saves the hour the weekly bill goes out, and sends no timing the kind cannot use", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    const panel = card(BILL);
    await user.selectOptions(within(panel).getByLabelText("Hour of the day"), "8");
    await user.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(saveNotificationSetting).toHaveBeenCalledWith({
        orgId: 7,
        kind: "weekly_bill",
        enabled: true,
        minutesBefore: null,
        atLocalHour: 8,
      }),
    );
    expect(success).toHaveBeenCalledWith("The weekly bill goes out at 08:00.");
  });

  it("reads a saved row rather than the defaults", async () => {
    serve({
      settings: [
        { kind: "menu_published", enabled: false, minutesBefore: null, atLocalHour: null, stored: true },
        { kind: "cutoff_warning", enabled: true, minutesBefore: 180, atLocalHour: null, stored: true },
        { kind: "weekly_bill", enabled: true, minutesBefore: null, atLocalHour: 14, stored: true },
      ],
    });
    renderScreen();
    await ready();

    expect(within(card(MENU)).getByRole("button", { name: "Announce a new menu" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(card(LAST_CALL)).getByLabelText("Minutes before the cutoff")).toHaveValue("180");
    expect(within(card(BILL)).getByLabelText("Hour of the day")).toHaveValue("14");
    expect(
      screen.getByText("Each one is saved on its own. Turning one off leaves the other two alone."),
    ).toBeInTheDocument();
  });

  it("sends a test of one message to the admin who asked for it", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    await user.click(
      within(card(LAST_CALL)).getByRole("button", { name: "Send me a test of the last call" }),
    );

    await waitFor(() =>
      expect(sendTestNotification).toHaveBeenCalledWith({ orgId: 7, kind: "cutoff_warning" }),
    );
    expect(success).toHaveBeenCalledWith("A test is on its way to your Telegram.");
  });

  it("shows the database's refusal of a test in the database's own words", async () => {
    const user = userEvent.setup();
    sendTestNotification.mockRejectedValue(
      new Error("there is no published menu to preview yet; publish one first"),
    );
    renderScreen();
    await ready();

    await user.click(
      within(card(MENU)).getByRole("button", { name: "Send me a test of the menu announcement" }),
    );

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        "there is no published menu to preview yet; publish one first",
      ),
    );
  });
});

/* ------------------------------------------------------------ announcements */

describe("Messages, an announcement", () => {
  it("counts who it would reach before anything is sent", async () => {
    renderScreen();
    await ready();

    expect(
      within(card(ANNOUNCEMENT)).getByText(
        "This reaches 3 of 4 people. 1 person has not connected Telegram.",
      ),
    ).toBeInTheDocument();
    expect(sendAnnouncement).not.toHaveBeenCalled();
  });

  it("counts only the people who owe money for that audience", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    await user.click(screen.getByRole("radio", { name: "Everybody who owes money" }));

    expect(within(card(ANNOUNCEMENT)).getByText("This reaches 2 people.")).toBeInTheDocument();
  });

  it("shows the person picker for one person and for neither of the other two", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    expect(within(card(ANNOUNCEMENT)).queryByRole("combobox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "One person" }));
    expect(within(card(ANNOUNCEMENT)).getByRole("combobox")).toBeInTheDocument();
    expect(
      within(card(ANNOUNCEMENT)).getByText(
        "Nobody is in this audience, so there is nobody to send to.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Everybody in the office" }));
    expect(within(card(ANNOUNCEMENT)).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("says plainly that one person would hear nothing, and will not send to them", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    await user.click(screen.getByRole("radio", { name: "One person" }));
    await user.click(within(card(ANNOUNCEMENT)).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Dinh · not on Telegram" }));

    const panel = card(ANNOUNCEMENT);
    await user.type(within(panel).getByLabelText("The message"), "Your lunch is on the table.");
    expect(
      within(panel).getByText("Dinh has not connected Telegram, so this would reach nobody."),
    ).toBeInTheDocument();

    const send = within(panel).getByRole("button", { name: "Send" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    await user.click(send);
    expect(sendAnnouncement).not.toHaveBeenCalled();
  });

  it("names the audience and the count in the confirmation, and has sent nothing yet", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    const dialog = await compose(user);

    expect(
      within(dialog).getByRole("heading", { name: "Send this to everybody in the office?" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("This reaches 3 of 4 people. 1 person has not connected Telegram."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("No lunch on Friday, the caterer is closed."),
    ).toBeInTheDocument();
    expect(sendAnnouncement).not.toHaveBeenCalled();
  });

  it("reports what went out and who it could not reach", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();

    const dialog = await compose(user);
    await user.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(sendAnnouncement).toHaveBeenCalledWith({
        orgId: 7,
        audience: "office",
        text: "No lunch on Friday, the caterer is closed.",
        profileId: null,
      }),
    );
    expect(success).toHaveBeenCalledWith(
      "Sent to 3 people. 1 person has not connected Telegram.",
    );
  });

  it("sends to the one person who was picked, and names them in the confirmation", async () => {
    const user = userEvent.setup();
    sendAnnouncement.mockResolvedValue({ queued: 1, unreachable: 0 });
    renderScreen();
    await ready();

    await user.click(screen.getByRole("radio", { name: "One person" }));
    await user.click(within(card(ANNOUNCEMENT)).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Tèo" }));

    const dialog = await compose(user, "Your bill for last week is still open.");
    expect(within(dialog).getByRole("heading", { name: "Send this to Tèo?" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(sendAnnouncement).toHaveBeenCalledWith({
        orgId: 7,
        audience: "person",
        text: "Your bill for last week is still open.",
        profileId: "teo",
      }),
    );
    expect(success).toHaveBeenCalledWith("Sent to 1 person.");
  });

  it("sends to everybody who owes money when that is the audience", async () => {
    const user = userEvent.setup();
    sendAnnouncement.mockResolvedValue({ queued: 2, unreachable: 0 });
    renderScreen();
    await ready();

    await user.click(screen.getByRole("radio", { name: "Everybody who owes money" }));
    const dialog = await compose(user, "Please settle last week when you can.");

    expect(
      within(dialog).getByRole("heading", { name: "Send this to everybody who owes money?" }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(sendAnnouncement).toHaveBeenCalledWith(
        expect.objectContaining({ audience: "unpaid", profileId: null }),
      ),
    );
    expect(success).toHaveBeenCalledWith("Sent to 2 people.");
  });

  it("shows the database's refusal in its own words, and keeps the message", async () => {
    const user = userEvent.setup();
    sendAnnouncement.mockRejectedValue(
      new Error("only an admin of this office can send an announcement"),
    );
    renderScreen();
    await ready();

    const dialog = await compose(user);
    await user.click(within(dialog).getByRole("button", { name: "Send" }));

    expect(
      await within(dialog).findByText("only an admin of this office can send an announcement"),
    ).toBeInTheDocument();
    expect(failure).toHaveBeenCalledWith("only an admin of this office can send an announcement");
    expect(
      within(dialog).getByText("No lunch on Friday, the caterer is closed."),
    ).toBeInTheDocument();
  });

  it("cannot be sent twice by a second click while the first is still going", async () => {
    const user = userEvent.setup();
    sendAnnouncement.mockReturnValue(new Promise(() => {}));
    renderScreen();
    await ready();

    const dialog = await compose(user);
    await user.click(within(dialog).getByRole("button", { name: /Send/ }));
    await user.click(within(dialog).getByRole("button", { name: /Send/ }));

    expect(sendAnnouncement).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------- what Telegram needs first */

describe("Messages, what Telegram needs to work", () => {
  it("says the bot has no group to post in, and points at where that is set", async () => {
    renderScreen();
    await ready();

    const panel = card("What Telegram needs to work");
    expect(
      within(panel).getByText(
        "The bot has no group to post in, so the menu and the last call go to people one by one and to no room at all.",
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Set it in Settings" })).toHaveAttribute(
      "href",
      "#/o/test-office/settings",
    );
  });

  it("counts the people the bot can reach at all", async () => {
    renderScreen();
    await ready();

    expect(
      within(card("What Telegram needs to work")).getByText(
        "3 of 4 people in this office have connected Telegram. The rest hear nothing until they do, which each of them does on their own Settings screen.",
      ),
    ).toBeInTheDocument();
  });

  it("links to the join code rather than printing a second copy of it", async () => {
    renderScreen();
    await ready();

    const panel = card("What Telegram needs to work");
    expect(within(panel).queryByText("ABCD2345")).not.toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "See it on People" })).toHaveAttribute(
      "href",
      "#/o/test-office/people",
    );
  });

  it("says the office has no join code when it has never had one", async () => {
    serve({ joinCode: null });
    renderScreen();
    await ready();

    expect(
      within(card("What Telegram needs to work")).getByText(
        "Without a code nobody can join this office from Telegram, which is how most people arrive.",
      ),
    ).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------- not loading */

describe("Messages, when it does not load", () => {
  it("renders the database's own sentence and retries", async () => {
    const user = userEvent.setup();
    fetchNotificationSettings.mockRejectedValueOnce(new Error("network is down"));
    renderScreen();

    expect(
      await screen.findByRole("heading", { name: "Messages did not load" }),
    ).toBeInTheDocument();
    expect(screen.getByText("network is down")).toBeInTheDocument();

    serve();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
  });
});
