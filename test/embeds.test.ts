import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PostgREST refuses an embed outright once two foreign keys join the same pair
 * of tables: "Could not embed because more than one relationship was found".
 * memberships gained a second key to profiles (removed_by), every bare
 * `profiles ( ... )` embed on it failed, and the Board went blank. The unit
 * tests mock the client and the SQL suites never pass through PostgREST, so
 * nothing else sees it.
 *
 * Naming the key costs nothing today and survives the next one, so every embed
 * of profiles names it.
 */

const ROOTS = [join(import.meta.dirname, "..", "src"), join(import.meta.dirname, "..", "supabase", "functions")];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe("embeds of profiles", () => {
  it("name the foreign key they follow", () => {
    const bare: string[] = [];
    for (const file of ROOTS.flatMap(sources)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\bprofiles\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bare.push(`${file}:${i + 1}`);
        });
    }
    expect(bare).toEqual([]);
  });
});
