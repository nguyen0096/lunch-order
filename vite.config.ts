import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = dirname(fileURLToPath(import.meta.url));

// GITHUB_SHA in CI; a local build asks git, and a checkout without git gets the
// version alone rather than failing the build.
function commit(): string {
  const sha = process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const { version } = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  version: string;
};
const sha = commit();

export default defineConfig({
  root: "src/web",
  define: { __APP_VERSION__: JSON.stringify(sha ? `${version}+${sha}` : version) },
  // `root` is where index.html lives, and envDir defaults to it. Without this,
  // Vite looks for .env in src/web/ and silently supplies no VITE_ vars at all.
  envDir: repoRoot,
  plugins: [react(), tailwindcss()],
  // shadcn/ui emits `@/…` imports and resolves them from the REPO root, not the
  // Vite root. Absolute so the alias also holds for Vitest, which runs with
  // `root: "."` and would otherwise resolve `@` against the repo root.
  resolve: { alias: { "@": resolve(repoRoot, "src/web") } },
  build: { outDir: "../../dist/web", emptyOutDir: true },
  test: {
    root: ".",
    globals: true,
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
