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
  logDirectory: `${SERVERS_DIRECTORY}/${name}/log`,
  log: `${SERVERS_DIRECTORY}/${name}/log/current`,
});

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

/** `s6-log` puts a timestamp before each line, so a marker is found inside the line, not at its start. */
const runLines = (
  log: string,
  name: ServerName,
  run: RunId,
): Option.Option<readonly string[]> => {
  const lines = log.split("\n");
  const start = lines.findIndex(
    (line) =>
      line.includes(`${MARKER} ${name} start `) && line.includes(`run=${run}`),
  );
  if (start === -1) return Option.none();
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) =>
    line.includes(`${MARKER} ${name} exit run=${run} `),
  );
  return Option.some(end === -1 ? after : after.slice(0, end + 1));
};

export const runOutput = (
  log: string,
  name: ServerName,
  run: RunId,
): Option.Option<string> =>
  Option.flatMap(runLines(log, name, run), (lines) => {
    const body = lines.filter((line) => line.trim() !== "");
    return body.length === 0
      ? Option.none()
      : Option.some(body.slice(-RUN_OUTPUT_LINES).join("\n"));
  });

export type Apply =
  | { readonly _tag: "None" }
  | { readonly _tag: "Applying" }
  | { readonly _tag: "Applied" }
  | { readonly _tag: "Failed"; readonly failure: string };

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
    (failure) => ({ _tag: "Failed", failure }),
  ],
];

export const applyOf = (log: string, name: ServerName, run: RunId): Apply => {
  let apply: Apply = { _tag: "None" };
  for (const line of Option.getOrElse(runLines(log, name, run), () => []))
    for (const [pattern, event] of APPLY_EVENTS) {
      const found = pattern.exec(line);
      if (found !== null) apply = event(found[0]);
    }
  return apply;
};

/**
 * Who listens on the server's published port. A command may start its listener detached, in a
 * process group of its own (Alchemy does), so the server is the command and its descendants,
 * not its group.
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

/**
 * Reads the port's listening pids against the process table (`parents`, pid to parent pid). A
 * pid missing from the table exited after it was listed, so it holds nothing.
 */
export const listenerOf = (
  listening: readonly number[],
  parents: ReadonlyMap<number, number>,
  command: number,
): PortListener => {
  const live = listening.filter((pid) => parents.has(pid));
  if (live.length === 0) return { _tag: "Free" };
  const foreign = live.filter((pid) => !descends(pid, command, parents));
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
