import { readFileSync } from "node:fs";
import { join } from "node:path";

// The bot reads offices with its own role, past every policy, so it has to
// leave a deleted office out itself. Three reads decide who a chat is and
// where a code or a link leads; each must exclude `deleted_at`. The Edge
// Function cannot run under Vitest, so its SQL is read as text.
const bot = readFileSync(
  join(import.meta.dirname, "..", "supabase", "functions", "telegram", "index.ts"),
  "utf8",
);

/** One top-level function of the bot, from its declaration to its closing brace. */
function fn(name: string): string {
  const start = bot.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const end = bot.indexOf("\n}\n", start);
  return bot.slice(start, end).replace(/\s+/g, " ");
}

describe("the bot and a deleted office", () => {
  it("does not resolve a chat to a membership in a deleted office", () => {
    expect(fn("linksForChat")).toContain(
      "join public.organizations o on o.id = tl.org_id and o.deleted_at is null",
    );
  });

  it("does not take a deleted office's join code", () => {
    expect(fn("orgForJoinCode")).toMatch(/o\.telegram_join_code = \$\{code\}.*and o\.deleted_at is null/);
  });

  it("does not redeem a link token into a deleted office", () => {
    expect(fn("onLinkToken")).toContain(
      "join public.organizations o on o.id = tl.org_id and o.deleted_at is null",
    );
  });
});
