import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { MenuScreen } from "../src/web/components/MenuScreen.js";
import * as api from "../src/web/api.js";
import type { EditableMenu, PublishImpact } from "../src/web/api.js";
import { cutoffLabel, longDay, shortDay } from "../src/web/components/menu/labels.js";
import { addDays, isoWeekday, todayIn, zonedTimeToInstant } from "../src/shared/dates.js";
import type { Me, Org } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. `parseMenu`, `parseVietnamesePrice`,
// `publishDisabledReason` and `humanError` stay real, because the parse, the
// per-row uncertainty and the refusal wording are most of what is under test.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchMenuEditor: vi.fn(),
    fetchMenuCalendar: vi.fn(),
    fetchPublishImpact: vi.fn(),
    publishMenu: vi.fn(),
    assistParse: vi.fn(),
  };
});

const fetchMenuEditor = vi.mocked(api.fetchMenuEditor);
const fetchMenuCalendar = vi.mocked(api.fetchMenuCalendar);
const fetchPublishImpact = vi.mocked(api.fetchPublishImpact);
const publishMenu = vi.mocked(api.publishMenu);
const assistParse = vi.mocked(api.assistParse);
const success = vi.mocked(toast.success);
const failure = vi.mocked(toast.error);

/* ------------------------------------------------------------------ fixture */

const TZ = "Asia/Ho_Chi_Minh";

const ORG: Org = {
  id: 7,
  slug: "test-office",
  name: "Test Office",
  timezone: TZ,
  currency: { code: "VND", minorUnits: 0, locale: "vi-VN" },
  defaultCutoffLocalTime: "21:00:00",
  billingWeekStartsOn: 1,
};

const ME: Me = {
  profileId: "me",
  fullName: "Neyu",
  email: "neyu@example.com",
  orgs: [{ org: ORG, role: "admin", shortCode: "NEYU", displayName: "Neyu" }],
};

const TODAY = todayIn(TZ);

/** The day the screen opens on: tomorrow, skipping the weekend. */
const DATE = (() => {
  let d = addDays(TODAY, 1);
  while (isoWeekday(d) > 5) d = addDays(d, 1);
  return d;
})();

// Three prices, deliberately written three ways. "45k" is unambiguous, "50.000đ"
// is a separator, and "40" is the case the parser has to guess at.
const MESSAGE = [
  "Thực đơn hôm nay",
  "- Cơm gà 45k",
  "- Bún bò 50.000đ",
  "- Phở bò 40",
  "- Món đặc biệt",
  "Đặt trước 9h sáng",
].join("\n");

function menu(over: Partial<EditableMenu> = {}): EditableMenu {
  return {
    id: 11,
    status: "draft",
    sourceText: "",
    orderCutoffAt: new Date(`${addDays(DATE, -1)}T14:00:00Z`).toISOString(),
    items: [
      { id: 101, name: "Cơm gà", priceMinor: 45_000, position: 0 },
      { id: 102, name: "Bún bò", priceMinor: 50_000, position: 1 },
    ],
    ...over,
  };
}

function impact(over: Partial<PublishImpact> = {}): PublishImpact {
  return { standing: 3, orders: 0, chosen: 0, ...over };
}

function serve(over: { menu?: EditableMenu | null; impact?: PublishImpact } = {}) {
  fetchMenuEditor.mockResolvedValue(over.menu === undefined ? null : over.menu);
  fetchMenuCalendar.mockResolvedValue(new Map());
  fetchPublishImpact.mockResolvedValue(over.impact ?? impact());
}

function renderMenu() {
  return render(<MenuScreen me={ME} org={ORG} role="admin" />);
}

/** Waits for the first load to land, whatever it landed on. */
async function ready() {
  await screen.findByRole("heading", { name: "Dishes and prices" });
}

const publishButton = () => screen.getByRole("button", { name: "Publish" });
const cutoffDate = () => screen.getByLabelText("Orders close");
const cutoffTime = () => screen.getByLabelText("Orders close at");

/**
 * Date and time inputs take a value, not keystrokes: `userEvent.type` drives a
 * browser's segmented editor, which jsdom does not implement.
 */
function set(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

/** The next working day after `from`, which is where the day strip goes next. */
function workingDayAfter(from: string): string {
  let day = addDays(from, 1);
  while (isoWeekday(day) > 5) day = addDays(day, 1);
  return day;
}

beforeEach(() => {
  vi.clearAllMocks();
  publishMenu.mockResolvedValue({ menuId: 11, dishes: 3, standingOrders: 3, wasUpdate: false });
});

/* --------------------------------------------------------- loading, failure */

describe("Menu, loading and failure", () => {
  it("shows a skeleton rather than the word loading", async () => {
    fetchMenuEditor.mockReturnValue(new Promise(() => {}));
    fetchMenuCalendar.mockReturnValue(new Promise(() => {}));
    fetchPublishImpact.mockReturnValue(new Promise(() => {}));
    renderMenu();

    expect(await screen.findAllByRole("status")).not.toHaveLength(0);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("renders the database's own sentence and retries", async () => {
    const user = userEvent.setup();
    fetchMenuCalendar.mockResolvedValue(new Map());
    fetchPublishImpact.mockResolvedValue(impact());
    fetchMenuEditor.mockRejectedValueOnce(new Error("network is down"));
    renderMenu();

    expect(await screen.findByRole("heading", { name: "The menu did not load" })).toBeInTheDocument();
    expect(screen.getByText("network is down")).toBeInTheDocument();

    fetchMenuEditor.mockResolvedValue(null);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
  });
});

/* --------------------------------------------------------- no menu, empty */

describe("No menu for the date", () => {
  it("opens on the next working day with a paste prompt and nothing written", async () => {
    serve();
    renderMenu();
    await ready();

    expect(screen.getByLabelText("Service date")).toHaveValue(DATE);
    expect(
      screen.getByRole("heading", { name: "No menu for this day yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(publishMenu).not.toHaveBeenCalled();
  });

  it("says why Publish and Parse are unavailable instead of greying them in silence", async () => {
    serve();
    renderMenu();
    await ready();

    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("Add at least one dish").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Parse" })).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getAllByText("Paste the caterer's message first").length,
    ).toBeGreaterThan(0);
  });

  it("refuses the click while it is unavailable", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();

    await user.click(publishButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

/* ----------------------------------------------------------------- parsing */

describe("Parsing the caterer's message", () => {
  async function pasteAndParse(user: ReturnType<typeof userEvent.setup>, message = MESSAGE) {
    await user.click(screen.getByLabelText("The caterer’s message"));
    await user.paste(message);
    await user.click(screen.getByRole("button", { name: "Parse" }));
  }

  it("fills the table from the offline parser, dish by dish", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();
    await pasteAndParse(user);

    expect(screen.getByLabelText("Dish 1 name")).toHaveValue("Cơm gà");
    expect(screen.getByLabelText("Price of Cơm gà")).toHaveValue("45.000");
    expect(screen.getByLabelText("Dish 2 name")).toHaveValue("Bún bò");
    expect(screen.getByLabelText("Price of Bún bò")).toHaveValue("50.000");
    expect(screen.getByLabelText("Dish 3 name")).toHaveValue("Phở bò");
    expect(publishMenu).not.toHaveBeenCalled();
  });

  it("shows the parser's own uncertainty against the row it belongs to", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();
    await pasteAndParse(user);

    // "40" is the only price the parser had to guess at, so it is the only row
    // that carries a flag.
    expect(
      screen.getByText(/The message wrote no thousands, so this is read as 40\.000/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/45\.000.*no thousands/)).not.toBeInTheDocument();
  });

  it("keeps the lines that are not dishes instead of dropping them", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();
    await pasteAndParse(user);

    const notes = screen.getByRole("region", { name: "Not a dish, kept for reference" });
    expect(within(notes).getByText("Thực đơn hôm nay")).toBeInTheDocument();
    expect(within(notes).getByText("Đặt trước 9h sáng")).toBeInTheDocument();
  });

  it("offers a line it could not read as a manual row rather than dropping it", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();
    await pasteAndParse(user);

    expect(screen.getByRole("heading", { name: "One line had no price in it" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add - Món đặc biệt as a dish" }));

    expect(screen.getByLabelText("Dish 4 name")).toHaveValue("Món đặc biệt");
    expect(screen.getByLabelText("Price of Món đặc biệt")).toHaveValue("");
    // Taken on, so it is no longer offered a second time.
    expect(
      screen.queryByRole("button", { name: "Add - Món đặc biệt as a dish" }),
    ).not.toBeInTheDocument();
  });

  it("is never a dead end when the parse finds nothing", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();
    await pasteAndParse(user, "Món đặc biệt\nCanh chua");

    expect(
      screen.getByRole("heading", { name: "Nothing in that message looked like a dish" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2 lines had no price in them" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add all as dishes" }));
    expect(screen.getByLabelText("Dish 1 name")).toHaveValue("Món đặc biệt");
    expect(screen.getByLabelText("Dish 2 name")).toHaveValue("Canh chua");
  });
});

/* ----------------------------------------------------------------- editing */

describe("Checking the list", () => {
  it("re-reads the price as it is typed and shows what it took", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    const price = screen.getByLabelText("Price of Cơm gà");
    expect(price).toHaveValue("45.000");

    await user.clear(price);
    await user.type(price, "55k");
    expect(screen.getByText("55.000 ₫")).toBeInTheDocument();
    expect(publishButton()).not.toHaveAttribute("aria-disabled");
  });

  it("flags a comma read as a decimal point, which is the one ambiguous case", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    const price = screen.getByLabelText("Price of Cơm gà");
    await user.clear(price);
    await user.type(price, "45,5k");
    expect(
      screen.getByText("Comma read as a decimal point: 45.500 ₫."),
    ).toBeInTheDocument();
  });

  it("blocks Publish, with the reason, when a price cannot be read", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    // Typed and unreadable, which is a mistake. Clearing the box is not: that
    // is how an unpriced dish looks, and it publishes (see the test below).
    await user.clear(screen.getByLabelText("Price of Cơm gà"));
    await user.type(screen.getByLabelText("Price of Cơm gà"), "abc");
    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getAllByText("A price must be a whole number of dong, or left for the caterer").length,
    ).toBeGreaterThan(0);
  });

  it("publishes a dish the caterer has not priced yet", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    await user.clear(screen.getByLabelText("Price of Cơm gà"));
    expect(publishButton()).not.toHaveAttribute("aria-disabled", "true");
  });

  it("blocks Publish, with the reason, when two rows share a name", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    const second = screen.getByLabelText("Dish 2 name");
    await user.clear(second);
    await user.type(second, "Cơm gà");

    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getAllByText('Two rows are called "Cơm gà". Rename one').length,
    ).toBeGreaterThan(0);
  });

  it("removes a row, and the row is gone from what would be published", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    await user.click(screen.getByRole("button", { name: "Remove Bún bò" }));
    expect(screen.queryByLabelText("Price of Bún bò")).not.toBeInTheDocument();

    await user.click(publishButton());
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publishMenu).toHaveBeenCalled());
    expect(publishMenu.mock.calls[0]?.[0].dishes).toEqual([
      { id: 101, name: "Cơm gà", priceMinor: 45_000 },
    ]);
  });
});

describe("Changing the service date", () => {
  it("loads that day's dishes but keeps the message somebody just pasted", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();

    await user.click(screen.getByLabelText("The caterer\u2019s message"));
    await user.paste(MESSAGE);

    let other = addDays(DATE, 1);
    while (isoWeekday(other) > 5) other = addDays(other, 1);

    fetchMenuEditor.mockResolvedValue(menu({ status: "draft" }));
    await user.click(screen.getByRole("button", { name: `${shortDay(other)}, no menu` }));

    await waitFor(() =>
      expect(screen.getByLabelText("Price of C\u01a1m g\u00e0")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Service date")).toHaveValue(other);
    // The pasted message is the one thing on this screen a click cannot recreate.
    expect(screen.getByLabelText("The caterer\u2019s message")).toHaveValue(MESSAGE);
  });
});

/* ---------------------------------------------------------------- cutoff */

describe("When orders close", () => {
  it("defaults to the evening before at the org's own time, and says so in words", async () => {
    serve();
    renderMenu();
    await ready();

    expect(cutoffDate()).toHaveValue(addDays(DATE, -1));
    expect(cutoffTime()).toHaveValue("21:00");

    const expected = cutoffLabel(
      zonedTimeToInstant(addDays(DATE, -1), "21:00", TZ).toISOString(),
      TZ,
    );
    expect(screen.getByText(`Orders close ${expected}.`)).toBeInTheDocument();
  });

  it("follows the service date to the evening before that day", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();

    const other = workingDayAfter(DATE);
    await user.click(screen.getByRole("button", { name: `${shortDay(other)}, no menu` }));

    await waitFor(() => expect(screen.getByLabelText("Service date")).toHaveValue(other));
    expect(cutoffDate()).toHaveValue(addDays(other, -1));
  });

  it("leaves a cutoff the admin set alone when the service date moves", async () => {
    const user = userEvent.setup();
    serve();
    renderMenu();
    await ready();

    // The morning of, rather than the evening before: a deliberate choice, and
    // still earlier than either service date, so nothing else objects to it.
    set(cutoffDate(), DATE);

    // Held open, so the two things that could move the cutoff are separated:
    // the change of date, and then the new day's load landing on no menu.
    let landed: (menu: EditableMenu | null) => void = () => {};
    fetchMenuEditor.mockReturnValueOnce(new Promise((resolve) => { landed = resolve; }));

    // Two days on, not one: the evening before the very next day IS the pinned
    // date, and a test that cannot tell the two apart proves nothing.
    const other = workingDayAfter(workingDayAfter(DATE));
    await user.click(screen.getByRole("button", { name: `${shortDay(other)}, no menu` }));

    expect(screen.getByLabelText("Service date")).toHaveValue(other);
    expect(cutoffDate()).toHaveValue(DATE);

    landed(null);
    await ready();
    expect(cutoffDate()).toHaveValue(DATE);
    expect(publishMenu).not.toHaveBeenCalled();
  });

  it("loads an existing menu's stored cutoff rather than deriving one", async () => {
    const user = userEvent.setup();
    // 09:00 on the service day itself, which no default would produce.
    const stored = new Date(`${DATE}T02:00:00Z`).toISOString();
    serve({ menu: menu({ orderCutoffAt: stored }) });
    renderMenu();
    await ready();

    expect(cutoffDate()).toHaveValue(DATE);
    expect(cutoffTime()).toHaveValue("09:00");

    // And republishing without touching it must not move it.
    await user.click(publishButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish" }),
    );

    await waitFor(() => expect(publishMenu).toHaveBeenCalledTimes(1));
    expect(publishMenu.mock.calls[0]?.[0].cutoffAt).toBe(stored);
  });

  it("publishes the cutoff the admin typed", async () => {
    // The clock is pinned, and it has to be. DATE is tomorrow, so the cutoff
    // day below is today -- and once the wall clock passed 12:00 in the office's
    // zone, cutoffProblem correctly called this cutoff elapsed, Publish went
    // unavailable and the test failed. It was green all morning and red every
    // afternoon: a test that reports the time of day rather than the code.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(zonedTimeToInstant(addDays(DATE, -1), "08:00", TZ));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    serve({ menu: menu() });
    renderMenu();
    await ready();

    set(cutoffDate(), addDays(DATE, -1));
    set(cutoffTime(), "12:00");

    expect(screen.getByText(/^Orders close 12:00 /)).toBeInTheDocument();

    await user.click(publishButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish" }),
    );

    await waitFor(() => expect(publishMenu).toHaveBeenCalledTimes(1));
    expect(publishMenu.mock.calls[0]?.[0].cutoffAt).toBe(
      zonedTimeToInstant(addDays(DATE, -1), "12:00", TZ).toISOString(),
    );
    vi.useRealTimers();
  });

  it("refuses a cutoff after the meal, which nothing else would refuse", async () => {
    serve({ menu: menu() });
    renderMenu();
    await ready();

    set(cutoffDate(), addDays(DATE, 1));

    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getAllByText(
        `Orders would close after lunch on ${longDay(DATE)}. Move the cutoff earlier`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a cutoff already in the past, which only an admin could order past", async () => {
    serve({ menu: menu() });
    renderMenu();
    await ready();

    set(cutoffDate(), addDays(TODAY, -1));

    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getAllByText("That cutoff has already passed, so only an admin could still order. Move it later").length,
    ).toBeGreaterThan(0);
  });

  it("does not call a stored cutoff that has simply elapsed a mistake", async () => {
    // Correcting a price after ordering closed goes through this same Publish.
    const elapsed = new Date(Date.now() - 3_600_000).toISOString();
    serve({ menu: menu({ status: "published", orderCutoffAt: elapsed }) });
    renderMenu();
    await ready();

    expect(publishButton()).not.toHaveAttribute("aria-disabled");
    expect(
      screen.queryByText("That cutoff has already passed, so only an admin could still order. Move it later"),
    ).not.toBeInTheDocument();
  });

  it("shows a frozen menu's cutoff as words, with no box to change it in", async () => {
    serve({ menu: menu({ status: "locked" }) });
    renderMenu();
    await ready();

    expect(screen.queryByLabelText("Orders close")).not.toBeInTheDocument();
    expect(screen.getByText("Orders closed")).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------- publishing */

describe("Publishing", () => {
  it("confirms first, naming the date and how many people it notifies", async () => {
    const user = userEvent.setup();
    serve({ menu: menu(), impact: impact({ standing: 3 }) });
    renderMenu();
    await ready();

    await user.click(publishButton());
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByRole("heading")).toHaveTextContent(
      /^Publish the menu for \w+ \d+ \w+\?$/,
    );
    expect(
      within(dialog).getByText(/This orders lunch for 3 people with a standing \w+/),
    ).toBeInTheDocument();
    expect(publishMenu).not.toHaveBeenCalled();
  });

  it("writes nothing when the confirmation is refused", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    await user.click(publishButton());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(publishMenu).not.toHaveBeenCalled();
  });

  it("sends the checked list, and the button that says Publish says Published", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    const price = screen.getByLabelText("Price of Bún bò");
    await user.clear(price);
    await user.type(price, "52k");

    await user.click(publishButton());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publishMenu).toHaveBeenCalledTimes(1));
    const sent = publishMenu.mock.calls[0]?.[0];
    expect(sent?.serviceDate).toBe(DATE);
    expect(sent?.dishes).toEqual([
      { id: 101, name: "Cơm gà", priceMinor: 45_000 },
      { id: 102, name: "Bún bò", priceMinor: 52_000 },
    ]);
    expect(success).toHaveBeenCalledWith("Published · ordered for 3 people");
  });

  it("names a message with no standing orders honestly", async () => {
    const user = userEvent.setup();
    serve({ menu: menu(), impact: impact({ standing: 0 }) });
    renderMenu();
    await ready();

    await user.click(publishButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/notifies nobody/)).toBeInTheDocument();
  });

  it("reports a refusal in the database's own words", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    publishMenu.mockRejectedValue(new Error("cannot publish a menu with no available dishes"));
    renderMenu();
    await ready();

    await user.click(publishButton());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith("cannot publish a menu with no available dishes"),
    );
  });
});

/* ------------------------------------------------------------- menu states */

describe("Every state the menu can be in", () => {
  it("draft: editable, and says nobody can see it yet", async () => {
    serve({ menu: menu({ status: "draft" }) });
    renderMenu();
    await ready();

    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/Nobody else can see it/)).toBeInTheDocument();
    expect(screen.getByLabelText("Price of Cơm gà")).toBeInTheDocument();
    expect(publishButton()).not.toHaveAttribute("aria-disabled");
  });

  it("published with orders: still editable, with the warning that prices are already snapshotted", async () => {
    serve({ menu: menu({ status: "published" }), impact: impact({ orders: 4, chosen: 2 }) });
    renderMenu();
    await ready();

    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(
      screen.getByText(/4 people have already ordered for this day/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Removing a dish somebody chose will be refused/)).toBeInTheDocument();
    expect(screen.getByLabelText("Price of Cơm gà")).toBeInTheDocument();
  });

  it("published for one person: the sentence agrees with the count", async () => {
    serve({ menu: menu({ status: "published" }), impact: impact({ orders: 1 }) });
    renderMenu();
    await ready();

    expect(screen.getByText(/One person has already ordered/)).toBeInTheDocument();
  });

  it("published with nobody ordering yet: no warning invented", async () => {
    serve({ menu: menu({ status: "published" }), impact: impact({ orders: 0 }) });
    renderMenu();
    await ready();

    expect(screen.queryByText(/already ordered for this day/)).not.toBeInTheDocument();
  });

  it("locked: read only, and Publish carries the reason", async () => {
    serve({ menu: menu({ status: "locked" }) });
    renderMenu();
    await ready();

    expect(screen.queryByLabelText("Price of Cơm gà")).not.toBeInTheDocument();
    expect(screen.getByText("Cơm gà")).toBeInTheDocument();
    expect(screen.getByText("45.000 ₫")).toBeInTheDocument();

    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getAllByText("Orders are closed and have gone to the caterer").length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Parse" })).toHaveAttribute("aria-disabled", "true");
  });

  it("cancelled: read only, and says lunch is off", async () => {
    serve({ menu: menu({ status: "cancelled" }) });
    renderMenu();
    await ready();

    expect(screen.queryByLabelText("Price of Cơm gà")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Lunch is cancelled for this day").length,
    ).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------- the AI path */

describe("Read with AI", () => {
  it("lands in the same editable table, still writing nothing", async () => {
    const user = userEvent.setup();
    serve();
    assistParse.mockResolvedValue({
      serviceDate: null,
      items: [
        { name: "Cơm tấm", priceMinor: 48_000, note: "limited" },
        { name: "Hủ tiếu", priceMinor: 42_000, note: null },
      ],
      notes: ["Đặt trước 9h"],
      model: "deepseek-flash",
    });
    renderMenu();
    await ready();

    await user.click(screen.getByLabelText("The caterer’s message"));
    await user.paste("mot tin nhan kho doc");
    await user.click(screen.getByRole("button", { name: "Read with AI" }));

    await waitFor(() => expect(screen.getByLabelText("Dish 1 name")).toHaveValue("Cơm tấm"));
    expect(screen.getByLabelText("Price of Hủ tiếu")).toHaveValue("42.000");
    expect(success).toHaveBeenCalledWith("Read 2 dishes");
    expect(publishMenu).not.toHaveBeenCalled();
  });

  it("surfaces the function's own message when it fails", async () => {
    const user = userEvent.setup();
    serve();
    assistParse.mockRejectedValue(new Error("DEEPSEEK_API_KEY is not set"));
    renderMenu();
    await ready();

    await user.click(screen.getByLabelText("The caterer’s message"));
    await user.paste("mot tin nhan kho doc");
    await user.click(screen.getByRole("button", { name: "Read with AI" }));

    await waitFor(() => expect(failure).toHaveBeenCalledWith("DEEPSEEK_API_KEY is not set"));
  });
});

/* ------------------------------------------- a dish the caterer has not priced */

describe("Leaving a price to the caterer", () => {
  /** Publish and confirm, returning the dialog so the sentence can be read. */
  async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(publishButton());
    return await screen.findByRole("dialog");
  }

  it("says empty is allowed where the price is typed, not in a help page", async () => {
    serve({ menu: menu() });
    renderMenu();
    await ready();

    expect(
      screen.getByText(/Leave a price empty when the caterer has not said yet/),
    ).toBeInTheDocument();
  });

  it("does not call an empty box a mistake", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    await user.clear(screen.getByLabelText("Price of Cơm gà"));

    expect(screen.queryByText(/No price read here/)).not.toBeInTheDocument();
    expect(screen.getByText("Price to come")).toBeInTheDocument();
    expect(publishButton()).not.toHaveAttribute("aria-disabled", "true");
  });

  it("publishes a whole menu nobody has priced yet, and says what that costs", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    await user.clear(screen.getByLabelText("Price of Cơm gà"));
    await user.clear(screen.getByLabelText("Price of Bún bò"));

    const dialog = await openConfirm(user);
    expect(
      within(dialog).getByText(
        /2 dishes have no price yet\. People can order as usual, but a meal with no price is not billed until you set one, and the week stays open until then\./,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publishMenu).toHaveBeenCalled());
    expect(publishMenu.mock.calls[0]?.[0].dishes).toEqual([
      { id: 101, name: "Cơm gà", priceMinor: null },
      { id: 102, name: "Bún bò", priceMinor: null },
    ]);
  });

  it("publishes a half-priced menu and counts only what is unpriced", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    await user.clear(screen.getByLabelText("Price of Bún bò"));

    const dialog = await openConfirm(user);
    expect(within(dialog).getByText(/^One dish has no price yet\./)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publishMenu).toHaveBeenCalled());
    expect(publishMenu.mock.calls[0]?.[0].dishes).toEqual([
      { id: 101, name: "Cơm gà", priceMinor: 45_000 },
      { id: 102, name: "Bún bò", priceMinor: null },
    ]);
  });

  it("says nothing about prices when the caterer has priced everything", async () => {
    const user = userEvent.setup();
    serve({ menu: menu() });
    renderMenu();
    await ready();

    const dialog = await openConfirm(user);
    expect(within(dialog).queryByText(/no price yet/)).not.toBeInTheDocument();
  });

  it("reopens a published unpriced dish as unpriced, not as a blank box", async () => {
    serve({
      menu: menu({
        status: "published",
        items: [
          { id: 101, name: "Cơm gà", priceMinor: null, position: 0 },
          { id: 102, name: "Bún bò", priceMinor: 50_000, position: 1 },
        ],
      }),
    });
    renderMenu();
    await ready();

    expect(screen.getByLabelText("Price of Cơm gà")).toHaveValue("");
    expect(screen.getByText("Price to come")).toBeInTheDocument();
    // The mistake this exists to prevent: an unpriced dish reading as free.
    expect(screen.queryByText("0 ₫")).not.toBeInTheDocument();
    expect(screen.getByText("50.000 ₫")).toBeInTheDocument();
  });

  it("shows a frozen menu's unpriced dish as unpriced rather than as zero", async () => {
    serve({
      menu: menu({
        status: "locked",
        items: [{ id: 101, name: "Cơm gà", priceMinor: null, position: 0 }],
      }),
    });
    renderMenu();
    await ready();

    expect(screen.queryByLabelText("Price of Cơm gà")).not.toBeInTheDocument();
    expect(screen.getByText("Cơm gà")).toBeInTheDocument();
    expect(screen.getByText("Price to come")).toBeInTheDocument();
    expect(screen.queryByText("0 ₫")).not.toBeInTheDocument();
  });
});
