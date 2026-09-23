import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { App } from "../src/web/App.js";
import { CreateOfficeDialog } from "../src/web/components/CreateOfficeDialog.js";
import { NoOfficeScreen } from "../src/web/components/SignInScreen.js";
import * as api from "../src/web/api.js";
import { officeProblem, suggestSlug } from "../src/web/api.js";
import type { Org } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the round trip is faked. `suggestSlug`, `officeProblem` and `humanError`
// stay real, because they are most of what these tests are about.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return { ...actual, createOffice: vi.fn(), fetchMe: vi.fn() };
});

// `App` is the composition under test in the last block; the board it lands on
// is somebody else's screen and would only fetch.
vi.mock("../src/web/supabase.js", () => ({
  configError: null,
  signIn: vi.fn(),
  signOut: vi.fn(),
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
}));

vi.mock("../src/web/components/BoardScreen.js", () => ({
  BoardScreen: ({ org }: { org: Org }) => <p>{`the board of ${org.name}`}</p>,
}));

const createOffice = vi.mocked(api.createOffice);
const fetchMe = vi.mocked(api.fetchMe);
const success = vi.mocked(toast.success);
const failure = vi.mocked(toast.error);

/** Copied from `organizations.slug`, 20260911100200_tenancy.sql. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const CREATED: Org = {
  id: 12,
  slug: "cong-ty-an-trua",
  name: "Công ty Ăn Trưa",
  timezone: "Asia/Ho_Chi_Minh",
  currency: { code: "VND", minorUnits: 0, locale: "vi-VN" },
  defaultCutoffLocalTime: "16:00:00",
  billingWeekStartsOn: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  createOffice.mockResolvedValue(CREATED);
});

function dialog() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  render(<CreateOfficeDialog open onOpenChange={onOpenChange} onCreated={onCreated} />);
  return {
    onOpenChange,
    onCreated,
    name: screen.getByLabelText("Office name"),
    address: screen.getByLabelText("Web address") as HTMLInputElement,
    submit: () => screen.getByRole("button", { name: "Create office" }),
  };
}

describe("suggestSlug", () => {
  it("takes the diacritics off a Vietnamese name rather than dropping the word", () => {
    expect(suggestSlug("Công ty Ăn Trưa")).toBe("cong-ty-an-trua");
  });

  it("produces an address the database will accept", () => {
    const slug = suggestSlug("Công ty Ăn Trưa");
    expect(slug).toMatch(SLUG);
    expect(officeProblem({ name: "Công ty Ăn Trưa", slug })).toBeNull();
  });

  it("maps đ by hand, which no normalisation does for us", () => {
    expect(suggestSlug("Đinh Tiên Hoàng")).toBe("dinh-tien-hoang");
  });

  it("collapses punctuation and spacing instead of encoding it", () => {
    expect(suggestSlug("  Lunch  Club!! (2026)  ")).toBe("lunch-club-2026");
  });

  it("never ends on the hyphen a truncation leaves behind", () => {
    const slug = suggestSlug("Công ty trách nhiệm hữu hạn một thành viên Ăn Trưa Sài Gòn");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toMatch(SLUG);
  });

  it("is allowed to come up short, and says so rather than inventing letters", () => {
    expect(suggestSlug("Ăn")).toBe("an");
    expect(officeProblem({ name: "Ăn", slug: "an" })).toMatch(/3 characters/);
  });
});

describe("officeProblem", () => {
  it("passes a draft the database would accept", () => {
    expect(officeProblem({ name: "Test Office", slug: "test-office" })).toBeNull();
  });

  it("asks for a name first", () => {
    expect(officeProblem({ name: "   ", slug: "test-office" })).toMatch(/name/i);
  });

  it("holds the name to 120 characters, trimmed, as the check constraint does", () => {
    expect(officeProblem({ name: "x".repeat(120), slug: "test-office" })).toBeNull();
    expect(officeProblem({ name: `  ${"x".repeat(121)}  `, slug: "test-office" })).toMatch(
      /120 characters/,
    );
  });

  it("refuses an address that is missing, too short or too long", () => {
    expect(officeProblem({ name: "Test", slug: "" })).toMatch(/web address/i);
    expect(officeProblem({ name: "Test", slug: "ab" })).toMatch(/3 characters/);
    expect(officeProblem({ name: "Test", slug: "a".repeat(41) })).toMatch(/40 characters/);
  });

  it("refuses the characters the constraint has no room for", () => {
    expect(officeProblem({ name: "Test", slug: "công ty" })).toMatch(/lowercase letters/);
    expect(officeProblem({ name: "Test", slug: "test office" })).toMatch(/lowercase letters/);
  });

  it("refuses a leading or trailing hyphen, which is the one rule people trip on", () => {
    expect(officeProblem({ name: "Test", slug: "-test" })).toMatch(/start and end/);
    expect(officeProblem({ name: "Test", slug: "test-" })).toMatch(/start and end/);
  });

  it("accepts what the function itself lowercases, rather than scolding about case", () => {
    expect(officeProblem({ name: "Test", slug: "TEST-OFFICE" })).toBeNull();
  });
});

describe("Creating an office", () => {
  it("suggests the address from the name and sends both", async () => {
    const { name, address, submit, onCreated, onOpenChange } = dialog();

    await userEvent.type(name, "Công ty Ăn Trưa");
    expect(address.value).toBe("cong-ty-an-trua");

    await userEvent.click(submit());

    await waitFor(() =>
      expect(createOffice).toHaveBeenCalledWith({
        name: "Công ty Ăn Trưa",
        slug: "cong-ty-an-trua",
      }),
    );
    expect(success).toHaveBeenCalledWith("Created Công ty Ăn Trưa");
    // The office exists; `me` does not know it yet, and only the caller can fix
    // that -- so the dialog closes and hands the new org back.
    expect(onCreated).toHaveBeenCalledWith(CREATED);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lets the address be corrected, and stops following the name once it is", async () => {
    const { name, address, submit } = dialog();

    await userEvent.type(name, "Lunch Club");
    await userEvent.clear(address);
    await userEvent.type(address, "lunch-hcm");
    await userEvent.type(name, " Saigon");

    expect(address.value).toBe("lunch-hcm");
    await userEvent.click(submit());
    await waitFor(() =>
      expect(createOffice).toHaveBeenCalledWith({ name: "Lunch Club Saigon", slug: "lunch-hcm" }),
    );
  });

  it("lowercases an address typed in capitals rather than refusing it", async () => {
    const { name, address, submit } = dialog();

    await userEvent.type(name, "Lunch Club");
    await userEvent.clear(address);
    await userEvent.type(address, "LUNCH-HCM");
    expect(address.value).toBe("lunch-hcm");

    await userEvent.click(submit());
    await waitFor(() =>
      expect(createOffice).toHaveBeenCalledWith({ name: "Lunch Club", slug: "lunch-hcm" }),
    );
  });

  it("says why it cannot be sent, and does not send it", async () => {
    const { name, address, submit } = dialog();

    expect(submit()).toHaveAccessibleDescription("Give the office a name first.");

    await userEvent.type(name, "Lunch Club");
    await userEvent.clear(address);
    expect(submit()).toHaveAccessibleDescription("The office needs a web address.");

    await userEvent.type(address, "no");
    expect(submit()).toHaveAccessibleDescription("The web address needs 3 characters at least.");

    await userEvent.click(submit());
    expect(createOffice).not.toHaveBeenCalled();
  });

  it("reports a refusal rather than appearing to succeed", async () => {
    createOffice.mockRejectedValue({
      code: "23505",
      message: 'duplicate key value violates unique constraint "organizations_slug_uk"',
    });
    const { name, submit, onCreated, onOpenChange } = dialog();

    await userEvent.type(name, "Lunch Club");
    await userEvent.click(submit());

    const said = "That web address is already taken by another office. Try a different one.";
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(failure).toHaveBeenCalledWith(said);
    expect(success).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    // Still open, still holding what was typed: the address is what needs
    // changing, and it is in this dialog.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Office name")).toHaveValue("Lunch Club");
  });

  it("shows the database's own sentence when the refusal is its own", async () => {
    createOffice.mockRejectedValue({ code: "22023", message: "unknown timezone Mars/Olympus" });
    const { name, submit } = dialog();

    await userEvent.type(name, "Lunch Club");
    await userEvent.click(submit());

    expect(await screen.findByText("unknown timezone Mars/Olympus")).toBeInTheDocument();
  });
});

describe("NoOfficeScreen", () => {
  function noOffice() {
    const onCreated = vi.fn();
    render(
      <NoOfficeScreen email="neyu@example.com" onSignOut={vi.fn()} onCreated={onCreated} />,
    );
    return { onCreated };
  }

  it("keeps joining as the headline and creating as the other way", () => {
    noOffice();
    expect(screen.getByText(/Ask a colleague for the join code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create an office/ })).toBeInTheDocument();
  });

  it("creates from here too, and hands the office to the caller", async () => {
    const { onCreated } = noOffice();

    await userEvent.click(screen.getByRole("button", { name: /Create an office/ }));
    await userEvent.type(await screen.findByLabelText("Office name"), "Công ty Ăn Trưa");
    await userEvent.click(screen.getByRole("button", { name: "Create office" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED));
  });
});

describe("Landing in the new office", () => {
  const HERE: Org = { ...CREATED, id: 3, slug: "com-van-phong", name: "Cơm Văn Phòng" };
  const member = (org: Org) => ({ org, role: "owner" as const, shortCode: "NN", displayName: "Neyu" });
  const me = (...orgs: Org[]) => ({
    profileId: "me",
    fullName: "Nguyễn Neyu",
    email: "neyu@example.com",
    orgs: orgs.map(member),
  });

  beforeEach(() => {
    window.location.hash = "#/o/com-van-phong/board";
  });

  it("refetches before it routes, so the redirect cannot bounce it home", async () => {
    // The office the person already has, then both. `App` resolves an unknown
    // slug by sending you back to your first office, so routing to the new one
    // before `me` knows about it lands you where you started.
    // The refetch takes a tick, as a network call does. That is the whole test:
    // with an instant one, navigating before it lands would pass by luck.
    fetchMe.mockResolvedValueOnce(me(HERE)).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return me(HERE, CREATED);
    });
    render(<App />);

    expect(await screen.findByText("the board of Cơm Văn Phòng")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /Account: Neyu/ })[0]!);
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "Create an office" }))[0]!,
    );
    await userEvent.type(await screen.findByLabelText("Office name"), "Công ty Ăn Trưa");
    await userEvent.click(screen.getByRole("button", { name: "Create office" }));

    await waitFor(() => expect(window.location.hash).toBe("#/o/cong-ty-an-trua/board"));
    expect(await screen.findByText("the board of Công ty Ăn Trưa")).toBeInTheDocument();
  });
});
