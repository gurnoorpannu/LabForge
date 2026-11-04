import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against source, so no build is needed first.
    alias: {
      "@labforge/shared": fileURLToPath(new URL("./services/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["services/*/src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
