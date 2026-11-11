/**
 * The test configuration every app shares: the Vitest options that keep each run's results, the
 * `unit` project, a Playwright base config and the dev server's watch exclusion. Each helper
 * returns a plain config object, so an app spreads it and overrides any field. The `browser`
 * project is `core/browser-test`, which needs the Playwright provider installed.
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

import * as Schema from "effect/Schema";
import type {
  TestProjectInlineConfiguration,
  TestUserConfig,
} from "vite-plus/test/config";

import { testRunDirectory } from "#rigging/core/test-runs.ts";

/** A Vitest project's `test` options: what each preset's `test` argument overrides. */
export type ProjectTest = NonNullable<TestProjectInlineConfiguration["test"]>;

/**
 * The glob for `server.watch.ignored`: test runs write their results into `.test-results/`, and
 * a watched write full-reloads every open app page mid-test.
 */
export const TEST_RESULTS_GLOB = "**/.test-results/**";

/**
 * The root `test` options: half the cores, and under Vitest, this run's `results.json` and
 * attachments in its own `.test-results/test/<start time>/` directory. Outside Vitest (`vp build`,
 * `vp dev`) it makes no run directory.
 */
export const testRun = (root: string = process.cwd()): TestUserConfig => {
  if (process.env.VITEST !== "true") return { maxWorkers: "50%" };
  const run = testRunDirectory("test", [], root);
  return {
    maxWorkers: "50%",
    reporters: ["default", ["json", { outputFile: `${run}/results.json` }]],
    attachmentsDir: `${run}/attachments`,
  };
};

/** Pure code in Node. `test` replaces any of the preset's fields. */
export const unitProject = (
  test: ProjectTest = {},
): TestProjectInlineConfiguration => ({
  test: { name: "unit", include: ["test/unit/**/*.test.ts"], ...test },
});

const ServerStatus = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    port: Schema.NullOr(Schema.Number),
    url: Schema.NullOr(Schema.String),
  }),
);

/**
 * The running server `name` of the app at `root`, from `rigging server status`. It throws when
 * the server is not running, naming its state and `start`, the app's command that starts it
 * (default `vp run dev` for `dev`, else `vp run <name>:start`), so a Playwright config fails at
 * load instead of every test failing to connect. Synchronous, because Playwright loads its config
 * synchronously.
 */
export const runningServer = (
  name: string,
  root: string = process.cwd(),
  start: string = name === "dev" ? "vp run dev" : `vp run ${name}:start`,
) => {
  const status = spawnSync("rigging", ["server", "status", name], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (status.error !== undefined)
    throw new Error(
      `rigging did not run (${status.error.message}): run Playwright through a package script or vp exec`,
    );
  const { state, port, url } = Schema.decodeUnknownSync(ServerStatus)(
    status.stdout,
  );
  if (state !== "running" || port === null)
    throw new Error(`the ${name} server is ${state}: start it with ${start}`);
  return { port, url, localURL: `http://localhost:${String(port)}` };
};

/**
 * The Playwright base config: specs in `test/e2e/` against the running server `server` (default
 * `e2e`), each run's results kept in `.test-results/e2e/<start time>/`. That directory holds
 * `results.json`, `report/` (`playwright show-report <dir>/report`) and `results/`, each failed
 * test's trace and error context. `results/.last-run.json` carries over, so `--last-failed` works.
 * `results.json` is plain text, and the config unsets `NO_COLOR`, which Node warns about beside the
 * `FORCE_COLOR=1` Playwright gives its workers. On CI it forbids `.only`, retries twice and runs
 * one worker.
 */
export const e2eConfig = ({
  root = process.cwd(),
  server = "e2e",
  start,
}: {
  readonly root?: string;
  readonly server?: string;
  readonly start?: string;
} = {}) => {
  delete process.env.NO_COLOR;
  const run = testRunDirectory("e2e", ["results/.last-run.json"], root);
  if (process.env.TEST_WORKER_INDEX === undefined)
    console.log(`e2e results: ${run}`);
  const ci = Boolean(process.env.CI);
  const results = `${run}/results.json`;
  const reporter: ([string] | [string, Record<string, unknown>])[] = [
    ["list"],
    ["json", { outputFile: results }],
    ["@mw10013/rigging/core/plain-json-reporter", { outputFile: results }],
    ["html", { outputFolder: `${run}/report`, open: "never" }],
  ];
  return {
    testDir: "test/e2e",
    outputDir: `${run}/results`,
    fullyParallel: true,
    forbidOnly: ci,
    retries: ci ? 2 : 0,
    workers: ci ? 1 : undefined,
    reporter,
    use: {
      baseURL: runningServer(server, root, start).localURL,
      trace: "retain-on-failure" as const,
    },
  };
};
