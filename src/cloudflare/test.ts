/**
 * The Vitest `integ` project of an Alchemy app: the Backend deployed in workerd through
 * `@alchemy.run/test`, one stage per file (`TestFileStage`), files in parallel.
 *
 * @module
 */
import type { TestProjectInlineConfiguration } from "vite-plus/test/config";

import type { ProjectTest } from "#rigging/core/test.ts";

/**
 * `testStage` names the checkout's `test` stage, which each file's stage extends. It runs only
 * under Vitest, so `vp build` and `vp run dev` do not compute it. The Worker's init reads
 * `ALCHEMY_DEV` at plan, so the test process sets it. `@alchemy.run/test/Vitest` registers its
 * sidecar cleanup after the file's `afterAll` hooks and expects them to run in that order, so hooks
 * run as listed: in Vitest's default reverse order, `destroy` would wait on a closed sidecar.
 * `test` replaces any of the preset's fields.
 */
export const integProject = (
  testStage: () => string,
  test: ProjectTest = {},
): TestProjectInlineConfiguration => ({
  test: {
    name: "integ",
    globalSetup: ["@mw10013/rigging/cloudflare/integ-setup"],
    include: ["test/integ/**/*.test.ts"],
    env:
      process.env.VITEST === "true"
        ? { ALCHEMY_DEV: "1", ALCHEMY_TEST_STAGE: testStage() }
        : { ALCHEMY_DEV: "1" },
    sequence: { hooks: "list" },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    pool: "forks",
    ...test,
  },
});
