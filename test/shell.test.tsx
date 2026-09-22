import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell, initials } from "../src/web/components/AppShell.js";
import type { Org, Role } from "../src/shared/types.js";

const ORG: Org = {
  id: 7,
  slug: "test-office",
  name: "Test Office",
  timezone: "Asia/Ho_Chi_Minh",
  currency: { code: "VND", minorUnits: 0, locale: "vi-VN" },
  defaultCutoffLocalTime: "21:00:00",
  billingWeekStartsOn: 1,
};

function shell(role: Role = "member", page = "board", onSignOut = vi.fn()) {
  render(
    <AppShell
      org={ORG}
      role={role}
      page={page}
      displayName="Nguyễn Neyu"
      email="neyu@example.com"
      onSignOut={onSignOut}
    >
      <p>the board</p>
    </AppShell>,
  );
  return { onSignOut };
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
  });

  it("adds the admin chores under their own heading, not into the same list", () => {
    shell("admin");
    expect(links("Menu")).toHaveLength(2);
    expect(links("People")).toHaveLength(2);
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
