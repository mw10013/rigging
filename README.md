# rigging

`@mw10013/rigging` is the house toolkit for Effect, TypeScript and Vite+ projects. `core` serves
any project; `cloudflare` and `shopify` are optional layers that load only where an app uses them.

```sh
pnpm add -D @mw10013/rigging
```

## Layers

- `core`: the app root (`core/app`), the house lint rules (`core/lint/rules`), per-run test
  result directories (`core/test-runs`), a child-process runner (`core/command`) and the Vite
  plugin that publishes a dev server's port (`core/server-endpoint`).
- `cloudflare`: stages and environments (`cloudflare/stage`), Alchemy stack helpers
  (`cloudflare/deployed-stack`) and the integration-test setup (`cloudflare/integ-setup`).
- `shopify`: dev-store leases from berth, the app's dev and e2e servers, Agent Chrome and the
  embedded-app test helpers.

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

An app calls it from its scripts: `"dev:stop": "rigging server stop dev"`. `docs/server.md` is
the server contract: the `RIGGING_ENDPOINT` handshake, the status JSON and the
`.rigging/servers/<name>/` record a tool may read.

## Developing

```sh
vp install
vp check
vp test run
vp run build        # dist/: the package as published
```

The version lives in the root `package.json`. To release, bump it on `main`, then push a tag
`v<version>`: the Publish workflow checks, tests, builds and runs `npm publish`. CI runs the
same checks on every push and pull request.
