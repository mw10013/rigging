import { randomBytes } from "node:crypto";
import { constants } from "node:os";

import * as ByteSize from "effect/ByteSize";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  type Apply,
  applyOf,
  type Ending,
  EndpointJson,
  exitMarker,
  files,
  isExitLine,
  listenerOf,
  type PortListener,
  RUN_LOG_ROLL_AT,
  runFilesToPrune,
  RunId,
  runLog,
  runOfLog,
  runOutput,
  type ServerName,
  type ServerRecord,
  ServerRecordJson,
  SERVERS_DIRECTORY,
  type ServerState,
  stamped,
  stampOf,
  startMarker,
  stateOf,
  textOf,
} from "./domain.ts";

export const START_TIMEOUT = Duration.minutes(3);
const RECORD_TIMEOUT = Duration.seconds(30);
const STOP_TIMEOUT = Duration.seconds(30);
const POLL = Duration.millis(500);
const ANSWER_TIMEOUT = Duration.seconds(10);
/**
 * How long the run's processes outside the command's group get after SIGTERM before SIGKILL. A whole
 * graceful `alchemy dev` stop, sidecar and workerd included, takes about a second; 2 seconds keeps the
 * runner's cleanup inside the 5 seconds `stopRecorded` allows after SIGKILL.
 */
const MARKED_STOP_TIMEOUT = Duration.seconds(2);

export class ServerExitedError extends Schema.TaggedError<ServerExitedError>()(
  "ServerExitedError",
  { name: Schema.String, run: Schema.String, output: Schema.String },
) {
  override get message() {
    return `the ${this.name} server exited before it answered (run ${this.run})\n${this.output}`;
  }
}

export class StartTimeoutError extends Schema.TaggedError<StartTimeoutError>()(
  "StartTimeoutError",
  {
    name: Schema.String,
    run: Schema.String,
    seconds: Schema.Number,
    output: Schema.String,
  },
) {
  override get message() {
    return `the ${this.name} server did not answer within ${String(this.seconds)}s (run ${this.run}); it is still running\n${this.output}`;
  }
}

export class ServerDegradedError extends Schema.TaggedError<ServerDegradedError>()(
  "ServerDegradedError",
  {
    name: Schema.String,
    run: Schema.String,
    failure: Schema.String,
    diagnostic: Schema.NullOr(Schema.String),
    log: Schema.String,
  },
) {
  override get message() {
    return `the ${this.name} server logged a failure (run ${this.run}); it is still running\n${this.diagnostic ?? this.failure}\nsee ${this.log}`;
  }
}

export class PortTakenError extends Schema.TaggedError<PortTakenError>()(
  "PortTakenError",
  {
    name: Schema.String,
    run: Schema.String,
    port: Schema.Int,
    holders: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `port ${String(this.port)}, which the ${this.name} server published, is held by another process, so the server was stopped (run ${this.run}):\n${this.holders.join("\n")}`;
  }
}

export class ToolMissingError extends Schema.TaggedError<ToolMissingError>()(
  "ToolMissingError",
  { program: Schema.String },
) {
  override get message() {
    return `${this.program} is not on PATH; rigging server needs ps and lsof (on Arch: pacman -S lsof)`;
  }
}

export class StopTimeoutError extends Schema.TaggedError<StopTimeoutError>()(
  "StopTimeoutError",
  { name: Schema.String, group: Schema.Int },
) {
  override get message() {
    return `the ${this.name} server's process group ${String(this.group)} survived SIGKILL`;
  }
}

export class NoRunLogError extends Schema.TaggedError<NoRunLogError>()(
  "NoRunLogError",
  { name: Schema.String, run: Schema.Option(Schema.String) },
) {
  override get message() {
    return Option.match(this.run, {
      onNone: () => `no run of the ${this.name} server has logged yet`,
      onSome: (run) => `the ${this.name} server has no log of run ${run}`,
    });
  }
}

export class LogWriteError extends Schema.TaggedError<LogWriteError>()(
  "LogWriteError",
  { name: Schema.String, path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `could not write ${this.path}, the ${this.name} server's log`;
  }
}

export const openRunLog = Effect.fn("Server.openRunLog")(function* (
  path: string,
  options: { readonly name: ServerName; readonly cap: ByteSize.ByteSize },
) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const failed = (cause: unknown) =>
    new LogWriteError({ name: options.name, path, cause });
  const openFile = Effect.gen(function* () {
    const handle = yield* Scope.fork(scope);
    const file = yield* fs
      .open(path, { flag: "a" })
      .pipe(Scope.provide(handle));
    return { handle, file, size: (yield* file.stat).size };
  });
  const current = yield* Ref.make(
    yield* openFile.pipe(Effect.mapError(failed)),
  );
  const encoder = new TextEncoder();
  const writing = yield* Semaphore.make(1);
  const write = (lines: readonly string[]) =>
    Effect.gen(function* () {
      const at = yield* DateTime.now;
      const chunk = encoder.encode(
        lines.map((line) => `${stamped(at, line)}\n`).join(""),
      );
      const length = ByteSize.bytes(chunk.length);
      let open = yield* Ref.get(current);
      if (
        ByteSize.isGreaterThan(open.size, ByteSize.zero) &&
        ByteSize.isGreaterThan(ByteSize.sum(open.size, length), options.cap)
      ) {
        yield* fs.rename(path, `${path}.1`);
        yield* Scope.close(open.handle, Exit.void);
        open = yield* openFile;
      }
      yield* open.file.writeAll(chunk);
      yield* Ref.set(current, {
        ...open,
        size: ByteSize.sum(open.size, length),
      });
    }).pipe(Effect.mapError(failed), Semaphore.withPermit(writing));
  return { write };
});

export class LogReadError extends Schema.TaggedError<LogReadError>()(
  "LogReadError",
  { name: Schema.String, path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `could not read ${this.path}, the ${this.name} server's log`;
  }
}

const LOG_POLL = Duration.millis(250);
const LOG_READ_SIZE = 64 * 1024;

export const runLogLines = (
  path: string,
  options: { readonly name: ServerName; readonly last?: number },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scope = yield* Scope.Scope;
      const openFile = Effect.gen(function* () {
        const handle = yield* Scope.fork(scope);
        const file = yield* fs.open(path).pipe(Scope.provide(handle));
        return { handle, file, ino: (yield* file.stat).ino };
      });
      const current = yield* Ref.make(yield* openFile);
      const partial = yield* Ref.make("");
      const decoder = new TextDecoder();
      const drain = (file: FileSystem.File) =>
        Effect.gen(function* () {
          let text = "";
          while (true) {
            const bytes = yield* file.readAlloc(LOG_READ_SIZE);
            if (Option.isNone(bytes)) return text;
            text += decoder.decode(bytes.value, { stream: true });
          }
        });
      const followRoll = Effect.gen(function* () {
        const open = yield* Ref.get(current);
        const now = yield* fs.stat(path).pipe(Effect.option);
        if (
          Option.isNone(now) ||
          Option.getOrUndefined(now.value.ino) ===
            Option.getOrUndefined(open.ino)
        )
          return "";
        const rest = yield* drain(open.file);
        yield* Scope.close(open.handle, Exit.void);
        const next = yield* openFile;
        yield* Ref.set(current, next);
        return rest + (yield* drain(next.file));
      });
      const poll = Effect.gen(function* () {
        const open = yield* Ref.get(current);
        const text = (yield* drain(open.file)) + (yield* followRoll);
        const lines = `${yield* Ref.get(partial)}${text}`.split("\n");
        yield* Ref.set(partial, lines.pop() ?? "");
        return lines;
      });
      const last = options.last ?? Number.POSITIVE_INFINITY;
      return Stream.concat(
        Stream.fromIterableEffect(
          poll.pipe(
            Effect.map((lines) =>
              lines.slice(Math.max(lines.length - last, 0)),
            ),
          ),
        ),
        Stream.fromEffectSchedule(poll, Schedule.spaced(LOG_POLL)).pipe(
          Stream.flattenIterable,
        ),
      );
    }),
  ).pipe(
    Stream.mapError(
      (cause) => new LogReadError({ name: options.name, path, cause }),
    ),
  );

const at = Effect.fn("Server.at")(function* (root: string, relative: string) {
  const path = yield* Path.Path;
  return path.join(root, relative);
});

const newRunId = () => RunId.make(randomBytes(4).toString("hex"));

/** Sends `signal` to a pid, or to a process group when `pid` is negative. */
const signal = (pid: number, name: NodeJS.Signals | 0) =>
  Effect.try(() => process.kill(pid, name)).pipe(
    Effect.option,
    Effect.map(Option.isSome),
  );

const groupAlive = (group: number) => signal(-group, 0);

/**
 * A command's output, or "" when it fails to run. A missing `ps` or `lsof` fails instead: read as
 * "", it hides every listener, so `start` waits out its timeout for a port it cannot see.
 */
const output = Effect.fn("Server.output")(function* (
  program: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(ChildProcess.make(program, args, { stdin: "ignore" }))
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.fail(new ToolMissingError({ program }))
          : Effect.succeed(""),
      ),
    );
});

/** Fails before `start` launches anything, which a lookup's failure mid-start would leave running. */
const toolsPresent = Effect.all(
  [output("ps", ["-p", String(process.pid)]), output("lsof", ["-v"])],
  { discard: true },
);

const commandLine = Effect.fn("Server.commandLine")(function* (pid: number) {
  const text = yield* output("ps", ["-o", "command=", "-p", String(pid)]);
  return text.trim();
});

const numbers = (text: string) =>
  text
    .split("\n")
    .flatMap((line) => line.trim().split(/\s+/u))
    .filter((field) => field !== "")
    .map(Number);

/** Every pid listening on TCP `port`, on any address. `lsof` prints nothing when none does. */
const listeningPids = (port: number) =>
  output("lsof", ["-nP", "-t", `-iTCP:${String(port)}`, "-sTCP:LISTEN"]).pipe(
    Effect.map(numbers),
  );

const processTable = output("ps", ["-A", "-o", "pid=,ppid="]).pipe(
  Effect.map((text) => {
    const fields = numbers(text);
    const parents = new Map<number, number>();
    for (let index = 0; index + 1 < fields.length; index += 2)
      parents.set(fields[index], fields[index + 1]);
    return parents;
  }),
);

const markedPids = (run: RunId, pids?: readonly number[]) =>
  output(
    "ps",
    pids === undefined
      ? ["axe", "-o", "pid=,command="]
      : ["e", "-o", "pid=,command=", "-p", pids.join(",")],
  ).pipe(
    Effect.map((text) => {
      const marker = `RIGGING_RUN=${run}`;
      const marked = new Set<number>();
      for (const line of text.split("\n")) {
        const [pid, ...words] = line.trim().split(/\s+/u);
        if (words.includes(marker)) marked.add(Number(pid));
      }
      return marked;
    }),
  );

/**
 * Ends every other process that carries the run's marker. Alchemy's sidecar and its workerd leave the
 * command's group and outlive a SIGKILL of it, holding the local databases locked.
 */
const endMarked = Effect.fn("Server.endMarked")(function* (run: RunId) {
  const others = markedPids(run).pipe(
    Effect.map((pids) => [...pids].filter((pid) => pid !== process.pid)),
  );
  const signalAll = (name: NodeJS.Signals) =>
    others.pipe(
      Effect.flatMap((pids) =>
        Effect.forEach(pids, (pid) => signal(pid, name), { discard: true }),
      ),
    );
  const none = others.pipe(Effect.map((pids) => pids.length === 0));
  if (yield* none) return;
  yield* signalAll("SIGTERM");
  if (!(yield* waitUntil(none, MARKED_STOP_TIMEOUT)))
    yield* signalAll("SIGKILL");
});

const portListener = Effect.fn("Server.portListener")(function* (
  port: number,
  record: ServerRecord,
) {
  const listening = yield* listeningPids(port);
  if (listening.length === 0) return { _tag: "Free" } satisfies PortListener;
  return listenerOf(
    listening,
    yield* processTable,
    record.group,
    yield* markedPids(record.run, listening),
  );
});

const holderOf = Effect.fn("Server.holderOf")(function* (pid: number) {
  const cwd = (yield* output("lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ]))
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return `pid ${String(pid)} (${(yield* commandLine(pid)).slice(0, 120)})${cwd === undefined ? "" : ` in ${cwd}`}`;
});

const runnerAlive = Effect.fn("Server.runnerAlive")(function* (
  record: ServerRecord,
) {
  if (!(yield* signal(record.pid, 0))) return false;
  return (yield* commandLine(record.pid)).includes(`--run ${record.run}`);
});

const readFile = Effect.fn("Server.readFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.option);
});

const readRecord = Effect.fn("Server.readRecord")(function* (
  root: string,
  name: ServerName,
) {
  const text = yield* readFile(yield* at(root, files(name).record));
  return Option.flatMap(text, Schema.decodeUnknownOption(ServerRecordJson));
});

const readEndpoint = Effect.fn("Server.readEndpoint")(function* (
  root: string,
  name: ServerName,
) {
  const text = yield* readFile(yield* at(root, files(name).endpoint));
  return Option.flatMap(text, Schema.decodeUnknownOption(EndpointJson));
});

const answering = (port: number) =>
  Effect.tryPromise(() =>
    fetch(`http://localhost:${String(port)}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(Duration.toMillis(ANSWER_TIMEOUT)),
    }),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.promise(() => response.body?.cancel() ?? Promise.resolve()),
    ),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const writeAtomic = Effect.fn("Server.writeAtomic")(function* (
  file: string,
  text: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${file}.${String(process.pid)}.tmp`;
  yield* fs.writeFileString(temporary, text);
  yield* fs.rename(temporary, file);
});

const removeFiles = Effect.fn("Server.removeFiles")(function* (
  root: string,
  name: ServerName,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of [files(name).record, files(name).endpoint])
    yield* fs
      .remove(yield* at(root, file), { force: true })
      .pipe(Effect.ignore);
});

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeout: Duration.Duration,
) =>
  Effect.gen(function* () {
    const deadline = DateTime.addDuration(yield* DateTime.now, timeout);
    while (!(yield* check)) {
      if (DateTime.isGreaterThan(yield* DateTime.now, deadline)) return false;
      yield* Effect.sleep(POLL);
    }
    return true;
  });

const runNames = Effect.fn("Server.runNames")(function* (
  root: string,
  name: ServerName,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readDirectory(yield* at(root, files(name).runs))
    .pipe(Effect.orElseSucceed((): string[] => []));
});

const newestRunLog = Effect.fn("Server.newestRunLog")(function* (
  root: string,
  name: ServerName,
) {
  const newest = (yield* runNames(root, name))
    .filter((file) => file.endsWith(".log"))
    .toSorted()
    .at(-1);
  return Option.map(
    Option.fromNullishOr(newest),
    (file) => `${files(name).runs}/${file}`,
  );
});

const recordedOrNewestRunLog = (
  root: string,
  name: ServerName,
  record: Option.Option<ServerRecord>,
) =>
  Option.match(record, {
    onSome: (found) => Effect.succeed(Option.some(runLog(found))),
    onNone: () => newestRunLog(root, name),
  });

const removePrunable = Effect.fn("Server.removePrunable")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sized = yield* Effect.forEach(
    yield* fs.readDirectory(directory),
    (name) =>
      fs
        .stat(path.join(directory, name))
        .pipe(Effect.map((info) => ({ name, size: info.size }))),
  );
  yield* Effect.forEach(
    runFilesToPrune(sized),
    (name) => fs.remove(path.join(directory, name), { force: true }),
    { discard: true },
  );
});

const lines = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.splitLines);

/** Node's message for a command a signal ended, which Effect's `exitCode` fails with. */
const SIGNALED = /receipt of signal: '(?<signal>SIG[A-Z0-9]+)'/u;

/**
 * How the command ended. A command that does not catch SIGTERM, Vite under `vp` for one, ends by
 * the signal with no exit code, which is a normal stop, not a runner failure.
 */
const endingOf = (child: ChildProcessSpawner.ChildProcessHandle) =>
  child.exitCode.pipe(
    Effect.map((code): Ending => ({ _tag: "Exited", code: Number(code) })),
    Effect.catch((error) => {
      const signal = SIGNALED.exec(String(error.cause))?.groups?.signal;
      return signal === undefined
        ? Effect.fail(error)
        : Effect.succeed<Ending>({ _tag: "Signaled", signal });
    }),
  );

export const run = Effect.fn("Server.run")(function* (
  root: string,
  name: ServerName,
  runId: RunId,
  note: Option.Option<string>,
  command: readonly [string, ...string[]],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const runs = yield* at(root, files(name).runs);
  yield* fs.makeDirectory(runs, { recursive: true });
  yield* fs.writeFileString(
    yield* at(root, `${SERVERS_DIRECTORY}/.gitignore`),
    "*\n",
  );
  yield* fs.remove(yield* at(root, files(name).legacyLog), {
    recursive: true,
    force: true,
  });
  yield* removeFiles(root, name);
  yield* removePrunable(runs);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const log = yield* openRunLog(
    yield* at(root, runLog({ name, startedAt, run: runId })),
    { name, cap: RUN_LOG_ROLL_AT },
  );
  yield* log.write([startMarker(name, runId, startedAt, note)]);

  const [program, ...args] = command;
  const child = yield* spawner.spawn(
    ChildProcess.make(program, args, {
      cwd: root,
      env: {
        RIGGING_ENDPOINT: yield* at(root, files(name).endpoint),
        RIGGING_RUN: runId,
        FORCE_COLOR: undefined,
        NO_COLOR: "1",
        // Each hides the apply lines `applyOf` reads; a flag in the command still can.
        ALCHEMY_LOG_FORMAT: undefined,
        ALCHEMY_LOG_LEVEL: undefined,
      },
      extendEnv: true,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const group = Number(child.pid);
  const pumping = yield* Stream.merge(
    lines(child.stdout),
    lines(child.stderr),
  ).pipe(Stream.runForEachArray(log.write), Effect.forkScoped);
  yield* writeAtomic(
    yield* at(root, files(name).record),
    Schema.encodeSync(ServerRecordJson)({
      rigging: 1,
      name,
      run: runId,
      pid: process.pid,
      group,
      startedAt,
      command,
    }),
  );

  const stopGroup = Effect.gen(function* () {
    yield* signal(-group, "SIGTERM");
    if (
      !(yield* waitUntil(
        groupAlive(group).pipe(Effect.map((alive) => !alive)),
        STOP_TIMEOUT,
      ))
    )
      yield* signal(-group, "SIGKILL");
  });
  const finish = (ending: Ending) =>
    endMarked(runId).pipe(
      Effect.andThen(Fiber.join(pumping)),
      Effect.ignore,
      Effect.andThen(
        log.write([exitMarker(name, runId, ending)]).pipe(Effect.ignore),
      ),
      Effect.andThen(removeFiles(root, name)),
    );

  const ending = yield* Effect.raceFirst(
    endingOf(child),
    Fiber.join(pumping).pipe(
      Effect.andThen(Effect.never),
      Effect.catch((error) =>
        stopGroup.pipe(Effect.andThen(Effect.fail(error))),
      ),
    ),
  ).pipe(
    Effect.onInterrupt(() =>
      stopGroup.pipe(
        Effect.andThen(finish({ _tag: "Interrupted" })),
        Effect.ignore,
      ),
    ),
    Effect.tapError(() => removeFiles(root, name)),
  );
  // The command's children can outlive it and hold its pipes open.
  if (yield* groupAlive(group)) yield* stopGroup;
  yield* finish(ending);
  return ending._tag === "Exited"
    ? ending.code
    : ending._tag === "Signaled"
      ? 128 + (constants.signals[ending.signal as NodeJS.Signals] ?? 0)
      : 130;
}, Effect.scoped);

export interface StatusJson {
  readonly rigging: 1;
  readonly name: string;
  readonly state: ServerState;
  readonly run: string | null;
  readonly pid: number | null;
  readonly group: number | null;
  readonly startedAt: string | null;
  readonly port: number | null;
  readonly url: string | null;
  readonly failure: string | null;
  readonly diagnostic: string | null;
  readonly log: string | null;
}

const sight = Effect.fn("Server.sight")(function* (
  root: string,
  name: ServerName,
) {
  const record = yield* readRecord(root, name);
  const endpoint = yield* readEndpoint(root, name);
  const listener: PortListener =
    Option.isSome(record) && Option.isSome(endpoint)
      ? yield* portListener(endpoint.value.port, record.value)
      : { _tag: "Free" };
  const apply: Apply = Option.isNone(record)
    ? { _tag: "None" }
    : Option.match(yield* readFile(yield* at(root, runLog(record.value))), {
        onNone: () => ({ _tag: "None" }),
        onSome: applyOf,
      });
  const seen = Option.isNone(record)
    ? { runner: false, group: false, answering: false, apply }
    : {
        apply,
        runner: yield* runnerAlive(record.value),
        group: yield* groupAlive(record.value.group),
        answering:
          listener._tag === "Server" && Option.isSome(endpoint)
            ? yield* answering(endpoint.value.port)
            : false,
      };
  const state = stateOf(record, seen);
  const live = state !== "stopped";
  const recorded = live ? Option.getOrUndefined(record) : undefined;
  const published = live ? Option.getOrUndefined(endpoint) : undefined;
  const failed =
    state === "degraded" && apply._tag === "Failed" ? apply : undefined;
  const status: StatusJson = {
    rigging: 1,
    name,
    state,
    run: recorded?.run ?? null,
    pid: recorded?.pid ?? null,
    group: recorded?.group ?? null,
    startedAt: recorded?.startedAt ?? null,
    port: published?.port ?? null,
    url: published?.url ?? null,
    failure: failed?.failure ?? null,
    diagnostic: failed?.diagnostic ?? null,
    log: Option.getOrNull(yield* recordedOrNewestRunLog(root, name, record)),
  };
  return { status, listener };
});

export const status = (root: string, name: ServerName) =>
  sight(root, name).pipe(Effect.map(({ status }) => status));

const runLogOf = Effect.fn("Server.runLogOf")(function* (
  root: string,
  name: ServerName,
  runId: RunId,
) {
  const file = (yield* runNames(root, name)).find((found) =>
    found.endsWith(`-${runId}.log`),
  );
  return Option.map(
    Option.fromNullishOr(file),
    (found) => `${files(name).runs}/${found}`,
  );
});

const runOutputOf = Effect.fn("Server.runOutputOf")(function* (
  root: string,
  name: ServerName,
  runId: RunId,
) {
  const found = yield* runLogOf(root, name, runId);
  if (Option.isNone(found))
    return `(run ${runId} wrote nothing to ${files(name).runs})`;
  const log = found.value;
  return Option.match(
    Option.flatMap(yield* readFile(yield* at(root, log)), runOutput),
    {
      onNone: () => `(run ${runId} wrote nothing to ${log})`,
      onSome: (output) => `--- ${log} ---\n${output}\n---`,
    },
  );
});

const waitAnswering = Effect.fn("Server.waitAnswering")(function* (
  root: string,
  name: ServerName,
  runId: RunId,
  timeout: Duration.Duration,
) {
  const deadline = DateTime.addDuration(yield* DateTime.now, timeout);
  while (true) {
    const { status: now, listener } = yield* sight(root, name);
    if (now.state === "running") return now;
    if (now.failure !== null && now.run === runId)
      return yield* new ServerDegradedError({
        name,
        run: runId,
        failure: now.failure,
        diagnostic: now.diagnostic,
        log: now.log ?? files(name).runs,
      });
    if (listener._tag === "Taken" && now.run === runId && now.port !== null) {
      const holders = yield* Effect.forEach(listener.pids, holderOf);
      const record = yield* readRecord(root, name);
      if (Option.isSome(record)) yield* stopRecorded(root, name, record.value);
      return yield* new PortTakenError({
        name,
        run: runId,
        port: now.port,
        holders,
      });
    }
    if (now.state !== "starting" || now.run !== runId) {
      return yield* new ServerExitedError({
        name,
        run: runId,
        output: yield* runOutputOf(root, name, runId),
      });
    }
    if (DateTime.isGreaterThan(yield* DateTime.now, deadline))
      return yield* new StartTimeoutError({
        name,
        run: runId,
        seconds: Duration.toSeconds(timeout),
        output: yield* runOutputOf(root, name, runId),
      });
    yield* Effect.sleep(Duration.seconds(1));
  }
});

const stopRecorded = Effect.fn("Server.stopRecorded")(function* (
  root: string,
  name: ServerName,
  record: ServerRecord,
) {
  yield* signal(-record.group, "SIGTERM");
  const gone = Effect.all([groupAlive(record.group), runnerAlive(record)]).pipe(
    Effect.map(([group, runner]) => !group && !runner),
  );
  if (!(yield* waitUntil(gone, STOP_TIMEOUT))) {
    yield* Console.error(
      `warn  process group ${String(record.group)} ignored SIGTERM for ${String(Duration.toSeconds(STOP_TIMEOUT))}s; sending SIGKILL`,
    );
    yield* signal(-record.group, "SIGKILL");
    if (!(yield* waitUntil(gone, Duration.seconds(5))))
      return yield* new StopTimeoutError({ name, group: record.group });
  }
  yield* endMarked(record.run);
  yield* removeFiles(root, name);
});

export const start = Effect.fn("Server.start")(function* (
  root: string,
  name: ServerName,
  command: readonly [string, ...string[]],
  options: {
    readonly note: Option.Option<string>;
    readonly timeout: Duration.Duration;
  },
) {
  const { note, timeout } = options;
  yield* toolsPresent;
  const record = yield* readRecord(root, name);
  if (Option.isSome(record)) {
    const now = yield* status(root, name);
    if (
      now.state === "running" ||
      now.state === "starting" ||
      now.state === "degraded"
    ) {
      yield* Console.error(
        `ok    adopted the running ${name} server (pid ${String(record.value.pid)}, run ${record.value.run})`,
      );
      return yield* waitAnswering(root, name, record.value.run, timeout);
    }
    if (now.state === "orphaned") {
      yield* Console.error(
        `ok    stopping the orphaned ${name} server (group ${String(record.value.group)})`,
      );
      yield* stopRecorded(root, name, record.value);
    } else {
      yield* endMarked(record.value.run);
      yield* removeFiles(root, name);
    }
  }

  const runId = newRunId();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runner = yield* spawner.spawn(
    ChildProcess.make(
      "vpx",
      [
        process.argv[1] ?? "rigging",
        "server",
        "run",
        name,
        "--run",
        runId,
        ...Option.match(note, {
          onNone: () => [],
          onSome: (text) => ["--note", text],
        }),
        "--",
        ...command,
      ],
      {
        cwd: root,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    ),
  );
  // The spawner kills a referenced child when the scope closes.
  yield* runner.unref;
  const recorded = readRecord(root, name).pipe(
    Effect.map((found) => Option.exists(found, (value) => value.run === runId)),
  );
  if (!(yield* waitUntil(recorded, RECORD_TIMEOUT)))
    return yield* new ServerExitedError({
      name,
      run: runId,
      output: yield* runOutputOf(root, name, runId),
    });
  yield* Console.error(`ok    started the ${name} server (run ${runId})`);
  return yield* waitAnswering(root, name, runId, timeout);
}, Effect.scoped);

export const stop = Effect.fn("Server.stop")(function* (
  root: string,
  name: ServerName,
) {
  const record = yield* readRecord(root, name);
  if (Option.isNone(record)) {
    yield* Console.error(`ok    no ${name} server running`);
    return false;
  }
  yield* stopRecorded(root, name, record.value);
  yield* Console.error(`ok    stopped the ${name} server`);
  return true;
});

export class LogWaitTimeoutError extends Schema.TaggedError<LogWaitTimeoutError>()(
  "LogWaitTimeoutError",
  { name: Schema.String, pattern: Schema.String, seconds: Schema.Number },
) {
  override get message() {
    return `no line of the ${this.name} server's log matched /${this.pattern}/ within ${String(this.seconds)}s`;
  }
}

export class RunEndedError extends Schema.TaggedError<RunEndedError>()(
  "RunEndedError",
  { name: Schema.String, run: Schema.String, exit: Schema.String },
) {
  override get message() {
    return `the ${this.name} server's run ${this.run} ended before a line matched\n${this.exit}`;
  }
}

export type Reading =
  | { readonly _tag: "Print"; readonly lines: number }
  | { readonly _tag: "Follow"; readonly lines: number }
  | {
      readonly _tag: "Wait";
      readonly pattern: RegExp;
      readonly since: DateTime.Utc;
      readonly timeout: Duration.Duration;
    };

export const logs = Effect.fn("Server.logs")(function* (
  root: string,
  name: ServerName,
  options: { readonly run: Option.Option<RunId>; readonly reading: Reading },
) {
  const fs = yield* FileSystem.FileSystem;
  const log = yield* Option.match(options.run, {
    onSome: (runId) => runLogOf(root, name, runId),
    onNone: () =>
      readRecord(root, name).pipe(
        Effect.flatMap((record) => recordedOrNewestRunLog(root, name, record)),
      ),
  });
  const found = Option.flatMap(log, (relative) =>
    Option.map(runOfLog(relative), (runId) => ({ relative, runId })),
  );
  if (Option.isNone(found))
    return yield* new NoRunLogError({ name, run: options.run });
  const { relative, runId } = found.value;
  const path = yield* at(root, relative);
  const { reading } = options;
  if (reading._tag === "Print") {
    const text = yield* fs
      .readFileString(path)
      .pipe(
        Effect.mapError((cause) => new LogReadError({ name, path, cause })),
      );
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines.slice(Math.max(lines.length - reading.lines, 0)))
      yield* Console.log(line);
    return;
  }
  if (reading._tag === "Follow")
    return yield* runLogLines(path, { name, last: reading.lines }).pipe(
      Stream.takeUntil((line) => isExitLine(line, name, runId)),
      Stream.runForEach(Console.log),
    );
  const { pattern, since, timeout } = reading;
  const matched = yield* runLogLines(path, { name }).pipe(
    Stream.filter(
      (candidate) =>
        isExitLine(candidate, name, runId) ||
        (Option.exists(stampOf(candidate), (stamp) =>
          DateTime.isGreaterThanOrEqualTo(stamp, since),
        ) &&
          pattern.test(textOf(candidate))),
    ),
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new LogWaitTimeoutError({
            name,
            pattern: pattern.source,
            seconds: Duration.toSeconds(timeout),
          }),
        ),
    }),
  );
  const line = yield* Effect.orDie(Effect.fromOption(matched));
  if (isExitLine(line, name, runId))
    return yield* new RunEndedError({ name, run: runId, exit: line });
  yield* Console.log(line);
});
