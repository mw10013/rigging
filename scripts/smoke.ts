import * as path from "node:path";
import process from "node:process";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { OUTPUT } from "./build.ts";
import { run, stream } from "./process.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "fixtures/local");
const SKIPPED = new Set(["node_modules", ".test-results", ".rigging"]);

/**
 * `PATH` without the workspace's directories, so the app runs only what it installed: `vp run`
 * puts the workspace's `node_modules/.bin`, and its source-linked `rigging`, on `PATH`.
 */
const APP_ENV = {
  PATH: (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => !entry.startsWith(`${ROOT}${path.sep}`))
    .join(path.delimiter),
};

const inApp = Effect.fn("Smoke.inApp")(function* (scratch: string) {
  const fs = yield* FileSystem.FileSystem;
  const app = path.join(scratch, "local");
  yield* stream(ROOT, "vp", ["run", "build"]);
  const packed = yield* run(ROOT, "npm", [
    "pack",
    OUTPUT,
    "--pack-destination",
    scratch,
  ]);
  const tarball = path.join(scratch, packed.trim().split("\n").at(-1) ?? "");
  yield* fs.makeDirectory(app);
  for (const entry of yield* fs.readDirectory(FIXTURE))
    if (!SKIPPED.has(entry))
      yield* fs.copy(path.join(FIXTURE, entry), path.join(app, entry));
  yield* fs.copyFile(
    path.join(ROOT, "pnpm-workspace.yaml"),
    path.join(app, "pnpm-workspace.yaml"),
  );
  const manifest = JSON.parse(
    yield* fs.readFileString(path.join(app, "package.json")),
  ) as { devDependencies: Record<string, string> };
  const { packageManager } = JSON.parse(
    yield* fs.readFileString(path.join(ROOT, "package.json")),
  ) as { packageManager: string };
  manifest.devDependencies["@mw10013/rigging"] = `file:${tarball}`;
  yield* fs.writeFileString(
    path.join(app, "package.json"),
    `${JSON.stringify({ ...manifest, packageManager }, null, 2)}\n`,
  );
  yield* stream(
    app,
    path.join(ROOT, "node_modules/.bin/vp"),
    ["install"],
    APP_ENV,
  );
  const vp = path.join(app, "node_modules/.bin/vp");
  const inCopy = (args: readonly string[]) => stream(app, vp, args, APP_ENV);
  yield* inCopy(["exec", "playwright", "install", "chromium"]);
  yield* inCopy(["run", "test"]);
  yield* inCopy(["run", "test:e2e"]).pipe(
    Effect.ensuring(Effect.ignore(inCopy(["run", "e2e:stop"]))),
  );
  return path.basename(tarball);
});

const smoke = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const scratch = yield* fs.makeTempDirectory({ prefix: "rigging-smoke-" });
  const tarball = yield* inApp(scratch).pipe(
    Effect.tapError(() =>
      Console.error(`smoke: failed; ${scratch} keeps the app and its results`),
    ),
  );
  yield* fs.remove(scratch, { recursive: true });
  yield* Console.error(`smoke: ${tarball} passed in an app`);
});

smoke.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
