import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  PortTakenError,
  retryPortTaken,
  runningOf,
  ServerError,
  serverOutput,
  tunnelErrorMessage,
  tunnelServes,
} from "./server.ts";
describe("tunnelServes", () => {
  it("reads Cloudflare's 530 as a tunnel whose cloudflared is gone", () => {
    assert.isFalse(tunnelServes(530));
  });

  it("reads any other status, a redirect or an error included, as the server answering", () => {
    for (const status of [200, 302, 404, 500, 502])
      assert.isTrue(tunnelServes(status));
  });
});

describe("tunnelErrorMessage", () => {
  const url = "https://a-b-c.trycloudflare.com";

  it("names public DNS when the lookup half failed", () => {
    assert.strictEqual(
      tunnelErrorMessage({
        phase: "resolve",
        url,
        lastSeen: "ENOTFOUND",
        waited: Duration.millis(90_400),
      }),
      `the tunnel ${url} does not resolve on public DNS after 90s (last: ENOTFOUND)`,
    );
  });

  it("names the answer through the tunnel when the fetch half failed", () => {
    assert.strictEqual(
      tunnelErrorMessage({
        phase: "answer",
        url,
        lastSeen: "HTTP 530",
        waited: Duration.seconds(61),
      }),
      `the tunnel ${url} resolves but / does not answer through it after 61s (last: HTTP 530)`,
    );
  });
});

const status = (fields: Record<string, unknown>) =>
  JSON.stringify({
    rigging: 1,
    name: "e2e",
    state: "running",
    run: "9df4baf3",
    pid: 43_986,
    group: 44_007,
    startedAt: "2026-11-03T14:56:35.734Z",
    port: 50_713,
    url: "https://example.trycloudflare.com",
    log: ".rigging/servers/e2e/log/current",
    ...fields,
  });

const running = (stdout: string) =>
  runningOf(Result.getOrThrow(serverOutput(["status", "e2e"], stdout)));

describe("rigging server status", () => {
  it("reads a running server's port, tunnel and start", () => {
    assert.deepStrictEqual(
      running(status({})),
      Option.some({
        port: 50_713,
        url: Option.some("https://example.trycloudflare.com"),
        startedAt: Option.some(new Date("2026-11-03T14:56:35.734Z")),
        log: ".rigging/servers/e2e/log/current",
      }),
    );
  });

  it("reads an empty url as no tunnel", () => {
    assert.deepStrictEqual(
      Option.map(running(status({ url: "" })), (server) => server.url),
      Option.some(Option.none()),
    );
  });

  it("has no running server while it starts or once it stopped", () => {
    assert.isTrue(Option.isNone(running(status({ state: "starting" }))));
    assert.isTrue(
      Option.isNone(
        running(
          status({
            state: "stopped",
            run: null,
            pid: null,
            group: null,
            startedAt: null,
            port: null,
            url: null,
          }),
        ),
      ),
    );
  });

  it("fails with rigging server's message, or names the command when the output is not rigging server's", () => {
    const refused = serverOutput(
      ["start", "e2e"],
      JSON.stringify({
        rigging: 1,
        error: { _tag: "ServerExitedError", message: "it exited" },
      }),
    );
    assert.isTrue(Result.isFailure(refused));
    if (Result.isFailure(refused))
      assert.strictEqual(refused.failure.message, "it exited");
    const garbled = serverOutput(["status", "e2e"], "USAGE\n");
    assert.isTrue(Result.isFailure(garbled));
    if (Result.isFailure(garbled))
      assert.strictEqual(
        garbled.failure.message,
        "rigging server status e2e printed no status; its stderr says why",
      );
  });
});

const taken = new PortTakenError({ report: "port 49177 is held" });

describe("retryPortTaken", () => {
  it.effect("reads rigging server's PortTakenError as its own failure", () =>
    Effect.sync(() => {
      const refused = serverOutput(
        ["start", "e2e"],
        JSON.stringify({
          rigging: 1,
          error: { _tag: "PortTakenError", message: "port 49177 is held" },
        }),
      );
      assert.deepStrictEqual(refused, Result.fail(taken));
    }),
  );

  it.effect("starts again after a start whose port was taken", () =>
    Effect.gen(function* () {
      let starts = 0;
      const start = Effect.suspend(() =>
        ++starts === 1 ? Effect.fail(taken) : Effect.succeed("running"),
      );
      assert.strictEqual(yield* retryPortTaken(start), "running");
      assert.strictEqual(starts, 2);
    }),
  );

  it.effect("gives up after three starts whose port was taken", () =>
    Effect.gen(function* () {
      let starts = 0;
      const start = Effect.suspend(() => {
        starts++;
        return Effect.fail(taken);
      });
      assert.deepStrictEqual(yield* Effect.flip(retryPortTaken(start)), taken);
      assert.strictEqual(starts, 3);
    }),
  );

  it.effect("fails at once on any other failure", () =>
    Effect.gen(function* () {
      let starts = 0;
      const exited = new ServerError({ message: "it exited" });
      const start = Effect.suspend(() => {
        starts++;
        return Effect.fail<ServerError | PortTakenError>(exited);
      });
      assert.deepStrictEqual(yield* Effect.flip(retryPortTaken(start)), exited);
      assert.strictEqual(starts, 1);
    }),
  );
});
