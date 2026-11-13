/**
 * Picks a free localhost port, publishes it to rigging server as the server's endpoint and prints it, for
 * a server that takes its port as an argument and never reports the port it bound: `alchemy dev`
 * serves the app from a proxy whose port stays inside Alchemy. A Vite server publishes itself
 * after it binds, with `serverEndpoint` from `core/server-endpoint.ts`, and needs none of this.
 *
 * The port is free when picked, not reserved. The server must bind it strictly, so a process that
 * takes it first fails the start instead of moving the server off the published port. An app
 * runs it as the `rigging server port` bin: `port=$(rigging server port)`.
 *
 * @module
 */
import { createServer } from "node:net";

import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.once("error", (cause) => {
    resume(Effect.die(cause));
  });
  server.listen(0, "localhost", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      resume(
        Effect.die(
          new Error(`localhost bound no TCP address: ${String(address)}`),
        ),
      );
      return;
    }
    server.close(() => {
      resume(Effect.succeed(address.port));
    });
  });
});

export const publishFreePort = Effect.gen(function* () {
  const endpoint = yield* Config.String("RIGGING_ENDPOINT").pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage:
            "RIGGING_ENDPOINT is unset: start the server with rigging server start",
        }),
    ),
  );
  const port = yield* freePort;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    endpoint,
    JSON.stringify({ port, url: `http://localhost:${String(port)}/` }),
  );
  return port;
});

export const command = Command.make("port", {}, () =>
  publishFreePort.pipe(Effect.flatMap(Console.log)),
).pipe(
  Command.withDescription(
    "Publish a free localhost port to rigging server and print it.",
  ),
);
