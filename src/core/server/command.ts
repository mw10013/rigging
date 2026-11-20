/**
 * The CLI. `start` and `status` print one JSON document on stdout
 * ({@link StatusJson}), versioned by `rigging: 1`; human lines go to stderr. A
 * typed failure prints `{ rigging: 1, error: { _tag, message } }` and exits 1.
 * `status` exits 3 when the server is not running, a degraded server included.
 *
 * @module
 */
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { app, NoAppError } from "#rigging/core/app.ts";
import { command as port } from "#rigging/core/server/port.ts";

import { RunId, ServerName } from "./domain.ts";
import * as Server from "./server.ts";

export const appRoot = Effect.try({
  try: () => app().root,
  catch: (error) =>
    error instanceof NoAppError
      ? error
      : new NoAppError({ directory: process.cwd() }),
});

export const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2));

export const reported = <
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* printJson({
          rigging: 1,
          error: { _tag: error._tag, message: error.message },
        });
        yield* Console.error(`error ${error.message}`);
        process.exitCode = 1;
      }),
    ),
  );

const name = Argument.String("name").pipe(
  Argument.withSchema(ServerName),
  Argument.withDescription("The server's name in this checkout, e.g. dev"),
);

export const commandArguments = Argument.String("command").pipe(
  Argument.atLeast(1),
  Argument.withDescription("The server's command and its arguments, after --"),
);

const note = Flag.String("note").pipe(
  Flag.optional,
  Flag.withDescription("Extra text for the log's start line, e.g. store=x"),
);

const start = Command.make(
  "start",
  {
    name,
    note,
    timeout: Flag.Int("timeout").pipe(
      Flag.withDefault(Duration.toSeconds(Server.START_TIMEOUT)),
      Flag.withDescription("Seconds to wait for the server to answer"),
    ),
    command: commandArguments,
  },
  ({ name, note, timeout, command }) =>
    reported(
      Effect.gen(function* () {
        const root = yield* appRoot;
        const [program, ...args] = command;
        yield* printJson(
          yield* Server.start(root, name, [program, ...args], {
            note,
            timeout: Duration.seconds(timeout),
          }),
        );
      }),
    ),
).pipe(
  Command.withShortDescription(
    "Adopt this checkout's running server, or launch it detached; wait until it answers",
  ),
  Command.withExamples([
    {
      command: "rigging server start dev -- vp run dev:serve",
      description: "Start or adopt the dev server",
    },
  ]),
);

const runCommand = Command.make(
  "run",
  {
    name,
    run: Flag.String("run").pipe(
      Flag.withSchema(RunId),
      Flag.withDescription("The run id start passes"),
    ),
    note,
    command: commandArguments,
  },
  ({ name, run, note, command }) =>
    Effect.gen(function* () {
      const root = yield* appRoot;
      const [program, ...args] = command;
      const code = yield* Server.run(root, name, run, note, [program, ...args]);
      process.exitCode = code;
    }),
).pipe(
  Command.withShortDescription(
    "Internal: run a server in the foreground with its log; start launches it",
  ),
);

const stop = Command.make("stop", { name }, ({ name }) =>
  reported(
    Effect.gen(function* () {
      yield* Server.stop(yield* appRoot, name);
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Stop this checkout's server and wait for its exit to be logged",
  ),
);

const status = Command.make("status", { name }, ({ name }) =>
  reported(
    Effect.gen(function* () {
      const now = yield* Server.status(yield* appRoot, name);
      yield* printJson(now);
      if (now.state !== "running") process.exitCode = 3;
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Print this checkout's server: state, pid, port and url; exits 3 unless running",
  ),
);

const LOG_WAIT_TIMEOUT = Duration.seconds(60);
const PRINTED_LINES = 100;

const logs = Command.make(
  "logs",
  {
    name,
    run: Flag.String("run").pipe(
      Flag.withSchema(RunId),
      Flag.optional,
      Flag.withDescription("The run whose log to read; default the latest"),
    ),
    lines: Flag.Int("lines").pipe(
      Flag.withAlias("n"),
      Flag.optional,
      Flag.withDescription(
        `How many of the last lines to print; default ${String(PRINTED_LINES)}`,
      ),
    ),
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDefault(false),
      Flag.withDescription(
        "Keep printing new lines, across rolls, until the run's exit line",
      ),
    ),
    wait: Flag.String("wait").pipe(
      Flag.optional,
      Flag.withDescription(
        "Print the first line, written at or after --since, whose text after its stamp matches this JavaScript regex, then exit",
      ),
    ),
    since: Flag.String("since").pipe(
      Flag.withSchema(Schema.DateTimeUtcFromString),
      Flag.optional,
      Flag.withDescription(
        "An ISO time, such as the time of your action; default now",
      ),
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDefault(Duration.toSeconds(LOG_WAIT_TIMEOUT)),
      Flag.withDescription("Seconds --wait waits for a match"),
    ),
  },
  Effect.fn("Command.logs")(function* ({
    name,
    run,
    lines,
    follow,
    wait,
    since,
    timeout,
  }) {
    const now = yield* DateTime.now;
    const reading = yield* Option.match(wait, {
      onNone: () =>
        Effect.succeed<Server.Reading>({
          _tag: follow ? "Follow" : "Print",
          lines: Option.getOrElse(lines, () => PRINTED_LINES),
        }),
      onSome: (source) =>
        follow || Option.isSome(lines)
          ? Effect.fail(
              new CliError.UserError({
                cause: source,
                userMessage: "--wait does not combine with -f or -n",
              }),
            )
          : Effect.try({
              try: (): Server.Reading => ({
                _tag: "Wait",
                pattern: new RegExp(source, "u"),
                since: Option.getOrElse(since, () => now),
                timeout: Duration.seconds(timeout),
              }),
              catch: (cause) =>
                new CliError.UserError({
                  cause,
                  userMessage: `--wait is not a valid regular expression: ${String(cause)}`,
                }),
            }),
    });
    yield* reported(
      Effect.gen(function* () {
        yield* Server.logs(yield* appRoot, name, { run, reading });
      }),
    );
  }),
).pipe(
  Command.withShortDescription(
    "Print, follow or wait for a line of a run's log",
  ),
  Command.withExamples([
    {
      command: 'rigging server logs dev --wait "ready in" --since "$at"',
      description: "Wait for the first matching line written since $at",
    },
  ]),
);

export const command = Command.make("server").pipe(
  Command.withDescription(
    'Run one checkout\'s dev servers detached: start, stop, status and logs. A server publishes its port by writing {"port": n, "url"?: s} to $RIGGING_ENDPOINT.',
  ),
  Command.withSubcommands([start, stop, status, logs, port, runCommand]),
);
