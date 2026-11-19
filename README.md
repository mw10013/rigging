# rigging

`@mw10013/rigging` is the house toolkit for Effect, TypeScript and Vite+ projects. The `core`
layer serves any project. The `cloudflare` layer is optional and loads only where an app uses
it. Shopify dev tooling lives in `@mw10013/shopify-app-cloudflare`, which builds on rigging.

```sh
pnpm add -D @mw10013/rigging
```

Import a module by its layer, for example `import { app } from "@mw10013/rigging/core/app"`. A
module the package's `exports` does not list is internal.

## The `rigging` command

```sh
rigging server start <name> -- <command...>   # run a dev server in the background
rigging server status|stop|logs <name>
rigging server port                           # port=$(rigging server port)
rigging local start <dev|e2e> -- <command...> # Cloudflare: the server on this checkout's stage
rigging local destroy <dev|e2e>               # Cloudflare: stop the server, destroy the stage
rigging stage up|check|reset <stage>          # Cloudflare: Workers Builds deploys
rigging logs show|follow|wait <stage>         # Cloudflare: a deployed stage's Worker logs
```

`rigging server` works on the nearest folder upward that holds a `package.json`, so each
checkout, and each app in a monorepo, has its own servers. It logs with `s6-log`
(`brew install s6`).

A server picks its own port. The command writes `{"port": <n>, "url": "<optional>"}` to the
file that `$RIGGING_ENDPOINT` names. A Vite server does it with the `serverEndpoint()` plugin
from `core/server-endpoint`.

`rigging local` runs this checkout's `dev` and `e2e` stages, named `<environment>-$USER`, so
`$USER` must be lowercase letters and digits. `start` is `rigging server start` with
`ALCHEMY_STAGE` and `SANDBOX_ENVIRONMENT` set in the command's environment, so `alchemy dev`
needs no `--stage`. `destroy` stops the server and runs `alchemy destroy --stage <stage> --yes`;
it succeeds when nothing is left to destroy, so it is safe to rerun. `test` stages belong to the
integ files, which deploy and destroy their own.

## Testing

The presets in `core/test`, `core/browser-test` and `cloudflare/test` each return a plain config
object to spread and override. [`fixtures/local`](https://github.com/mw10013/rigging/tree/main/fixtures/local) is a working
local app on the presets.

## Developing

```sh
vp install
vp check
vp test run
vp run build
vp run smoke
```

To release, bump the version in the root `package.json` on `main`, then push the tag
`v<version>`. The Publish workflow checks, tests, builds and runs `npm publish`.
