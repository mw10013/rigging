import { copyFileSync, readFileSync } from "node:fs";
import * as path from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { build, OUTPUT } from "./build.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as { version: string };

Effect.gen(function* () {
  const built = yield* build(OUTPUT, version);
  for (const file of ["LICENSE", "README.md"])
    copyFileSync(path.join(ROOT, file), path.join(OUTPUT, file));
  yield* Console.error(
    `built @mw10013/rigging ${version} into ${built.directory}`,
  );
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
