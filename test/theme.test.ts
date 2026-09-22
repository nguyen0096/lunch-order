import { beforeEach, describe, expect, it } from "vitest";
import { THEME_KEY, applyTheme, readTheme } from "@/ui/theme";

/**
 * jsdom loads no stylesheet, so `--surface` is set inline here. That is enough
 * to prove the wiring: the tag follows whatever the token resolves to, and the
 * token's real values live in styles.css.
 */
function setSurface(hex: string) {
  document.documentElement.style.setProperty("--surface", hex);
}

function chrome(): string[] {
  return [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
    (t) => t.content,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  document.head.innerHTML = `
    <meta name="theme-color" content="#fdfcfa" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#17110a" media="(prefers-color-scheme: dark)">`;
});

describe("applyTheme", () => {
  it("forces the class and remembers the choice", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(readTheme()).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("system takes the class off and forgets, so the media query decides again", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(document.documentElement.className).toBe("");
    expect(localStorage.getItem(THEME_KEY)).toBe(null);
    expect(readTheme()).toBe("system");
  });

  it("moves the browser chrome onto a forced theme", () => {
    setSurface("#17110a");
    applyTheme("dark");
    // Both tags, because the spec picks the first whose media matches and only
    // one of them ever does: leaving the other alone would flip the address
    // bar back the moment the OS scheme changed under a forced page.
    expect(chrome()).toEqual(["#17110a", "#17110a"]);
  });

  it("gives the chrome back to the OS on system", () => {
    setSurface("#17110a");
    applyTheme("dark");
    applyTheme("system");
    expect(chrome()).toEqual(["#fdfcfa", "#17110a"]);
  });

  it("leaves the chrome alone when no token has resolved", () => {
    applyTheme("light");
    expect(chrome()).toEqual(["#fdfcfa", "#17110a"]);
  });
});
