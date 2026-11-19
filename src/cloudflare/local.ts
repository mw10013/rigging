/**
 * The CLI for this checkout's per-developer stages: `start` runs a stage's server under
 * `rigging server`, `destroy` stops it and destroys the stage. `test` stages belong to the integ
 * files, which deploy and destroy their own.
 *
 * @module
 */
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import { stageOf } from "#rigging/cloudflare/stage.ts";
import {
  appRoot,
  commandArguments,
  printJson,
  reported,
} from "#rigging/core/server/command.ts";
import { ServerName } from "#rigging/core/server/domain.ts";
import * as Server from "#rigging/core/server/server.ts";

class DestroyError extends Schema.TaggedError<DestroyError>()("DestroyError", {
  message: Schema.String,
}) {}

const environment = Argument.Literals("environment", ["dev", "e2e"]).pipe(
  Argument.withDescription(
    "A per-developer environment with a server: dev or e2e",
  ),
);

const start = Command.make(
  "start",
  {
    environment,
    timeout: Flag.Int("timeout").pipe(
      Flag.withDefault(Duration.toSeconds(Server.START_TIMEOUT)),
      Flag.withDescription("Seconds to wait for the server to answer"),
    ),
    command: commandArguments,
  },
  ({ environment, timeout, command }) =>
    reported(
      Effect.gen(function* () {
        const root = yield* appRoot;
        const stage = yield* stageOf(environment, process.env.USER);
        yield* printJson(
          yield* Server.start(
            root,
            ServerName.make(environment),
            [
              "env",
              `ALCHEMY_STAGE=${stage}`,
              `SANDBOX_ENVIRONMENT=${environment}`,
              ...command,
            ],
            {
              note: Option.some(`stage=${stage}`),
              timeout: Duration.seconds(timeout),
            },
          ),
        );
      }),
    ),
).pipe(
  Command.withShortDescription(
    "Start or adopt this checkout's server of the environment, on its stage",
  ),
  Command.withExamples([
    {
      command: "rigging local start e2e -- vp run dev:alchemy",
      description: "Start or adopt the e2e server on e2e-$USER",
    },
  ]),
);

const destroy = Command.make("destroy", { environment }, ({ environment }) =>
  reported(
    Effect.gen(function* () {
      const root = yield* appRoot;
      const stage = yield* stageOf(environment, process.env.USER);
      yield* Server.stop(root, ServerName.make(environment));
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const args = ["destroy", "--stage", stage, "--yes"];
      const exitCode = yield* spawner
        .exitCode(
          ChildProcess.make("alchemy", args, {
            cwd: root,
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new DestroyError({
                message: `cannot run alchemy: ${cause.message}`,
              }),
          ),
        );
      if (exitCode !== ChildProcessSpawner.ExitCode(0))
        return yield* new DestroyError({
          message: `alchemy ${args.join(" ")} exited ${String(exitCode)}`,
        });
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Stop this checkout's server of the environment and destroy its stage",
  ),
);

export const command = Command.make("local").pipe(
  Command.withDescription(
    "This checkout's per-developer stages: start a stage's server, or stop it and destroy the stage.",
  ),
  Command.withSubcommands([start, destroy]),
);
