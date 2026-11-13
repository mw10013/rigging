import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { run } from "./process.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
export const SOURCE = path.join(ROOT, "src");
export const OUTPUT = path.join(ROOT, "dist");

const Targets = Schema.Record(Schema.String, Schema.String);
const Source = Schema.Struct({ exports: Targets, bin: Targets });
const decodeSource = Schema.decodeUnknownSync(Source);

const JsonObject = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);
const decodeJsonObject = Schema.decodeUnknownEffect(JsonObject);

const built = (target: string, extension: ".d.mts" | ".mjs") =>
  `./dist/${target.replace(/^\.\//u, "").replace(/\.ts$/u, extension)}`;

export const entriesOf = (source: unknown): readonly string[] => {
  const { exports, bin } = decodeSource(source);
  return [...Object.values(exports), ...Object.values(bin)];
};

/** A bin path has no leading `./`: npm 12 drops such a bin from the package it publishes. */
export const builtManifest = (
  source: Record<string, unknown>,
  version?: string,
) => {
  const { exports, bin } = decodeSource(source);
  const { "//": _note, imports: _imports, private: _private, ...rest } = source;
  return {
    ...rest,
    ...(version === undefined ? {} : { version }),
    exports: Object.fromEntries(
      Object.entries(exports).map(([key, target]) => [
        key,
        { types: built(target, ".d.mts"), default: built(target, ".mjs") },
      ]),
    ),
    bin: Object.fromEntries(
      Object.entries(bin).map(([key, target]) => [
        key,
        built(target, ".mjs").replace(/^\.\//u, ""),
      ]),
    ),
  };
};

/** `vp pack` runs in `src`, so Rolldown reads `src/package.json`'s peer dependencies and leaves them external. */
export const build = Effect.fn("Build.build")(function* (
  outDirectory: string = OUTPUT,
  version?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* decodeJsonObject(
    yield* fs.readFileString(path.join(SOURCE, "package.json")),
  );
  const entries = entriesOf(source);
  yield* fs.remove(outDirectory, { recursive: true, force: true });
  yield* run(SOURCE, path.join(ROOT, "node_modules/.bin/vp"), [
    "pack",
    ...entries,
    "--unbundle",
    "--dts",
    "--root",
    ".",
    "--tsconfig",
    "tsconfig.build.json",
    "--no-config",
    "-d",
    path.join(outDirectory, "dist"),
  ]);
  const manifest = builtManifest(source, version);
  yield* fs.writeFileString(
    path.join(outDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const target of Object.values(manifest.bin))
    yield* fs.chmod(path.join(outDirectory, target), 0o755);
  return { directory: outDirectory, entries: entries.length };
});
