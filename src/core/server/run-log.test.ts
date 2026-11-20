import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { ServerName } from "./domain.ts";
import { openRunLog, runLogLines } from "./server.ts";

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /u;

const linesOf = (file: string) =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").slice(0, -1)
    : [];

const scratch = () =>
  path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "rigging-run-log-")),
    "run.log",
  );

const name = ServerName.make("dev");

describe("openRunLog", () => {
  it.effect(
    "rolls to .1 before a write would pass the cap, losing and splitting no line",
    () =>
      Effect.gen(function* () {
        const file = scratch();
        const log = yield* openRunLog(file, {
          name,
          cap: ByteSize.bytes(100),
        });
        const written = Array.from(
          { length: 5 },
          (_, index) => `line-${String(index)}`,
        );
        for (const line of written) yield* log.write([line]);

        const earlier = linesOf(`${file}.1`);
        const later = linesOf(file);
        assert.deepStrictEqual(
          earlier.map((line) => line.replace(STAMP, "")),
          ["line-0", "line-1", "line-2"],
        );
        assert.deepStrictEqual(
          later.map((line) => line.replace(STAMP, "")),
          ["line-3", "line-4"],
        );
        for (const line of [...earlier, ...later]) assert.match(line, STAMP);
        assert.isAtMost(fs.statSync(`${file}.1`).size, 100);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "writes a chunk's lines together under one stamp, an empty line empty",
    () =>
      Effect.gen(function* () {
        const file = scratch();
        const log = yield* openRunLog(file, {
          name,
          cap: ByteSize.mebibytes(1),
        });
        yield* log.write(["one", "", "two"]);
        const [one, empty, two] = linesOf(file);
        assert.strictEqual(empty, "");
        assert.strictEqual(one.replace(/one$/u, ""), two.replace(/two$/u, ""));
        assert.match(one, STAMP);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with LogWriteError when the file cannot be opened", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        openRunLog(path.join(scratch(), "missing", "run.log"), {
          name,
          cap: ByteSize.mebibytes(1),
        }),
      );
      assert.strictEqual(error._tag, "LogWriteError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("runLogLines", () => {
  it.live(
    "reads every line once, in order, across rolls, as they are written",
    () =>
      Effect.gen(function* () {
        const file = scratch();
        const log = yield* openRunLog(file, { name, cap: ByteSize.bytes(200) });
        yield* log.write(["line-0"]);
        const written = Array.from(
          { length: 20 },
          (_, index) => `line-${String(index)}`,
        );
        const reading = yield* runLogLines(file, { name }).pipe(
          Stream.takeUntil((line) => line.endsWith("line-19")),
          Stream.runCollect,
          Effect.forkScoped,
        );
        for (const line of written.slice(1)) {
          yield* Effect.sleep(Duration.millis(100));
          yield* log.write([line]);
        }
        const read = yield* Fiber.join(reading);
        assert.isTrue(fs.existsSync(`${file}.1`));
        assert.deepStrictEqual(
          read.map((line) => line.replace(STAMP, "")),
          written,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("starts at the last lines written, and waits for a line's end", () =>
    Effect.gen(function* () {
      const file = scratch();
      fs.writeFileSync(file, "one\ntwo\nthree\nfou");
      const reading = yield* runLogLines(file, { name, last: 2 }).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep(Duration.millis(400));
      fs.appendFileSync(file, "r\n");
      assert.deepStrictEqual(yield* Fiber.join(reading), [
        "two",
        "three",
        "four",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with LogReadError when the file is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runLogLines(scratch(), { name }).pipe(Stream.runHead),
      );
      assert.strictEqual(error._tag, "LogReadError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
