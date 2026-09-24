import { useState, type ReactNode } from "react";
import {
  CalendarDaysIcon,
  CheckIcon,
  BanknoteIcon,
  ChefHatIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  PlusIcon,
  ReceiptTextIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ThemeChoice,
  cn,
} from "@/ui";
import { CreateOfficeDialog } from "./CreateOfficeDialog.js";
import { JoinOfficeDialog } from "./JoinOfficeDialog.js";
import { isAdmin, type Org, type Role } from "../../shared/types.js";

export type Page = "board" | "bill" | "menu" | "people" | "payments" | "settings";

/** One membership as the chrome needs it: which office, and what you are in it. */
export type Office = { org: Org; role: Role };

type Destination = { page: Page; label: string; icon: ReactNode };

const MEMBER: Destination[] = [
  { page: "board", label: "Board", icon: <CalendarDaysIcon /> },
  { page: "bill", label: "Bill", icon: <ReceiptTextIcon /> },
];

const ADMIN: Destination[] = [
  { page: "menu", label: "Menu", icon: <ChefHatIcon /> },
  { page: "people", label: "People", icon: <UsersIcon /> },
  { page: "payments", label: "Payments", icon: <BanknoteIcon /> },
];

/**
 * The chrome around every signed-in screen.
 *
 * Two shapes, not one stretched. The old stylesheet assumed "mobile-first, one
 * breakpoint", which is how a lunch board ended up looking like a phone app on
 * a monitor: the desktop is where an admin actually publishes a menu and reads
 * the week, so it gets a persistent sidebar, and the phone gets the thumb-level
 * tab bar it wants.
 *
 * Admin destinations are a separate group in both. An admin is a member who
 * also has chores, and the chores must not crowd the daily act.
 */
export function AppShell({
  org,
  role,
  offices,
  page,
  displayName,
  email,
  onSignOut,
  onCreated,
  onJoined,
  children,
}: {
  org: Org;
  role: Role;
  /** Every office this person belongs to, the active one included. */
  offices: ReadonlyArray<Office>;
  page: string;
  displayName: string;
  email: string;
  onSignOut: () => void;
  /** Refetch and go: a new office is not in `offices` until somebody reloads. */
  onCreated: (org: Org) => void;
  onJoined: (slug: string) => void;
  children: ReactNode;
}) {
  const admin = isAdmin(role);
  const href = (p: Page | "settings") => `#/o/${org.slug}/${p}`;
  const [creating, setCreating] = useState(false);
  const create = () => setCreating(true);
  const [joining, setJoining] = useState(false);
  const join = () => setJoining(true);

  // Belonging to two offices is what makes the name a control. Belonging to one
  // is the ordinary case, and a menu holding a single entry is a promise the
  // interface cannot keep -- so for that person the way to found a second
  // office sits in the account menu instead.
  const switchable = offices.length > 1;

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface-raised px-3 py-4 md:flex">
        <div className="pb-4">
          <OfficeName
            org={org}
            offices={offices}
            page={page}
            align="start"
            onCreateOffice={create}
            onJoinOffice={join}
            className="text-lg font-semibold"
          />
        </div>

        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {MEMBER.map((d) => (
            <SideLink key={d.page} {...d} href={href(d.page)} current={page === d.page} />
          ))}

          {admin && (
            <>
              {/* A rule and a label, not a longer list: the chores sit below
                  the daily act rather than beside it. */}
              <hr className="my-3 border-t border-border" />
              <p className="px-3 pb-1 text-xs font-semibold text-subtle">
                Admin
              </p>
              {ADMIN.map((d) => (
                <SideLink key={d.page} {...d} href={href(d.page)} current={page === d.page} />
              ))}
            </>
          )}
        </nav>

        <AvatarMenu
          displayName={displayName}
          email={email}
          settingsHref={href("settings")}
          onSignOut={onSignOut}
          onCreateOffice={switchable ? undefined : create}
          onJoinOffice={switchable ? undefined : join}
          align="start"
        />
      </aside>

      {/* `min-w-0` is load-bearing. A flex item defaults to `min-width: auto`,
          so the board table's min-content width refused to shrink and pushed
          the PAGE sideways instead of scrolling inside its own wrapper.
          Measured at 768: 265px of horizontal page scroll, and scrolling
          right took the sidebar off screen entirely. */}
      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-surface-raised px-4 py-2 md:hidden">
          <OfficeName
            org={org}
            offices={offices}
            page={page}
            align="start"
            onCreateOffice={create}
            onJoinOffice={join}
            className="w-auto min-w-0 px-2 text-base font-semibold"
          />
          <AvatarMenu
            displayName={displayName}
            email={email}
            settingsHref={href("settings")}
            onSignOut={onSignOut}
            onCreateOffice={switchable ? undefined : create}
          onJoinOffice={switchable ? undefined : join}
            align="end"
          />
        </header>

        {/* The bottom padding clears the tab bar, which is fixed and would
            otherwise sit on top of the last row of the board. */}
        <main id="main" className="flex-1 px-4 pt-4 pb-28 md:px-8 md:py-8 md:pb-8">
          {children}
        </main>

        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface-raised pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <ul className="flex items-stretch">
            {MEMBER.map((d) => (
              <TabLink key={d.page} {...d} href={href(d.page)} current={page === d.page} />
            ))}
            {admin && (
              <>
                <li aria-hidden="true" className="my-2 w-px shrink-0 bg-border" />
                {ADMIN.map((d) => (
                  <TabLink key={d.page} {...d} href={href(d.page)} current={page === d.page} />
                ))}
              </>
            )}
          </ul>
        </nav>
      </div>

      <CreateOfficeDialog open={creating} onOpenChange={setCreating} onCreated={onCreated} />
      <JoinOfficeDialog
        open={joining}
        onOpenChange={setJoining}
        suggestedName={displayName}
        onJoined={onJoined}
      />
    </div>
  );
}

/**
 * Where the same person lands in the other office.
 *
 * Somebody comparing two bills should not be thrown back to the board on every
 * switch, so the page carries over. The two admin chores are the exception:
 * they do not exist for a plain member, and landing on the page that explains
 * that is a dead end dressed up as a destination.
 */
export function switchTarget(page: string, role: Role): Page {
  if (page === "bill" || page === "settings") return page;
  if ((page === "menu" || page === "people" || page === "payments") && isAdmin(role)) {
    return page;
  }
  return "board";
}

/**
 * The office name, and -- for somebody who belongs to two -- the way across.
 *
 * The name is the control because it is already the thing that says which
 * office you are looking at; a separate switcher beside it would say the same
 * thing twice.
 */
function OfficeName({
  org,
  offices,
  page,
  align,
  onCreateOffice,
  onJoinOffice,
  className,
}: {
  org: Org;
  offices: ReadonlyArray<Office>;
  page: string;
  align: "start" | "end";
  onCreateOffice: () => void;
  onJoinOffice: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  if (offices.length < 2) {
    // The span carries the truncation: ellipsis on a flex container does not
    // apply to the anonymous item inside it.
    return (
      <p className={cn("flex h-11 items-center px-3", className)}>
        <span className="min-w-0 truncate">{org.name}</span>
      </p>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "flex h-11 w-full items-center gap-1.5 rounded-md px-3 text-left transition-colors hover:bg-surface-sunken",
          className,
        )}
      >
        <span className="min-w-0 truncate">{org.name}</span>
        <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
        {/* The name alone would label this button "Test Office", which reads as
            a heading rather than as something to press. */}
        <span className="sr-only">Switch office</span>
      </PopoverTrigger>

      <PopoverContent align={align} className="w-64 p-2">
        <p className="px-2 py-1.5 text-xs font-semibold text-subtle">Your offices</p>
        {offices.map((o) => {
          const current = o.org.slug === org.slug;
          return (
            <a
              key={o.org.slug}
              href={`#/o/${o.org.slug}/${switchTarget(page, o.role)}`}
              aria-current={current ? "true" : undefined}
              onClick={() => setOpen(false)}
              className={cn(
                "flex h-11 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors",
                current
                  ? "bg-accent-subtle text-accent-subtle-fg"
                  : "text-muted hover:bg-surface-sunken hover:text-text",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{o.org.name}</span>
              {current && <CheckIcon aria-hidden="true" className="size-4 shrink-0" />}
            </a>
          );
        })}
        <hr className="my-1 border-t border-border" />
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => {
            setOpen(false);
            onJoinOffice();
          }}
        >
          <PlusIcon />
          Join an office
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => {
            setOpen(false);
            onCreateOffice();
          }}
        >
          <PlusIcon />
          Create an office
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function SideLink({
  href,
  label,
  icon,
  current,
}: Destination & { href: string; current: boolean }) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        current
          ? "bg-accent-subtle text-accent-subtle-fg"
          : "text-muted hover:bg-surface-sunken hover:text-text",
        "[&_svg]:size-4 [&_svg]:shrink-0",
      )}
    >
      {icon}
      {label}
    </a>
  );
}

function TabLink({ href, label, icon, current }: Destination & { href: string; current: boolean }) {
  return (
    <li className="flex-1">
      <a
        href={href}
        aria-current={current ? "page" : undefined}
        className={cn(
          "flex h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors",
          current ? "text-accent-subtle-fg" : "text-muted",
          "[&_svg]:size-5",
        )}
      >
        {icon}
        {label}
      </a>
    </li>
  );
}

/**
 * Standing days, Telegram, display name and sign out live behind here rather
 * than in a tab. They are set once and forgotten, and a permanent tab for them
 * competes with the two things people do weekly, and loses.
 */
function AvatarMenu({
  displayName,
  email,
  settingsHref,
  onSignOut,
  onCreateOffice,
  onJoinOffice,
  align,
}: {
  displayName: string;
  email: string;
  settingsHref: string;
  onSignOut: () => void;
  /** Absent when the switcher already carries it, so it has one home at a time. */
  onCreateOffice?: () => void;
  onJoinOffice?: () => void;
  align: "start" | "end";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Account: ${displayName}`}
        // `w-auto` below `md`, because the name inside is `hidden md:block`:
        // full width made the trigger 266px wide on a phone with a 36px
        // avatar in it, so 222px of it was empty and clickable and the org
        // name beside it was truncated to "Test …" for want of the room.
        className="ml-auto flex h-11 w-auto items-center gap-3 rounded-md px-2 text-left transition-colors hover:bg-surface-sunken md:ml-0 md:w-full"
      >
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-sm font-semibold text-accent-subtle-fg"
        >
          {initials(displayName)}
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-sm font-medium md:block">
          {displayName}
        </span>
      </PopoverTrigger>

      <PopoverContent align={align} side="top" className="w-64 p-2">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{displayName}</p>
          <p className="truncate text-xs text-muted">{email}</p>
        </div>
        <hr className="my-1 border-t border-border" />
        <Button asChild variant="ghost" className="w-full justify-start">
          <a href={settingsHref}>
            <SettingsIcon />
            Settings
          </a>
        </Button>
        {onJoinOffice && (
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              setOpen(false);
              onJoinOffice();
            }}
          >
            <PlusIcon />
            Join an office
          </Button>
        )}
        {onCreateOffice && (
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              setOpen(false);
              onCreateOffice();
            }}
          >
            <PlusIcon />
            Create an office
          </Button>
        )}
        {/* Not a `useAction`: there is no write to report, and a toast on
            every tap of a three-state control is noise. */}
        <ThemeChoice />
        <Button variant="ghost" className="mt-1 w-full justify-start" onClick={onSignOut}>
          <LogOutIcon />
          Sign out
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** Up to two letters, taken from the name the office actually calls you. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return (
    letters
      .map((w) => [...(w ?? "")][0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}
