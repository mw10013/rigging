import { defineConfig } from "vite-plus";

import { lint } from "#rigging/core/lint/rules.ts";

export default defineConfig({
  fmt: { printWidth: 80, sortImports: true },
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
  lint,
});
