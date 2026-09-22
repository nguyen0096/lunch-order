import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migrations reach the database through the Supabase GitHub integration, not
 * through CI, so a migration that fails to parse is invisible to every check
 * that gates a merge: the tests pass, both deploys go green, and the change
 * simply is not there.
 *
 * That happened. 20260925100400 opened a function body with `as $$` and closed
 * it with `end $function$;`, because the body was lifted from
 * pg_get_functiondef, which emits $function$. The migration failed, a security
 * fix sat unapplied, and nothing said so.
 *
 * These are not a substitute for running the migration. They catch the errors
 * that are cheap to catch statically, in the place that does gate a merge.
 */

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

describe("migration files", () => {
  it("there are some, so a bad glob does not pass vacuously", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s closes every dollar-quoted block it opens", (file) => {
    const sql = readFileSync(join(DIR, file), "utf8");

    // A dollar quote is $$ or $tag$. Strip line comments first: a `--` comment
    // mentioning $function$ is prose, not a delimiter.
    const code = sql.replace(/--[^\n]*/g, "");

    const counts = new Map<string, number>();
    for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)?\$/g)) {
      const tag = m[1] ?? "";
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }

    const unbalanced = [...counts.entries()]
      .filter(([, n]) => n % 2 !== 0)
      .map(([tag, n]) => `$${tag}$ appears ${n} time(s)`);

    expect(unbalanced, `${file}: ${unbalanced.join(", ")}`).toEqual([]);
  });

  it.each(files)("%s names a function's owner for every SECURITY DEFINER", (file) => {
    const sql = readFileSync(join(DIR, file), "utf8").replace(/--[^\n]*/g, "");
    // A SECURITY DEFINER function without `set search_path` resolves unqualified
    // names through the caller's search_path, which is how a definer function
    // becomes an escalation. Every one in this repo sets it; keep it that way.
    const definers = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function[\s\S]*?(?=;\s*$|\$\$)/gim)]
      .map((m) => m[0])
      .filter((body) => /security\s+definer/i.test(body));
    const missing = definers.filter((body) => !/set\s+search_path/i.test(body));
    expect(missing.length, `${file}: ${missing.length} SECURITY DEFINER without set search_path`).toBe(0);
  });
});
