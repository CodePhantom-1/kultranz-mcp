import { defineConfig } from "vitest/config";

// Standard node pool — the lib math is pure TS with no Workers APIs.
// (The @cloudflare/vitest-pool-workers runtime fails on Windows paths
// containing spaces; the D1-backed /salaries path is verified post-deploy.)
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});