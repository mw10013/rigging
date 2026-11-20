import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const ENTRY = path.resolve(import.meta.dirname, "../bin/rigging.ts");

const SERVER = `
import http from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync("env.json", JSON.stringify({ stage: process.env.ALCHEMY_STAGE, environment: process.env.SANDBOX_ENVIRONMENT, args: process.argv.slice(2) }));
const server = http.createServer((_, res) => res.end("hi"));
server.listen(0, "127.0.0.1", () => writeFileSync(process.env.RIGGING_ENDPOINT, JSON.stringify({ port: server.address().port })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

const ALCHEMY = `#!/bin/sh
echo "$PWD $*" >> "$ALCHEMY_CALLS"
exit "\${ALCHEMY_EXIT:-0}"
`;

interface Printed {
  readonly state: string;
  readonly run: string;
  readonly log: string;
  readonly error: { readonly _tag: string; readonly message: string };
}

let checkout: string;

const rigging = (env: NodeJS.ProcessEnv, ...args: string[]) => {
  const result = spawnSync("vpx", [ENTRY, ...args], {
    cwd: checkout,
    env: {
      ...process.env,
      USER: "mw",
      PATH: `${path.join(checkout, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      ALCHEMY_CALLS: path.join(checkout, "alchemy-calls"),
      ...env,
    },
    encoding: "utf8",
  });
  return {
    code: result.status,
    get json() {
      return JSON.parse(result.stdout) as Printed;
    },
  };
};

const local = (...args: string[]) => rigging({}, "local", ...args);

const alchemyCalls = () =>
  fs.existsSync(path.join(checkout, "alchemy-calls"))
    ? fs
        .readFileSync(path.join(checkout, "alchemy-calls"), "utf8")
        .trim()
        .split("\n")
    : [];

beforeEach(() => {
  checkout = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "rigging-local-")),
  );
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  fs.writeFileSync(path.join(checkout, "package.json"), `{"name":"app"}`);
  fs.writeFileSync(path.join(checkout, "server.mjs"), SERVER);
  fs.mkdirSync(path.join(checkout, "bin"));
  fs.writeFileSync(path.join(checkout, "bin/alchemy"), ALCHEMY, {
    mode: 0o755,
  });
});

afterEach(() => {
  rigging({}, "server", "stop", "dev");
  rigging({}, "server", "stop", "e2e");
  fs.rmSync(checkout, { recursive: true, force: true });
});

describe("rigging local start", () => {
  it("runs the command as the environment's server on this checkout's stage", () => {
    const started = local("start", "e2e", "--", "node", "server.mjs", "--x");
    expect(started.code).toBe(0);
    expect(started.json).toMatchObject({ state: "running", name: "e2e" });
    expect(
      JSON.parse(fs.readFileSync(path.join(checkout, "env.json"), "utf8")),
    ).toEqual({
      stage: "e2e-mw",
      environment: "e2e",
      args: ["--x"],
    });
    expect(
      fs.readFileSync(path.join(checkout, started.json.log), "utf8"),
    ).toMatch(/==== e2e start \S+ run=\S+ stage=e2e-mw/u);

    expect(
      local("start", "e2e", "--", "node", "server.mjs").json,
    ).toMatchObject({
      state: "running",
      run: started.json.run,
    });
  }, 60_000);

  it("refuses a user that cannot name a stage", () => {
    const refused = rigging(
      { USER: "Mike" },
      "local",
      "start",
      "dev",
      "--",
      "node",
      "server.mjs",
    );
    expect(refused.code).toBe(1);
    expect(refused.json.error).toEqual({
      _tag: "InvalidUserError",
      message:
        '$USER must be lowercase letters and digits to name a stage, got "Mike"',
    });
  });

  it("refuses the test environment, whose stages belong to the integ files", () => {
    expect(local("start", "test", "--", "node", "server.mjs").code).toBe(2);
    expect(local("destroy", "test").code).toBe(2);
  });
});

describe("rigging local destroy", () => {
  it("stops the server, then destroys the stage, every time it runs", () => {
    expect(local("start", "dev", "--", "node", "server.mjs").code).toBe(0);

    expect(local("destroy", "dev").code).toBe(0);
    expect(rigging({}, "server", "status", "dev").json.state).toBe("stopped");
    expect(local("destroy", "dev").code).toBe(0);
    expect(alchemyCalls()).toEqual([
      `${checkout} destroy --stage dev-mw --yes`,
      `${checkout} destroy --stage dev-mw --yes`,
    ]);
  }, 60_000);

  it("fails when Alchemy cannot destroy the stage", () => {
    const failed = rigging({ ALCHEMY_EXIT: "1" }, "local", "destroy", "e2e");
    expect(failed.code).toBe(1);
    expect(failed.json.error).toEqual({
      _tag: "DestroyError",
      message: "alchemy destroy --stage e2e-mw --yes exited 1",
    });
  });
});
