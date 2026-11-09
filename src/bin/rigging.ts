#!/usr/bin/env vpx
/**
 * `rigging <server|stage|logs> ...`: an app's script is `"dev:stop": "rigging server stop dev"`.
 *
 * Each group loads only its own layer, so a project without Alchemy can run `rigging server`.
 * The shebang is `vpx`, not `node`: `stage` imports the app's `stacks/stage-env.ts`, whose
 * imports (`#backend/…`) can reach syntax Node's built-in type stripping refuses.
 *
 * @module
 */
import { runCli } from "#rigging/core/cli.ts";

const [group, ...args] = process.argv.slice(2);

if (group === "server")
  runCli((await import("#rigging/core/server/command.ts")).command, args);
else if (group === "stage")
  runCli((await import("#rigging/cloudflare/deployed-stage.ts")).command, args);
else if (group === "logs")
  runCli((await import("#rigging/cloudflare/logs.ts")).command, args);
else {
  process.stderr.write(
    [
      "usage: rigging <command> [...]",
      "",
      "  server   start, stop, status and logs of this app's local servers",
      "  stage    staging and production deploys on Workers Builds (Cloudflare)",
      "  logs     a deployed stage's Worker logs (Cloudflare)",
      "",
    ].join("\n"),
  );
  process.exitCode = group === undefined || group === "--help" ? 0 : 2;
}
