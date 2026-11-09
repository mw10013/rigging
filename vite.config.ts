import { defineConfig } from "vite-plus";

import { lint } from "#rigging/core/lint/rules.ts";
import { testRun, unitProject } from "#rigging/core/test.ts";

export default defineConfig({
  fmt: { printWidth: 80, sortImports: true },
  test: {
    ...testRun(import.meta.dirname),
    projects: [
      unitProject({ include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] }),
    ],
  },
  lint,
});
