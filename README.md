# rigging

`@mw10013/rigging` is the house toolkit for Effect, TypeScript and Vite+ projects. The `core`
layer serves any project. The `cloudflare` layer is optional and loads only where an app uses
it. Shopify dev tooling lives in `@mw10013/shopify-app-cloudflare`, which builds on rigging.

```sh
pnpm add -D @mw10013/rigging
```

Import a module by its layer, for example `import { app } from "@mw10013/rigging/core/app"`. The
package manifest, `src/package.json`, lists every export. A module it does not list is internal.

## The `rigging` command

```sh
rigging server start <name> -- <command...>   # run a dev server in the background
rigging server status|stop|logs <name>
rigging server port                           # port=$(rigging server port)
rigging stage up|check|reset <stage>          # Cloudflare: Workers Builds deploys
rigging logs show|follow|wait <stage>         # Cloudflare: a deployed stage's Worker logs
```

`rigging server` works on the nearest folder upward that holds a `package.json`, so each
checkout, and each app in a monorepo, has its own servers. It logs with `s6-log`
(`brew install s6`).

A server picks its own port. The command writes `{"port": <n>, "url": "<optional>"}` to the
file that `$RIGGING_ENDPOINT` names. A Vite server does it with the `serverEndpoint()` plugin
from `core/server-endpoint`.

`start` and `status` print the status JSON. Its `state` is `running`, `starting`, `degraded`,
`stopped` or `orphaned`, and it carries the `port` and `url`. `status` exits 0 when the state is
`running`, and 3 otherwise. A failure prints
`{"rigging": 1, "error": {"_tag", "message"}}` and exits 1. Read the port from
`rigging server status`, never from a remembered value.

State lives in `.rigging/servers/<name>/`, which ignores itself.

## Testing

Apps run Vitest projects `unit`, `browser` and, on Cloudflare, `integ`, plus Playwright specs
against a server that `rigging server` runs. The presets in `core/test`, `core/browser-test`
and `cloudflare/test` each return a plain config object to spread and override. Each run keeps
its results in `.test-results/<test|e2e>/<start time>/`. `fixtures/local` is a working local
app on the presets.

## Developing

```sh
vp install
vp check
vp test run
vp run build        # dist/: the package as published
vp run smoke        # pack, install the tarball into a copy of fixtures/local, run its suites
```

To release, bump the version in the root `package.json` on `main`, then push the tag
`v<version>`. The Publish workflow checks, tests, builds and runs `npm publish`.
