import { spawnSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import path from "node:path";

/**
 * This checkout's dev and e2e servers. rigging server runs each (`docs/server.md` in rigging): one
 * Shopify CLI `app dev` per environment, detached, logged to `.rigging/servers/<environment>/log/current`. The
 * CLI picks the port and opens the tunnel; the web command (`dev:alchemy`) publishes both to rigging server,
 * so every script that needs the server asks rigging server where it is ({@link runningServer}).
 *
 * @module
 */
import * as Array from "effect/Array";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { type App, app } from "#rigging/core/app.ts";

import * as Berth from "./berth.ts";
import type { WebEnvironment } from "./web.ts";
import { stage } from "./worktree.ts";

/**
 * Resolvers that hold no negative answer for a tunnel hostname that is not in DNS yet. A new quick
 * tunnel's name is in public DNS by the time the CLI prints it, but a lookup through the system
 * resolver made a moment earlier caches "not found" for the negative TTL (60 s on Cloudflare's
 * resolvers), and every load through the system resolver fails until it expires. So the system
 * resolver is not asked until these have the name.
 */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

/**
 * How long {@link tunnelReady} waits in all: longer than the 60 s negative TTL, so a system lookup
 * made too early by anything else (a browser, the CLI) has expired by the end.
 */
export const TUNNEL_READY_TIMEOUT = Duration.seconds(90);

/**
 * A quick tunnel whose `cloudflared` is gone answers every request with Cloudflare's 530; any other
 * status is the server behind it answering. No answer at all proves nothing either way.
 */
export const tunnelServes = (status: number) => status !== 530;

export const TunnelPhase = Schema.Literals(["resolve", "answer"]);
export type TunnelPhase = typeof TunnelPhase.Type;

export const tunnelErrorMessage = (failure: {
  readonly phase: TunnelPhase;
  readonly url: string;
  readonly lastSeen: string;
  readonly waited: Duration.Duration;
}) => {
  const waited = `${String(Math.round(Duration.toSeconds(failure.waited)))}s`;
  return failure.phase === "resolve"
    ? `the tunnel ${failure.url} does not resolve on public DNS after ${waited} (last: ${failure.lastSeen})`
    : `the tunnel ${failure.url} resolves but / does not answer through it after ${waited} (last: ${failure.lastSeen})`;
};

export class TunnelError extends Schema.TaggedError<TunnelError>()(
  "TunnelError",
  {
    phase: TunnelPhase,
    message: Schema.String,
  },
) {}

const describeCause = (cause: unknown) =>
  cause instanceof Error
    ? "code" in cause && typeof cause.code === "string"
      ? cause.code
      : cause.message
    : String(cause);

const resolvePublic = (hostname: string) =>
  Effect.tryPromise({
    try: () => {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers(PUBLIC_RESOLVERS);
      return resolver.resolve4(hostname);
    },
    catch: describeCause,
  });

const fetchThrough = (url: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(new URL("/", url), {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }),
    catch: describeCause,
  }).pipe(Effect.map((response) => response.status));

export const TunnelState = Schema.Literals([
  "ready",
  "not resolving",
  "not answering",
]);
export type TunnelState = typeof TunnelState.Type;

/** The system resolver is asked (by `fetch`) only once public DNS has the name; see {@link PUBLIC_RESOLVERS}. */
export const tunnelState = Effect.fn("Server.tunnelState")(function* (
  url: string,
) {
  if (Option.isNone(yield* Effect.option(resolvePublic(new URL(url).hostname))))
    return "not resolving" satisfies TunnelState;
  const status = yield* Effect.option(fetchThrough(url));
  return Option.exists(status, tunnelServes)
    ? "ready"
    : ("not answering" satisfies TunnelState);
});

export const tunnelReady = Effect.fn("Server.tunnelReady")(function* (
  url: string,
  timeout: Duration.Duration = TUNNEL_READY_TIMEOUT,
) {
  const started = yield* DateTime.now;
  const elapsed = Effect.map(DateTime.now, (now) =>
    DateTime.distance(started, now),
  );
  const poll = <A>(attempt: Effect.Effect<A, string>, phase: TunnelPhase) =>
    Effect.gen(function* () {
      const remaining = Duration.max(
        Duration.zero,
        Duration.subtract(timeout, yield* elapsed),
      );
      return yield* attempt.pipe(
        Effect.retry(
          Schedule.max([
            Schedule.spaced("1 second"),
            Schedule.during(remaining),
          ]),
        ),
        Effect.catch((error) =>
          Effect.flatMap(elapsed, (waited) =>
            Effect.fail(
              new TunnelError({
                phase,
                message: tunnelErrorMessage({
                  phase,
                  url,
                  lastSeen: error,
                  waited,
                }),
              }),
            ),
          ),
        ),
      );
    });
  yield* poll(resolvePublic(new URL(url).hostname), "resolve");
  yield* poll(
    fetchThrough(url).pipe(
      Effect.filterOrFail(tunnelServes, (status) => `HTTP ${String(status)}`),
    ),
    "answer",
  );
  return yield* elapsed;
});

export class ServerError extends Schema.TaggedError<ServerError>()(
  "ServerError",
  {
    message: Schema.String,
  },
) {}

const fail = (message: string) => new ServerError({ message });

export const START: Record<WebEnvironment, string> = {
  dev: "vp run dev",
  e2e: "vp run e2e:start",
};

export class ServerNotRunningError extends Schema.TaggedError<ServerNotRunningError>()(
  "ServerNotRunningError",
  { environment: Schema.String, message: Schema.String },
) {}

const notRunning = (environment: WebEnvironment) =>
  new ServerNotRunningError({
    environment,
    message: `the ${environment} server is not running: ${START[environment]}`,
  });

export interface Server extends Berth.Lease {
  readonly environment: WebEnvironment;
  readonly stage: string;
}

export const loadServer = Effect.fn("Server.loadServer")(function* (
  environment: WebEnvironment,
) {
  const lease = yield* Berth.acquire(environment).pipe(
    Effect.mapError((error) => fail(error.message)),
  );
  return {
    environment,
    ...lease,
    stage: yield* stage(environment).pipe(
      Effect.mapError((error) => fail(error.message)),
    ),
  } satisfies Server;
});

const ServerState = Schema.Literals([
  "running",
  "starting",
  "stopped",
  "orphaned",
]);

const ServerStatus = Schema.Struct({
  state: ServerState,
  port: Schema.NullOr(Schema.Int),
  url: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  log: Schema.String,
});
export type ServerStatus = typeof ServerStatus.Type;

const ServerFailure = Schema.Struct({
  error: Schema.Struct({ _tag: Schema.String, message: Schema.String }),
});

/**
 * rigging server refused the start: another process holds the port the server published. Shopify CLI
 * probes a free port, releases it and hands it to the web command, which binds it later, so
 * another process can take it in between. A new start gets a new port.
 */
export class PortTakenError extends Schema.TaggedError<PortTakenError>()(
  "PortTakenError",
  { report: Schema.String },
) {
  override get message() {
    return this.report;
  }
}

const decodeServerOutput = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Union([ServerStatus, ServerFailure])),
);

export const serverOutput = (args: readonly string[], stdout: string) => {
  const output = decodeServerOutput(stdout);
  if (Result.isFailure(output))
    return Result.fail(
      fail(
        `rigging server ${args.join(" ")} printed no status; its stderr says why`,
      ),
    );
  const value = output.success;
  if (!("error" in value)) return Result.succeed(value);
  return Result.fail(
    value.error._tag === "PortTakenError"
      ? new PortTakenError({ report: value.error.message })
      : fail(value.error.message),
  );
};

/** Starts after the first whose port was taken. */
const PORT_TAKEN_RETRIES = 2;

/** Starts again while rigging server refuses a start because another process took its port. */
export const retryPortTaken = <A, E, R>(
  start: Effect.Effect<A, E | PortTakenError, R>,
) =>
  start.pipe(
    Effect.tapError((error) =>
      error instanceof PortTakenError
        ? Console.error(`warn  ${error.report}`)
        : Effect.void,
    ),
    Effect.retry({
      while: (error) => error instanceof PortTakenError,
      times: PORT_TAKEN_RETRIES,
    }),
  );

/** The app's own `rigging` bin, so the server runs under the version the app pinned. */
const riggingBin = () => path.join(app().root, "node_modules/.bin/rigging");

const riggingServer = Effect.fn("Server.riggingServer")(function* (
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const notFound = () =>
    fail("rigging server did not run: install @mw10013/rigging in this app");
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(riggingBin(), ["server", ...args], {
        cwd: app().root,
        stdin: "ignore",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.mapError(notFound));
  const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
    Effect.mapError(notFound),
  );
  yield* handle.exitCode.pipe(Effect.mapError(notFound));
  return yield* Effect.fromResult(serverOutput(args, stdout));
}, Effect.scoped);

const serverStatus = (environment: WebEnvironment) =>
  riggingServer(["status", environment]);

export interface RunningServer {
  readonly port: number;
  readonly url: Option.Option<string>;
  readonly startedAt: Option.Option<Date>;
  readonly log: string;
}

export const runningOf = (
  status: ServerStatus,
): Option.Option<RunningServer> =>
  status.state === "running" && status.port !== null
    ? Option.some({
        port: status.port,
        url: Option.filter(Option.fromNullOr(status.url), (url) => url !== ""),
        startedAt: Option.fromNullOr(status.startedAt).pipe(
          Option.map((at) => new Date(at)),
          Option.filter((at) => !Number.isNaN(at.getTime())),
        ),
        log: status.log,
      })
    : Option.none();

export const runningServer = Effect.fn("Server.runningServer")(function* (
  environment: WebEnvironment,
) {
  return yield* Effect.fromOption(
    runningOf(yield* serverStatus(environment)),
  ).pipe(Effect.mapError(() => notRunning(environment)));
});

/**
 * For configs that cannot run an effect (Playwright's). A config passes
 * `app(import.meta.dirname)`, so the status is the config's app's even when another directory
 * loads the config.
 */
export const runningServerSync = (
  environment: WebEnvironment,
  { root }: App = app(),
): RunningServer => {
  const args = ["status", environment];
  const run = spawnSync(riggingBin(), ["server", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (run.error !== undefined)
    throw new Error(
      "rigging server did not run: install @mw10013/rigging in this app",
    );
  const status = Result.getOrThrowWith(
    serverOutput(args, run.stdout),
    (e) => new Error(e.message),
  );
  return Option.getOrThrowWith(
    runningOf(status),
    () => new Error(notRunning(environment).message),
  );
};

/**
 * The app's one config. The e2e lease names another file, which a start writes as a fresh copy of
 * this one: Shopify CLI 5.0 runs one `shopify app dev` per directory and config file name, and the
 * copy keeps one definition of the app.
 */
const APP_CONFIG = "shopify.app.toml";

/**
 * Without `BACKEND_PORT`, the CLI picks the web port itself, and a start whose port another
 * process took in the meantime starts again ({@link PortTakenError}). GraphiQL is off: its server prefers port 3457, so two servers
 * starting at once would both take it and the second would exit with `EADDRINUSE`.
 */
export const startServer = Effect.fn("Server.startServer")(function* (
  server: Server,
) {
  if (server.config !== APP_CONFIG) {
    const fs = yield* FileSystem.FileSystem;
    const { root } = app();
    yield* fs
      .copyFile(path.join(root, APP_CONFIG), path.join(root, server.config))
      .pipe(Effect.mapError((error) => fail(error.message)));
  }
  const status = yield* retryPortTaken(
    riggingServer([
      "start",
      server.environment,
      "--note",
      `stage=${server.stage} store=${server.store}`,
      "--",
      "env",
      `SANDBOX_ENVIRONMENT=${server.environment}`,
      "SHOPIFY_CLI_DISABLE_GRAPHIQL=1",
      "shopify",
      "app",
      "dev",
      "--config",
      server.config,
      "--store",
      server.store,
    ]),
  );
  return yield* Effect.fromOption(runningOf(status)).pipe(
    Effect.mapError(() => notRunning(server.environment)),
  );
});

export const stopServer = Effect.fn("Server.stopServer")(function* (
  environment: WebEnvironment,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(riggingBin(), ["server", "stop", environment], {
        cwd: app().root,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.mapError(() =>
        fail(
          "rigging server did not run: install @mw10013/rigging in this app",
        ),
      ),
    );
  if (code !== ChildProcessSpawner.ExitCode(0))
    return yield* fail(
      `rigging server stop ${environment} exited ${String(code)}`,
    );
});

export const step = Effect.fn("Server.step")(function* <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
) {
  const started = yield* DateTime.now;
  const took = Effect.map(
    DateTime.now,
    (now) =>
      `${Duration.toSeconds(DateTime.distance(started, now)).toFixed(1)}s`,
  );
  const result = yield* effect.pipe(
    Effect.tapError(() =>
      Effect.flatMap(took, (time) => Console.log(`fail  ${label} (${time})`)),
    ),
  );
  yield* Console.log(`ok    ${label} (${yield* took})`);
  return result;
});

const ClientId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const ClientIdLine = Schema.TemplateLiteralParser([
  'client_id = "',
  ClientId,
  '"',
]);
const decodeClientIdLine = Schema.decodeUnknownOption(ClientIdLine);

export const loadClientId = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const toml = yield* fs
    .readFileString(path.join(app().root, "shopify.app.toml"))
    .pipe(Effect.mapError(() => fail("shopify.app.toml is missing")));
  return yield* Effect.fromOption(
    Array.findFirst(toml.split("\n"), (line) =>
      Option.map(decodeClientIdLine(line.trim()), ([, id]) => id),
    ),
  ).pipe(
    Effect.mapError(() =>
      fail('shopify.app.toml has no client_id = "<32 hex>" line'),
    ),
  );
});

export const adminUrl = (store: string, clientId: string) =>
  `https://admin.shopify.com/store/${store}/apps/${clientId}`;

export const describeRunning = Effect.fn("Server.describeRunning")(function* (
  server: Server,
  running: RunningServer,
) {
  const clientId = yield* loadClientId.pipe(Effect.option);
  return [
    `local:   http://localhost:${String(running.port)}`,
    `tunnel:  ${Option.getOrElse(running.url, () => "(none)")}`,
    `app:     ${Option.match(clientId, { onNone: () => "(no client_id in shopify.app.toml)", onSome: (id) => adminUrl(server.store, id) })}`,
    `logs:    ${running.log}`,
  ].join("\n");
});

export const statusReport = Effect.fn("Server.statusReport")(function* (
  server: Server,
) {
  const status = yield* serverStatus(server.environment);
  const running = runningOf(status);
  const tunnel = Option.flatMap(running, (live) => live.url);
  const tunnelSeen = Option.isSome(tunnel)
    ? yield* tunnelState(tunnel.value)
    : null;
  const lines = [
    `state:   ${status.state}`,
    `stage:   ${server.stage}`,
    `store:   ${server.store}`,
    ...(Option.isSome(running)
      ? [
          `started: ${status.startedAt ?? "(unknown)"}`,
          yield* describeRunning(server, running.value),
          `tunnel state: ${tunnelSeen ?? "(no tunnel)"}`,
        ]
      : [`start it: ${START[server.environment]}`]),
  ];
  return {
    running,
    tunnelState: tunnelSeen,
    json: {
      ...status,
      stage: server.stage,
      store: server.store,
      tunnelState: tunnelSeen,
    },
    text: lines.join("\n"),
  };
});
