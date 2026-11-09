/**
 * The Vitest `browser` project: tests in headless Chromium through Playwright. Its own module
 * because it loads `@vitest/browser-playwright`, which an app without browser tests need not
 * install.
 *
 * @module
 */
import { playwright } from "vite-plus/test/browser-playwright";
import type { TestProjectInlineConfiguration } from "vite-plus/test/config";

import type { ProjectTest } from "#rigging/core/test.ts";

/**
 * Components and hooks in Chromium, from `test/browser/`. The unit and browser globs must not
 * overlap, because `vitest/browser` throws in Node. `test` replaces any of the preset's fields;
 * an app adds its plugins, `optimizeDeps` and aliases beside the spread.
 */
export const browserProject = (
  test: ProjectTest = {},
): TestProjectInlineConfiguration => ({
  test: {
    name: "browser",
    include: ["test/browser/**/*.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    ...test,
  },
});
