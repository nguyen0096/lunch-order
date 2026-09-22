import type { ReactNode } from "react";
import {
  CalendarDaysIcon,
  ChefHatIcon,
  LogOutIcon,
  ReceiptTextIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, cn } from "@/ui";
import { isAdmin, type Org, type Role } from "../../shared/types.js";

export type Page = "board" | "bill" | "menu" | "people" | "settings";

type Destination = { page: Page; label: string; icon: ReactNode };

const MEMBER: Destination[] = [
  { page: "board", label: "Board", icon: <CalendarDaysIcon /> },
  { page: "bill", label: "Bill", icon: <ReceiptTextIcon /> },
];

const ADMIN: Destination[] = [
  { page: "menu", label: "Menu", icon: <ChefHatIcon /> },
  { page: "people", label: "People", icon: <UsersIcon /> },
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
  page,
  displayName,
  email,
  onSignOut,
  children,
}: {
  org: Org;
  role: Role;
  page: string;
  displayName: string;
  email: string;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const admin = isAdmin(role);
  const href = (p: Page | "settings") => `#/o/${org.slug}/${p}`;

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface-raised px-3 py-4 md:flex">
        <div className="px-3 pb-4">
          <p className="truncate text-lg font-semibold">{org.name}</p>
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
          align="start"
        />
      </aside>

      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-surface-raised px-4 py-2 md:hidden">
          <p className="truncate text-base font-semibold">{org.name}</p>
          <AvatarMenu
            displayName={displayName}
            email={email}
            settingsHref={href("settings")}
            onSignOut={onSignOut}
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
    </div>
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
  align,
}: {
  displayName: string;
  email: string;
  settingsHref: string;
  onSignOut: () => void;
  align: "start" | "end";
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Account: ${displayName}`}
        className="flex h-11 w-full items-center gap-3 rounded-md px-2 text-left transition-colors hover:bg-surface-sunken md:w-full"
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
        <Button variant="ghost" className="w-full justify-start" onClick={onSignOut}>
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
