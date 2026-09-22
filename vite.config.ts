import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "src/web",
  // `root` is where index.html lives, and envDir defaults to it. Without this,
  // Vite looks for .env in src/web/ and silently supplies no VITE_ vars at all.
  envDir: repoRoot,
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  test: {
    root: ".",
    globals: true,
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
