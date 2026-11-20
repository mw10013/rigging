import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ServerName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/u),
).pipe(Schema.brand("ServerName"));
export type ServerName = typeof ServerName.Type;

export const RunId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}$/u),
).pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

const Pid = Schema.Int.check(Schema.isGreaterThan(0));

export const ServerRecord = Schema.Struct({
  rigging: Schema.Literal(1),
  name: ServerName,
  run: RunId,
  pid: Pid,
  group: Pid,
  startedAt: Schema.String,
  command: Schema.Array(Schema.String),
});
export type ServerRecord = typeof ServerRecord.Type;

export const Endpoint = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  url: Schema.optional(Schema.String),
});
export type Endpoint = typeof Endpoint.Type;

export const ServerRecordJson = Schema.fromJsonString(ServerRecord);
export const EndpointJson = Schema.fromJsonString(Endpoint);

export const SERVERS_DIRECTORY = ".rigging/servers";

export const files = (name: ServerName) => ({
  directory: `${SERVERS_DIRECTORY}/${name}`,
  record: `${SERVERS_DIRECTORY}/${name}/record.json`,
  endpoint: `${SERVERS_DIRECTORY}/${name}/endpoint.json`,
  runs: `${SERVERS_DIRECTORY}/${name}/runs`,
});

/** A run's log rolls to `<file>.1` past this size, so one run keeps at most twice it. */
export const RUN_LOG_CAP = ByteSize.mebibytes(50);
export const RUNS_KEPT = 20;
export const RUNS_BYTES = ByteSize.mebibytes(100);

/** ISO instants sort as text, so the names sort by start time. */
export const runLogName = (startedAt: string, run: RunId) =>
  `${startedAt}-${run}.log`;

export const runLog = (
  record: Pick<ServerRecord, "name" | "startedAt" | "run">,
) => `${files(record.name).runs}/${runLogName(record.startedAt, record.run)}`;

export const stamped = (at: DateTime.Utc, line: string) =>
  line === "" ? "" : `${DateTime.formatIso(at)} ${line}`;

const RUN_FILE = /^(?<log>.+\.log)(?:\.1)?$/u;

/**
 * The run files to delete before a new run starts, so that it and the runs kept number at most
 * `RUNS_KEPT` and the kept runs hold at most `RUNS_BYTES`. The newest run is kept whatever its size.
 */
export const expired = (
  files: readonly { readonly name: string; readonly size: ByteSize.ByteSize }[],
): readonly string[] => {
  const runs = new Map<
    string,
    {
      readonly log: string;
      readonly names: readonly string[];
      readonly size: ByteSize.ByteSize;
    }
  >();
  for (const file of files) {
    const log = RUN_FILE.exec(file.name)?.groups?.log;
    if (log === undefined) continue;
    const run = runs.get(log) ?? { log, names: [], size: ByteSize.zero };
    runs.set(log, {
      log,
      names: [...run.names, file.name],
      size: ByteSize.sum(run.size, file.size),
    });
  }
  const deleted: string[] = [];
  let bytes = ByteSize.zero;
  const newestFirst = [...runs.values()].toSorted((a, b) =>
    a.log < b.log ? 1 : -1,
  );
  for (const [index, run] of newestFirst.entries()) {
    bytes = ByteSize.sum(bytes, run.size);
    const kept =
      index < RUNS_KEPT - 1 &&
      (index === 0 || ByteSize.isLessThanOrEqualTo(bytes, RUNS_BYTES));
    if (!kept) deleted.push(...run.names);
  }
  return deleted;
};

const MARKER = "====";

export const startMarker = (
  name: ServerName,
  run: RunId,
  at: string,
  note: Option.Option<string>,
) =>
  [MARKER, name, "start", at, `run=${run}`, ...Option.toArray(note)].join(" ");

export type Ending =
  | { readonly _tag: "Exited"; readonly code: number }
  | { readonly _tag: "Signaled"; readonly signal: string }
  | { readonly _tag: "Interrupted" };

export const exitMarker = (name: ServerName, run: RunId, ending: Ending) =>
  [
    MARKER,
    name,
    "exit",
    `run=${run}`,
    ending._tag === "Exited"
      ? `code=${String(ending.code)}`
      : ending._tag === "Signaled"
        ? `signal=${ending.signal}`
        : "interrupted",
  ].join(" ");

const RUN_OUTPUT_LINES = 60;

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /u;
const START = /^==== \S+ start /u;

export const runOutput = (log: string): Option.Option<string> => {
  const body = log.split("\n").filter((line) => {
    const text = line.replace(STAMP, "");
    return text.trim() !== "" && !START.test(text);
  });
  return body.length === 0
    ? Option.none()
    : Option.some(body.slice(-RUN_OUTPUT_LINES).join("\n"));
};

export type Apply =
  | { readonly _tag: "None" }
  | { readonly _tag: "Applying" }
  | { readonly _tag: "Applied" }
  | {
      readonly _tag: "Failed";
      readonly failure: string;
      readonly diagnostic: string | null;
    };

/**
 * How `alchemy dev` logs each apply. Its `Dev · <stage>` banner, or `Reloading stack:` after a
 * file change, opens one, and a `Done:` or `Failed:` summary closes it. A failed apply, or a
 * failure before any apply, also logs `alchemy dev: … failed; …`, and the process stays up so the
 * resources that did apply keep serving. The Website answers during the apply, so the port says
 * nothing about how the apply ended.
 */
const APPLY_EVENTS: readonly (readonly [RegExp, (text: string) => Apply])[] = [
  [/\] INFO: (?:Dev · \S+$|Reloading stack: )/u, () => ({ _tag: "Applying" })],
  [/\] INFO: Done: \d+ succeeded/u, () => ({ _tag: "Applied" })],
  [
    /Failed: \d+ succeeded.*|alchemy dev: (?:(?:apply|run) failed;|\w+ was interrupted internally) .*/u,
    (failure) => ({ _tag: "Failed", failure, diagnostic: null }),
  ],
];

/**
 * Alchemy logs a failure report as one record, `alchemy dev: … failed; …` and then its cause on
 * the following lines, so the line after the header carries only the runner's stamp and starts
 * with the cause's `<Tag>: <message>`.
 */
const REPORT = /^alchemy dev: (?:apply|run) failed;/u;

/** `[<fqn>] fail (<mode>) — <Tag>: <message> (<elapsed>)`, which a resource logs as it fails. */
const RESOURCE_FAILURE =
  /\] ERROR: \[[^\]]+\] fail(?: \([^)]*\))? — (?<message>.+?)(?: {1,2}\((?:\d+(?:\.\d+)?(?:ms|[smh]) ?)+\))?$/u;

const reportDiagnostic = (line: string) => {
  const text = line.replace(STAMP, "");
  return text === "" || /^[\s[]/u.test(text) || text.startsWith(MARKER)
    ? null
    : text;
};

export const applyOf = (log: string): Apply => {
  let apply: Apply = { _tag: "None" };
  let pendingReport = false;
  let diagnostic: string | null = null;
  let firstResourceFailure: string | null = null;
  for (const line of log.split("\n")) {
    if (pendingReport) {
      diagnostic = reportDiagnostic(line);
      pendingReport = false;
    }
    firstResourceFailure ??=
      RESOURCE_FAILURE.exec(line)?.groups?.message ?? null;
    for (const [pattern, event] of APPLY_EVENTS) {
      const found = pattern.exec(line);
      if (found === null) continue;
      apply = event(found[0]);
      if (apply._tag === "Failed") pendingReport = REPORT.test(found[0]);
      else {
        diagnostic = null;
        firstResourceFailure = null;
      }
    }
  }
  return apply._tag === "Failed"
    ? { ...apply, diagnostic: diagnostic ?? firstResourceFailure }
    : apply;
};

/**
 * Who listens on the server's published port. A command may start its listener detached, in a
 * process group of its own (Alchemy does), so the server is the command and its descendants,
 * not its group. When the command dies first, launchd adopts the listener, which still carries
 * the run's marker in its environment, so it is the server too.
 */
export type PortListener =
  | { readonly _tag: "Free" }
  | { readonly _tag: "Server" }
  | { readonly _tag: "Taken"; readonly pids: readonly number[] };

const MAX_ANCESTRY = 256;

const descends = (
  pid: number,
  ancestor: number,
  parents: ReadonlyMap<number, number>,
) => {
  let current: number | undefined = pid;
  for (let step = 0; current !== undefined && step < MAX_ANCESTRY; step++) {
    if (current === ancestor) return true;
    if (current <= 1) return false;
    current = parents.get(current);
  }
  return false;
};

export const listenerOf = (
  listening: readonly number[],
  parents: ReadonlyMap<number, number>,
  command: number,
  marked: ReadonlySet<number>,
): PortListener => {
  const live = listening.filter((pid) => parents.has(pid));
  if (live.length === 0) return { _tag: "Free" };
  const foreign = live.filter(
    (pid) => !marked.has(pid) && !descends(pid, command, parents),
  );
  return foreign.length === 0
    ? { _tag: "Server" }
    : { _tag: "Taken", pids: foreign };
};

export const ServerState = Schema.Literals([
  "running",
  "starting",
  "degraded",
  "stopped",
  "orphaned",
]);
export type ServerState = typeof ServerState.Type;

export interface Sighting {
  readonly runner: boolean;
  readonly group: boolean;
  readonly answering: boolean;
  readonly apply: Apply;
}

export const stateOf = (
  record: Option.Option<ServerRecord>,
  seen: Sighting,
): ServerState => {
  if (Option.isNone(record)) return "stopped";
  if (!seen.runner) return seen.group ? "orphaned" : "stopped";
  if (seen.apply._tag === "Failed") return "degraded";
  return seen.answering && seen.apply._tag !== "Applying"
    ? "running"
    : "starting";
};
