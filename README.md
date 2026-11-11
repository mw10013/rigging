# rigging

`@mw10013/rigging` is the house toolkit for Effect, TypeScript and Vite+ projects. `core` serves
any project; `cloudflare` is an optional layer that loads only where an app uses it. Shopify dev
tooling (berth leases, the app's dev and e2e servers, Agent Chrome) lives in
`@mw10013/shopify-app-cloudflare`, which builds on rigging.

Published on npm: https://www.npmjs.com/package/@mw10013/rigging

```sh
pnpm add -D @mw10013/rigging
```

## Layers

- `core`: the app root (`core/app`), the house lint rules (`core/lint/rules`), the test presets
  (`core/test`, `core/browser-test`), per-run test result directories (`core/test-runs`), the
  Playwright reporter that keeps `results.json` plain (`core/plain-json-reporter`), a
  child-process runner (`core/command`) and the Vite plugin that publishes a dev server's port
  (`core/server-endpoint`).
- `cloudflare`: stages and environments (`cloudflare/stage`), Alchemy stack helpers
  (`cloudflare/deployed-stack`), the `integ` test project (`cloudflare/test`) and its setup
  (`cloudflare/integ-setup`).

Import a module by its layer: `import { app } from "@mw10013/rigging/core/app"`. A module the
package manifest (`src/package.json`) does not export is internal.

## The `rigging` command

```sh
rigging server start dev -- vp run dev:serve   # run a dev server in the background
rigging server status|stop|logs dev
rigging server port                            # port=$(rigging server port)
rigging stage up|check|reset <stage>           # Cloudflare: Workers Builds deploys
rigging logs show|follow|wait <stage>          # Cloudflare: a deployed stage's Worker logs
```

`rigging server` rotates each server's log with `s6-log` from s6 (`brew install s6`).

An app calls it from its scripts: `"dev:stop": "rigging server stop dev"`. `docs/server.md` is
the server contract: the `RIGGING_ENDPOINT` handshake, the status JSON and the
`.rigging/servers/<name>/` record a tool may read.

## Testing

Every app runs its tests the same way: Vitest projects `unit` (`test/unit/`), `browser`
(`test/browser/`, headless Chromium) and, for a Cloudflare app, `integ` (`test/integ/`, workerd),
and Playwright specs in `test/e2e/` against a server `rigging server` runs. Each run keeps its
results in `.test-results/<test|e2e>/<start time>/`, and `latest` links to the newest.

Each helper returns a plain config object. Spread it and override any field: a preset's argument
replaces fields of its `test`, and the app adds plugins, `optimizeDeps` and aliases beside the
spread. `core/browser-test` needs `@vitest/browser-playwright`, and Playwright specs need
`playwright`.

A local app, not deployed (`fixtures/local` is one):

```ts
// vite.config.ts
import { browserProject } from "@mw10013/rigging/core/browser-test";
import {
  TEST_RESULTS_GLOB,
  testRun,
  unitProject,
} from "@mw10013/rigging/core/test";

export default defineConfig({
  server: { watch: { ignored: [TEST_RESULTS_GLOB] } },
  test: {
    ...testRun(import.meta.dirname),
    projects: [unitProject(), { ...browserProject(), plugins: [react()] }],
  },
});

// playwright.config.ts: the e2e server is `rigging server start e2e -- vp dev`
import { e2eConfig } from "@mw10013/rigging/core/test";
import { defineConfig } from "playwright/test";

export default defineConfig(e2eConfig({ root: import.meta.dirname }));
```

A Cloudflare app adds `integ`. `testStage` runs only under Vitest:

```ts
import { integProject } from "@mw10013/rigging/cloudflare/test";

projects: [
  unitProject(),
  { ...browserProject({ setupFiles: ["test/browser/setup.ts"] }), plugins: [react()] },
  integProject(() => execFileSync("vpx", ["scripts/stage.ts", "test"], { encoding: "utf8" }).trim()),
],
```

A Shopify app builds on the Cloudflare config. Its e2e preset, with store leases and the embedded
admin, is `@mw10013/shopify-app-cloudflare`, which starts from `e2eConfig` and reads the server's
tunnel with `runningServer("e2e")`:

```ts
const base = e2eConfig({ root: import.meta.dirname });
export default defineConfig({
  ...base,
  use: { ...base.use, channel: "chrome" },
  projects,
});
```

## Developing

```sh
vp install
vp check
vp test run
vp run build        # dist/: the package as published
vp run smoke        # build, pack, install the tarball into a copy of fixtures/local, run its suites
```

The version lives in the root `package.json`. To release, bump it on `main`, then push a tag
`v<version>`: the Publish workflow checks, tests, builds and runs `npm publish`. CI runs the
same checks on every push and pull request.
