import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell, initials, switchTarget, type Office } from "../src/web/components/AppShell.js";
import type { Org, Role } from "../src/shared/types.js";

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

const OTHER: Org = { ...ORG, id: 8, slug: "other-office", name: "Other Office" };

function shell(
  role: Role = "member",
  page = "board",
  onSignOut = vi.fn(),
  offices: Office[] = [{ org: ORG, role }],
  mayFoundOffice = true,
) {
  const onCreated = vi.fn();
  const onJoined = vi.fn();
  render(
    <AppShell
      org={ORG}
      role={role}
      offices={offices}
      onJoined={onJoined}
      page={page}
      displayName="Nguyễn Neyu"
      email="neyu@example.com"
      mayFoundOffice={mayFoundOffice}
      onSignOut={onSignOut}
      onCreated={onCreated}
    >
      <p>the board</p>
    </AppShell>,
  );
  return { onSignOut, onCreated };
}

/** Somebody in two offices: an admin here, a plain member over there. */
function both(role: Role = "member", otherRole: Role = "member"): Office[] {
  return [
    { org: ORG, role },
    { org: OTHER, role: otherRole },
  ];
}

const switchers = () => screen.queryAllByRole("button", { name: /Switch office/ });

async function openSwitcher() {
  await userEvent.click(switchers()[0]!);
  return within(
    (await screen.findByText("Your offices")).closest("[data-slot='popover-content']") as HTMLElement,
  );
}

/** One destination, rendered once in the sidebar and once in the tab bar. */
const links = (name: string) => screen.queryAllByRole("link", { name });

describe("AppShell navigation", () => {
  it("gives a member two destinations and no admin chores", () => {
    shell("member");
    expect(links("Board")).toHaveLength(2);
    expect(links("Bill")).toHaveLength(2);
    expect(links("Menu")).toHaveLength(0);
    expect(links("People")).toHaveLength(0);
    expect(links("Payments")).toHaveLength(0);
  });

  it("adds the admin chores under their own heading, not into the same list", () => {
    shell("admin");
    expect(links("Menu")).toHaveLength(2);
    expect(links("People")).toHaveLength(2);
    expect(links("Payments")).toHaveLength(2);
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("treats an owner as an admin", () => {
    shell("owner");
    expect(links("Menu")).toHaveLength(2);
  });

  it("ships a sidebar and a tab bar rather than one component stretched", () => {
    shell("member");
    const navs = screen.getAllByRole("navigation", { name: "Main" });
    expect(navs).toHaveLength(2);
  });

  it("marks where you are", () => {
    shell("member", "bill");
    for (const link of links("Bill")) expect(link).toHaveAttribute("aria-current", "page");
    for (const link of links("Board")) expect(link).not.toHaveAttribute("aria-current");
  });

  it("points every link at this org's hash route", () => {
    shell("admin");
    expect(links("Board")[0]).toHaveAttribute("href", "#/o/test-office/board");
    expect(links("People")[0]).toHaveAttribute("href", "#/o/test-office/people");
  });

  it("renders the screen it is given", () => {
    shell("member");
    expect(screen.getByText("the board")).toBeInTheDocument();
  });
});

describe("AppShell account menu", () => {
  it("keeps settings and sign out behind the avatar, not in the tab bar", async () => {
    const { onSignOut } = shell("member");
    expect(links("Settings")).toHaveLength(0);

    await userEvent.click(screen.getAllByRole("button", { name: /Account: Nguyễn Neyu/ })[0]!);

    const menu = await screen.findByText("neyu@example.com");
    const panel = menu.closest("[data-slot='popover-content']")!;
    expect(within(panel as HTMLElement).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "#/o/test-office/settings",
    );

    await userEvent.click(within(panel as HTMLElement).getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("AppShell theme choice", () => {
  async function openMenu() {
    await userEvent.click(screen.getAllByRole("button", { name: /Account: Nguyễn Neyu/ })[0]!);
    const group = await screen.findByRole("group", { name: "Theme" });
    return within(group);
  }

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("light", "dark");
  });

  it("starts on System, and follows the machine by adding no class at all", async () => {
    shell();
    const group = await openMenu();
    expect(group.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.className).toBe("");
  });

  it("forces the scheme on the document and remembers it", async () => {
    shell();
    const group = await openMenu();

    await userEvent.click(group.getByRole("button", { name: "Dark" }));

    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("lunch.theme")).toBe("dark");
    expect(group.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  });

  it("swaps one forced scheme for the other rather than stacking them", async () => {
    shell();
    const group = await openMenu();

    await userEvent.click(group.getByRole("button", { name: "Dark" }));
    await userEvent.click(group.getByRole("button", { name: "Light" }));

    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("lunch.theme")).toBe("light");
  });

  it("gives the machine back the decision on System, storage included", async () => {
    shell();
    const group = await openMenu();

    await userEvent.click(group.getByRole("button", { name: "Dark" }));
    await userEvent.click(group.getByRole("button", { name: "System" }));

    expect(document.documentElement.className).toBe("");
    expect(localStorage.getItem("lunch.theme")).toBeNull();
  });
});

describe("initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Nguyễn Neyu")).toBe("NN");
  });

  it("uses one letter for a one-word name", () => {
    expect(initials("Tèo")).toBe("T");
  });

  it("keeps the Vietnamese letter rather than stripping the diacritic", () => {
    expect(initials("Đinh")).toBe("Đ");
  });

  it("has something to show for a name that is missing", () => {
    expect(initials("   ")).toBe("?");
  });
});

describe("AppShell office switcher", () => {
  it("leaves the name as a name for the one-office majority", () => {
    shell("member");
    expect(switchers()).toHaveLength(0);
    expect(screen.getAllByText("Test Office")[0]).toBeInTheDocument();
  });

  it("turns the name into the way across in both shapes when there are two", async () => {
    shell("member", "board", vi.fn(), both());
    // The sidebar and the phone header, the same rule as every other
    // destination in this shell.
    expect(switchers()).toHaveLength(2);

    const menu = await openSwitcher();
    expect(menu.getByRole("link", { name: /Other Office/ })).toHaveAttribute(
      "href",
      "#/o/other-office/board",
    );
  });

  it("marks the office you are already in", async () => {
    shell("member", "board", vi.fn(), both());
    const menu = await openSwitcher();
    expect(menu.getByRole("link", { name: /Test Office/ })).toHaveAttribute("aria-current", "true");
    expect(menu.getByRole("link", { name: /Other Office/ })).not.toHaveAttribute("aria-current");
  });

  it("keeps the page you are on, so two bills can be compared", async () => {
    shell("member", "bill", vi.fn(), both());
    const menu = await openSwitcher();
    expect(menu.getByRole("link", { name: /Other Office/ })).toHaveAttribute(
      "href",
      "#/o/other-office/bill",
    );
  });

  it("keeps an admin chore when you are an admin over there too", async () => {
    shell("admin", "menu", vi.fn(), both("admin", "admin"));
    const menu = await openSwitcher();
    expect(menu.getByRole("link", { name: /Other Office/ })).toHaveAttribute(
      "href",
      "#/o/other-office/menu",
    );
  });

  it("lands a plain member on the board rather than on an explanation", async () => {
    shell("admin", "people", vi.fn(), both("admin", "member"));
    const menu = await openSwitcher();
    expect(menu.getByRole("link", { name: /Other Office/ })).toHaveAttribute(
      "href",
      "#/o/other-office/board",
    );
  });

  it("opens the create dialog from the switcher", async () => {
    shell("member", "board", vi.fn(), both());
    const menu = await openSwitcher();

    await userEvent.click(menu.getByRole("button", { name: "Create an office" }));

    expect(await screen.findByRole("dialog", { name: "Create an office" })).toBeInTheDocument();
  });
});

describe("AppShell, where creating an office lives", () => {
  async function accountMenu() {
    await userEvent.click(screen.getAllByRole("button", { name: /Account: Nguyễn Neyu/ })[0]!);
    const email = await screen.findByText("neyu@example.com");
    return within(email.closest("[data-slot='popover-content']") as HTMLElement);
  }

  it("offers it in the account menu to somebody who has no switcher", async () => {
    shell("member");
    const menu = await accountMenu();

    await userEvent.click(menu.getByRole("button", { name: "Create an office" }));

    expect(await screen.findByRole("dialog", { name: "Create an office" })).toBeInTheDocument();
  });

  it("does not say it twice once the switcher carries it", async () => {
    shell("member", "board", vi.fn(), both());
    const menu = await accountMenu();
    expect(menu.queryByRole("button", { name: "Create an office" })).not.toBeInTheDocument();
  });

  /**
   * `app_settings.office_creation`, off while the app lives inside one company.
   * The database refuses `create_organization` outright, so what is at stake
   * here is only whether somebody is shown a door that would not open.
   */
  it("offers nothing anywhere when founding an office is switched off", async () => {
    shell("member", "board", vi.fn(), [{ org: ORG, role: "member" }], false);
    const menu = await accountMenu();

    expect(menu.queryByRole("button", { name: "Create an office" })).not.toBeInTheDocument();
    // Joining is not the switch: somebody with a code can always come in.
    expect(menu.getByRole("button", { name: "Join an office" })).toBeInTheDocument();
  });

  it("takes it out of the switcher too, where it had no guard at all", async () => {
    shell("member", "board", vi.fn(), both(), false);
    const menu = await openSwitcher();

    expect(menu.queryByRole("button", { name: "Create an office" })).not.toBeInTheDocument();
    expect(menu.getByRole("button", { name: "Join an office" })).toBeInTheDocument();
  });
});

describe("switchTarget", () => {
  it("carries the page over where the other office has it", () => {
    expect(switchTarget("bill", "member")).toBe("bill");
    expect(switchTarget("settings", "member")).toBe("settings");
    expect(switchTarget("board", "member")).toBe("board");
  });

  it("carries an admin chore over only for an admin", () => {
    expect(switchTarget("menu", "admin")).toBe("menu");
    expect(switchTarget("people", "owner")).toBe("people");
    expect(switchTarget("menu", "member")).toBe("board");
    expect(switchTarget("people", "member")).toBe("board");
  });

  it("sends a page that does not exist to the board", () => {
    expect(switchTarget("nonsense", "admin")).toBe("board");
  });
});
