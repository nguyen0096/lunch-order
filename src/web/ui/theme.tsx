import { useCallback, useSyncExternalStore } from "react";
import { Button } from "@/ui/button";
import { cn } from "@/ui/cn";

export type Theme = "system" | "light" | "dark";

/**
 * Read by the inline script in index.html before the stylesheet is applied, so
 * the name lives here and is repeated exactly once, there.
 */
export const THEME_KEY = "lunch.theme";

const CHOICES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** What was chosen last. Storage throws outright in a locked-down browser. */
export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * System means system: the class comes off and the media query in styles.css
 * decides again, rather than freezing whatever the OS said at the time.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (theme !== "system") root.classList.add(theme);
  syncBrowserChrome(theme);
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A refused write costs the choice on the next load, not this one.
  }
}

/**
 * Keep the address bar with the page.
 *
 * index.html carries two `theme-color` tags scoped by `prefers-color-scheme`,
 * which is right until somebody forces a theme: the page flips and the browser
 * chrome stays on whatever the OS said. Appending a third, unconditional tag
 * does not fix it -- the spec picks the FIRST tag whose media matches, so an
 * unconditional one at the end never wins and one at the front would always
 * win. The matching tag's content is what has to change.
 *
 * The colour is read from the token rather than repeated here, so styles.css
 * stays the only place a surface colour is decided.
 */
function syncBrowserChrome(theme: Theme): void {
  const tags = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  for (const tag of tags) {
    tag.dataset["bySystem"] ??= tag.content;
  }
  if (theme === "system") {
    for (const tag of tags) tag.content = tag.dataset["bySystem"] ?? tag.content;
    return;
  }
  // Reading a custom property forces the style recalc the classList change
  // above queued, so this is the new theme's surface, not the old one's.
  const surface = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface")
    .trim();
  if (surface === "") return;
  for (const tag of tags) tag.content = surface;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The chosen theme and a setter.
 *
 * Storage is the state, so the two menus that render this control, the sidebar
 * and the phone header, cannot disagree, and neither can a reload.
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);
  const choose = useCallback((next: Theme) => {
    applyTheme(next);
    for (const listener of listeners) listener();
  }, []);
  return [theme, choose];
}

/**
 * Three states, not a toggle. A two-state switch cannot say "follow the
 * machine", so the first thing it does is silently stop following it.
 */
export function ThemeChoice() {
  const [theme, choose] = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme"
      className="mt-1 grid grid-cols-3 gap-1 rounded-md bg-surface-sunken p-1"
    >
      {CHOICES.map((c) => (
        <Button
          key={c.value}
          variant="ghost"
          size="sm"
          aria-pressed={theme === c.value}
          className={cn(
            "h-8 px-1 text-xs",
            theme === c.value
              ? "bg-surface-raised text-text hover:bg-surface-raised"
              : "text-muted",
          )}
          onClick={() => choose(c.value)}
        >
          {c.label}
        </Button>
      ))}
    </div>
  );
}
