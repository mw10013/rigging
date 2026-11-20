import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyOf,
  exitMarker,
  isExitLine,
  listenerOf,
  runFilesToPrune,
  RunId,
  runLogName,
  runOfLog,
  runOutput,
  RUNS_KEPT,
  ServerName,
  stamped,
  stampOf,
  stateOf,
} from "./domain.ts";

const ENTRY = path.resolve(import.meta.dirname, "../../bin/rigging.ts");

const FIXTURE = `
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv[2]?.startsWith("detach")) writeFileSync("detached.pid", String(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }).pid));
if (process.argv[2] === "crash" || process.argv[2] === "detach-crash") { console.log("crashing on purpose"); process.exit(7); }
if (process.argv[2] === "publish") {
  writeFileSync(process.env.RIGGING_ENDPOINT, JSON.stringify({ port: Number(process.argv[3]) }));
  setInterval(() => {}, 1000);
} else {
spawn("sleep", ["600"], { stdio: "ignore" });
const server = http.createServer((_, res) => res.end("hi"));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("listening on " + port);
  console.error("a stderr line");
  writeFileSync(process.env.RIGGING_ENDPOINT, JSON.stringify({ port, url: "http://x.test/" + port }));
});
const settle = { "late-fail": ["[t] INFO: Failed: 0 succeeded, 4 failed (3.2s)", "[t] ERROR: alchemy dev: apply failed; keeping dev alive so healthy resources keep serving."], "late-done": ["[t] INFO: Done: 6 succeeded (10.0s)"] }[process.argv[2]];
const quiet = ["ALCHEMY_LOG_FORMAT", "ALCHEMY_LOG_LEVEL"].some((key) => process.env[key] !== undefined);
if (settle) {
  if (!quiet) console.log("[t] INFO: Dev · dev-test");
  setTimeout(() => settle.filter((line) => !quiet || line.includes("ERROR")).forEach((line) => console.log(line)), 3000);
}
if (process.argv[2] === "apply-failed") {
  console.log("Ready! Your webhook signing secret is whsec_SENTINEL (^C to quit)");
  console.log("[t] ERROR: [Backend] fail (local) — RewrittenMigrationHistoryError: changed 0001_init.sql (81ms)");
  console.log("[t] INFO: Failed: 0 succeeded, 1 failed (6.3s)");
  console.log("[t] ERROR: alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.\\nRewrittenMigrationHistoryError: changed 0001_init.sql\\n    at migrate (migrations.ts:1:1)\\n    at apply (Apply.ts:2:2)");
}
if (process.argv[2] === "ready-later") setTimeout(() => console.log("ready later"), 3000);
if (process.argv[2] !== "no-handler") process.on("SIGTERM", () => { console.log("got SIGTERM"); server.close(() => process.exit(0)); });
}
`;

interface Printed {
  readonly state: string;
  readonly name: string;
  readonly url: string;
  readonly port: number;
  readonly run: string;
  readonly log: string;
  readonly group: number;
  readonly pid: number;
  readonly failure: string | null;
  readonly diagnostic: string | null;
  readonly error: { readonly _tag: string; readonly message: string };
}

let checkout: string;

const serverWith = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => {
  const result = spawnSync("vpx", [ENTRY, "server", ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    code: result.status,
    stdout: result.stdout,
    get json() {
      return (
        result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout)
      ) as Printed;
    },
    stderr: result.stderr,
  };
};

const serverIn = (cwd: string, ...args: string[]) =>
  serverWith(cwd, {}, ...args);

const server = (...args: string[]) => serverIn(checkout, ...args);

const serverLater = (...args: string[]) => {
  const child = spawn("vpx", [ENTRY, "server", ...args], {
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; stdout: string }>(
    (resolve) => {
      child.on("close", (code) => {
        resolve({ code, stdout });
      });
    },
  );
  return { exited, printed: () => stdout };
};

const until = async (check: () => boolean) => {
  while (!check()) await sleep(100);
};

const ISO = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;

const runFilePattern = (run: string) =>
  new RegExp(String.raw`^\.rigging/servers/dev/runs/${ISO}-${run}\.log$`, "u");

const logIn = (cwd: string) =>
  fs.readFileSync(
    path.join(cwd, serverIn(cwd, "status", "dev").json.log),
    "utf8",
  );

const log = () => logIn(checkout);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const detached = () =>
  Number(fs.readFileSync(path.join(checkout, "detached.pid"), "utf8"));

const endDetached = () => {
  if (fs.existsSync(path.join(checkout, "detached.pid")) && alive(detached()))
    process.kill(detached(), "SIGKILL");
};

beforeEach(() => {
  checkout = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "rigging-test-")),
  );
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  fs.writeFileSync(path.join(checkout, "package.json"), `{"name":"app"}`);
  fs.writeFileSync(path.join(checkout, "server.mjs"), FIXTURE);
});

afterEach(() => {
  server("stop", "dev");
  fs.rmSync(checkout, { recursive: true, force: true });
});

describe("rigging server", () => {
  it("starts, adopts, reports and stops a server, logging its run", () => {
    const started = server("start", "dev", "--", "node", "server.mjs");
    expect(started.code).toBe(0);
    expect(started.json).toMatchObject({ state: "running", name: "dev" });
    expect(started.json.url).toBe(`http://x.test/${String(started.json.port)}`);

    const adopted = server("start", "dev", "--", "node", "server.mjs");
    expect(adopted.json.run).toBe(started.json.run);
    expect(adopted.stderr).toContain("adopted");

    const now = server("status", "dev");
    expect(now.code).toBe(0);
    expect(now.json.state).toBe("running");
    expect(now.json.failure).toBeNull();
    expect(now.json.diagnostic).toBeNull();
    expect(started.json.log).toMatch(runFilePattern(started.json.run));
    expect(now.json.log).toBe(started.json.log);
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: checkout,
        encoding: "utf8",
      }),
    ).toBe("?? package.json\n?? server.mjs\n");

    expect(server("stop", "dev").code).toBe(0);
    expect(alive(started.json.group)).toBe(false);
    const after = server("status", "dev");
    expect(after.code).toBe(3);
    expect(after.json.state).toBe("stopped");
    expect(after.json.log).toBe(started.json.log);
    const lines = log().split("\n").slice(0, -1);
    const stamp = new RegExp(`^${ISO} `, "u");
    expect(lines[0]).toMatch(
      new RegExp(`^${ISO} ==== dev start ${ISO} run=${started.json.run}$`, "u"),
    );
    for (const text of ["listening on ", "a stderr line", "got SIGTERM"])
      expect(lines.find((line) => line.includes(text))).toMatch(stamp);
    expect(lines.at(-1)).toMatch(
      new RegExp(`^${ISO} ==== dev exit run=${started.json.run} code=0$`, "u"),
    );
  }, 60_000);

  it("writes each run to its own file, which holds no earlier run's lines", () => {
    const failed = server(
      "start",
      "dev",
      "--",
      "node",
      "server.mjs",
      "apply-failed",
    );
    expect(failed.json.error._tag).toBe("ServerDegradedError");
    const first = server("status", "dev").json;
    expect(server("stop", "dev").code).toBe(0);

    const second = server("start", "dev", "--", "node", "server.mjs");
    expect(second.json.state).toBe("running");
    expect(second.json.log).not.toBe(first.log);
    expect(second.json.log).toMatch(runFilePattern(second.json.run));
    expect(log()).not.toContain(first.run);
    expect(log()).not.toContain("apply failed");
    expect(fs.readFileSync(path.join(checkout, first.log), "utf8")).toContain(
      `==== dev exit run=${first.run} `,
    );
  }, 60_000);

  it("keeps a monorepo app's servers in that app's folder", () => {
    const app = path.join(checkout, "apps/x");
    fs.mkdirSync(path.join(app, "src"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "package.json"), `{"name":"root"}`);
    fs.writeFileSync(path.join(app, "package.json"), `{"name":"x"}`);
    fs.renameSync(
      path.join(checkout, "server.mjs"),
      path.join(app, "server.mjs"),
    );
    const inSrc = path.join(app, "src");

    const started = serverIn(inSrc, "start", "dev", "--", "node", "server.mjs");
    expect(started.code).toBe(0);
    expect(started.json.log).toMatch(runFilePattern(started.json.run));
    expect(serverIn(app, "status", "dev").json.state).toBe("running");
    expect(server("status", "dev").json.state).toBe("stopped");
    expect(fs.existsSync(path.join(checkout, ".rigging"))).toBe(false);

    expect(serverIn(inSrc, "stop", "dev").code).toBe(0);
    expect(logIn(app)).toContain(
      `==== dev exit run=${started.json.run} code=0`,
    );
  }, 60_000);

  it("reports a server that logged a failed apply as degraded, and keeps it running", () => {
    const started = server(
      "start",
      "dev",
      "--",
      "node",
      "server.mjs",
      "apply-failed",
    );
    const now = server("status", "dev");
    const message = `the dev server logged a failure (run ${now.json.run}); it is still running
RewrittenMigrationHistoryError: changed 0001_init.sql
see ${now.json.log}`;
    expect(started.code).toBe(1);
    expect(started.json.error).toEqual({
      _tag: "ServerDegradedError",
      message,
    });
    expect(started.stderr).toBe(
      `ok    started the dev server (run ${now.json.run})\nerror ${message}\n`,
    );
    for (const leak of ["whsec_SENTINEL", "    at ", "--- "]) {
      expect(started.stdout).not.toContain(leak);
      expect(started.stderr).not.toContain(leak);
    }

    expect(now.code).toBe(3);
    expect(now.json.state).toBe("degraded");
    expect(now.json.failure).toBe(
      "alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.",
    );
    expect(now.json.diagnostic).toBe(
      "RewrittenMigrationHistoryError: changed 0001_init.sql",
    );
    expect(alive(now.json.group)).toBe(true);
    expect(server("start", "dev", "--", "node", "server.mjs").code).toBe(1);
    expect(server("status", "dev").json.run).toBe(now.json.run);
  }, 60_000);

  it("fails a start whose apply fails after the port answers", () => {
    const started = server(
      "start",
      "dev",
      "--",
      "node",
      "server.mjs",
      "late-fail",
    );
    expect(started.code).toBe(1);
    expect(started.json.error._tag).toBe("ServerDegradedError");
    expect(started.json.error.message).toContain("alchemy dev: apply failed");
    expect(server("status", "dev").json.state).toBe("degraded");
  }, 60_000);

  it("keeps alchemy dev's apply lines on when the shell turns them off", () => {
    const started = serverWith(
      checkout,
      {
        ALCHEMY_LOG_FORMAT: "json",
        ALCHEMY_LOG_LEVEL: "warn",
      },
      "start",
      "dev",
      "--",
      "node",
      "server.mjs",
      "late-fail",
    );
    expect(started.code).toBe(1);
    expect(started.json.error._tag).toBe("ServerDegradedError");
  }, 60_000);

  it("returns running once the apply is done, not when the port first answers", () => {
    const started = server(
      "start",
      "dev",
      "--",
      "node",
      "server.mjs",
      "late-done",
    );
    expect(started.code).toBe(0);
    expect(started.json.state).toBe("running");
    expect(log()).toContain("Done: 6 succeeded");
  }, 60_000);

  it("logs the exit of a server that SIGTERM ends without its own handler", () => {
    const started = server(
      "start",
      "dev",
      "--",
      "node",
      "server.mjs",
      "no-handler",
    );
    expect(started.code).toBe(0);
    expect(server("stop", "dev").code).toBe(0);
    expect(log()).toContain(
      `==== dev exit run=${started.json.run} signal=SIGTERM`,
    );
    expect(server("status", "dev").json.state).toBe("stopped");
  }, 60_000);

  it("fails a start whose server exits, with that run's output", () => {
    const crashed = server("start", "dev", "--", "node", "server.mjs", "crash");
    expect(crashed.code).toBe(1);
    expect(crashed.json.error._tag).toBe("ServerExitedError");
    expect(crashed.json.error.message).toContain("crashing on purpose");
    expect(crashed.json.error.message).toContain("code=7");
  }, 60_000);

  it("fails a start whose published port another process holds, and stops the server", async () => {
    const elsewhere = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "rigging-holder-")),
    );
    const holder = spawn(
      "node",
      [
        "-e",
        'require("http").createServer((_, res) => res.end("not yours")).listen(0, "127.0.0.1", function () { console.log(this.address().port); })',
      ],
      { cwd: elsewhere, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const port = await new Promise<string>((resolve) => {
        holder.stdout.once("data", (chunk: Buffer) => {
          resolve(chunk.toString().trim());
        });
      });
      const taken = server(
        "start",
        "dev",
        "--",
        "node",
        "server.mjs",
        "publish",
        port,
      );
      expect(taken.code).toBe(1);
      expect(taken.json.error._tag).toBe("PortTakenError");
      expect(taken.json.error.message).toContain(`port ${port}`);
      expect(taken.json.error.message).toContain(
        `pid ${String(holder.pid)} (node -e`,
      );
      expect(taken.json.error.message).toContain(` in ${elsewhere}`);
      expect(server("status", "dev").json.state).toBe("stopped");
    } finally {
      holder.kill();
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 60_000);

  it("ends the run's processes that left the command's group when it stops", () => {
    try {
      const started = server(
        "start",
        "dev",
        "--",
        "node",
        "server.mjs",
        "detach",
      );
      expect(started.code).toBe(0);
      expect(alive(detached())).toBe(true);
      expect(server("stop", "dev").code).toBe(0);
      expect(alive(detached())).toBe(false);
    } finally {
      endDetached();
    }
  }, 60_000);

  it("ends the run's processes that left the command's group when it crashes", () => {
    try {
      const crashed = server(
        "start",
        "dev",
        "--",
        "node",
        "server.mjs",
        "detach-crash",
      );
      expect(crashed.json.error._tag).toBe("ServerExitedError");
      expect(alive(detached())).toBe(false);
    } finally {
      endDetached();
    }
  }, 60_000);

  it("ends a dead run's processes that left the command's group before starting a new one", () => {
    try {
      const started = server(
        "start",
        "dev",
        "--",
        "node",
        "server.mjs",
        "detach",
      );
      process.kill(started.json.pid, "SIGKILL");
      process.kill(-started.json.group, "SIGKILL");
      expect(alive(detached())).toBe(true);
      expect(server("status", "dev").json.state).toBe("stopped");
      expect(
        server("start", "dev", "--", "node", "server.mjs").json.state,
      ).toBe("running");
      expect(alive(detached())).toBe(false);
    } finally {
      endDetached();
    }
  }, 60_000);

  it("stops an orphaned server before starting a new one", () => {
    const started = server("start", "dev", "--", "node", "server.mjs");
    process.kill(started.json.pid, "SIGKILL");
    expect(server("status", "dev").json.state).toBe("orphaned");

    const restarted = server("start", "dev", "--", "node", "server.mjs");
    expect(restarted.json.state).toBe("running");
    expect(restarted.json.run).not.toBe(started.json.run);
    expect(alive(started.json.group)).toBe(false);
  }, 60_000);
});

describe("rigging server logs", () => {
  const exitLine = (run: string) =>
    new RegExp(`^${ISO} ==== dev exit run=${run} code=0$`, "u");

  it("prints the last lines of the latest run, or of the run --run names", () => {
    const first = server("start", "dev", "--", "node", "server.mjs").json;
    expect(server("stop", "dev").code).toBe(0);
    const second = server("start", "dev", "--", "node", "server.mjs").json;

    const latest = server("logs", "dev");
    expect(latest.code).toBe(0);
    expect(latest.stdout.split("\n")[0]).toMatch(
      new RegExp(`^${ISO} ==== dev start ${ISO} run=${second.run}$`, "u"),
    );
    expect(server("logs", "dev", "-n", "2").stdout).toBe(
      `${latest.stdout.trimEnd().split("\n").slice(-2).join("\n")}\n`,
    );

    const earlier = server("logs", "dev", "--run", first.run, "-n", "1");
    expect(earlier.stdout.trimEnd()).toMatch(exitLine(first.run));
    expect(earlier.stdout).not.toContain(second.run);

    const unknown = server("logs", "dev", "--run", "ffffffff");
    expect(unknown.code).toBe(1);
    expect(unknown.json.error._tag).toBe("NoRunLogError");
  }, 60_000);

  it("waits for the first matching line written since --since, by default since it began", () => {
    const before = new Date().toISOString();
    expect(
      server("start", "dev", "--", "node", "server.mjs", "ready-later").code,
    ).toBe(0);

    const ready = server("logs", "dev", "--wait", "ready l.ter");
    expect(ready.code).toBe(0);
    expect(ready.stdout).toMatch(new RegExp(`^${ISO} ready later\n$`, "u"));

    const written = server(
      "logs",
      "dev",
      "--wait",
      "^listening on",
      "--since",
      before,
    );
    expect(written.code).toBe(0);
    expect(written.stdout).toMatch(/ listening on \d+\n$/u);

    const late = server(
      "logs",
      "dev",
      "--wait",
      "^listening on",
      "--timeout",
      "1",
    );
    expect(late.code).toBe(1);
    expect(late.json.error._tag).toBe("LogWaitTimeoutError");
  }, 60_000);

  it("fails a wait whose run ends first, with the run's exit line", async () => {
    const started = server("start", "dev", "--", "node", "server.mjs").json;
    const wait = serverLater("logs", "dev", "--wait", "nope");
    await sleep(1000);
    expect(server("stop", "dev").code).toBe(0);
    const waited = await wait.exited;
    expect(waited.code).toBe(1);
    const { error } = JSON.parse(waited.stdout) as Printed;
    expect(error._tag).toBe("RunEndedError");
    expect(error.message.split("\n").at(-1)).toMatch(exitLine(started.run));
  }, 60_000);

  it("follows a run until its exit line, then exits by itself", async () => {
    const started = server("start", "dev", "--", "node", "server.mjs").json;
    const follow = serverLater("logs", "dev", "-f");
    await until(() => follow.printed().includes("a stderr line"));
    expect(server("stop", "dev").code).toBe(0);
    const followed = await follow.exited;
    expect(followed.code).toBe(0);
    const lines = followed.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(exitLine(started.run));
    expect(lines.filter((line) => line.includes("got SIGTERM"))).toHaveLength(
      1,
    );

    const again = server("logs", "dev", "-f");
    expect(again.code).toBe(0);
    expect(again.stdout.trimEnd().split("\n").at(-1)).toMatch(
      exitLine(started.run),
    );
  }, 60_000);
});

describe("run logs", () => {
  const at = DateTime.makeUnsafe("2026-11-15T08:24:53.894Z");

  it("stamps a line with its UTC instant and leaves an empty line empty", () => {
    expect(stamped(at, "[03:25:00.159] INFO: Dev · dev-mw")).toBe(
      "2026-11-15T08:24:53.894Z [03:25:00.159] INFO: Dev · dev-mw",
    );
    expect(stamped(at, "")).toBe("");
  });

  it("reads a line's stamp, and none from a line without one", () => {
    expect(
      Option.map(
        stampOf("2026-11-15T08:24:53.894Z ready later"),
        DateTime.formatIso,
      ),
    ).toEqual(Option.some("2026-11-15T08:24:53.894Z"));
    expect(stampOf("ready later")).toEqual(Option.none());
    expect(stampOf("")).toEqual(Option.none());
  });

  it("knows the run's exit line from its other lines", () => {
    const dev = ServerName.make("dev");
    const run = RunId.make("0123abcd");
    const exit = stamped(at, exitMarker(dev, run, { _tag: "Exited", code: 0 }));
    expect(isExitLine(exit, dev, run)).toBe(true);
    expect(isExitLine(exit, dev, RunId.make("ffffffff"))).toBe(false);
    expect(isExitLine(exit, ServerName.make("e2e"), run)).toBe(false);
    expect(
      isExitLine(
        stamped(at, "echo ==== dev exit run=0123abcd code=0"),
        dev,
        run,
      ),
    ).toBe(false);
    expect(
      isExitLine(
        stamped(at, exitMarker(dev, run, { _tag: "Interrupted" })),
        dev,
        run,
      ),
    ).toBe(true);
  });

  it("reads the run from a run file's path", () => {
    expect(
      runOfLog(
        `.rigging/servers/dev/runs/${runLogName("2026-11-15T08:24:53.894Z", RunId.make("0123abcd"))}`,
      ),
    ).toEqual(Option.some("0123abcd"));
    expect(runOfLog(".rigging/servers/dev/log")).toEqual(Option.none());
  });

  it("names a run's file so the names sort by start time", () => {
    const names = [
      runLogName("2026-11-15T08:24:53.894Z", RunId.make("ffffffff")),
      runLogName("2026-11-15T10:00:00.000Z", RunId.make("00000000")),
      runLogName("2026-11-14T23:59:59.999Z", RunId.make("aaaaaaaa")),
    ];
    expect(names.toSorted()).toEqual([names[2], names[0], names[1]]);
    expect(names[0]).toBe("2026-11-15T08:24:53.894Z-ffffffff.log");
  });

  const runFile = (index: number) =>
    runLogName(
      `2026-11-15T08:${String(index).padStart(2, "0")}:00.000Z`,
      RunId.make("0123abcd"),
    );
  const small = ByteSize.kibibytes(1);

  it("expires the oldest runs past the count, leaving room for the new one", () => {
    const files = Array.from({ length: RUNS_KEPT + 2 }, (_, index) => ({
      name: runFile(index),
      size: small,
    }));
    expect(runFilesToPrune(files).toSorted()).toEqual([
      runFile(0),
      runFile(1),
      runFile(2),
    ]);
  });

  it("counts a run's rolled file with it", () => {
    const files = Array.from({ length: RUNS_KEPT }, (_, index) => ({
      name: runFile(index),
      size: small,
    }));
    const rolled = [...files, { name: `${runFile(5)}.1`, size: small }];
    expect(runFilesToPrune(rolled)).toEqual([runFile(0)]);
    expect(
      runFilesToPrune([
        ...rolled,
        { name: `${runFile(0)}.1`, size: small },
      ]).toSorted(),
    ).toEqual([runFile(0), `${runFile(0)}.1`]);
  });

  it("expires the older runs once the kept runs pass the bytes", () => {
    const files = [
      { name: runFile(3), size: ByteSize.mebibytes(40) },
      { name: `${runFile(3)}.1`, size: ByteSize.mebibytes(50) },
      { name: runFile(2), size: ByteSize.mebibytes(5) },
      { name: runFile(1), size: ByteSize.mebibytes(10) },
      { name: runFile(0), size: small },
    ];
    expect(runFilesToPrune(files).toSorted()).toEqual([runFile(0), runFile(1)]);
  });

  it("keeps the newest run though it alone passes the bytes", () => {
    const files = [
      { name: runFile(1), size: ByteSize.mebibytes(50) },
      { name: `${runFile(1)}.1`, size: ByteSize.mebibytes(60) },
      { name: runFile(0), size: small },
    ];
    expect(runFilesToPrune(files)).toEqual([runFile(0)]);
  });

  it("leaves files that are not run logs alone", () => {
    expect(
      runFilesToPrune([{ name: "notes.txt", size: ByteSize.gibibytes(1) }]),
    ).toEqual([]);
  });
});

describe("runOutput", () => {
  const STAMP = "2026-11-15T08:24:53.894Z ";
  const START = `${STAMP}==== dev start 2026-11-15T08:24:53.781Z run=0123abcd store=x`;

  it("keeps the run's lines through its exit marker, after its start marker", () => {
    expect(
      runOutput(
        [
          START,
          `${STAMP}line one`,
          "",
          `${STAMP}==== dev exit run=0123abcd code=1`,
          "",
        ].join("\n"),
      ),
    ).toEqual(
      Option.some(
        `${STAMP}line one\n${STAMP}==== dev exit run=0123abcd code=1`,
      ),
    );
  });

  it("is none for a run that wrote only its start marker", () => {
    expect(runOutput(`${START}\n`)).toEqual(Option.none());
  });
});

describe("applyOf", () => {
  const BANNER = "[04:17:39.887] INFO: Dev · dev-mw";
  const APPLY_FAILED =
    "[04:17:48.756] ERROR: alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.";
  const runLog = (...lines: string[]) =>
    [
      "2026-11-15T08:24:53.894Z ==== dev start 2026-11-15T08:24:53.781Z run=0123abcd",
      ...lines.map((line) => `2026-11-15T08:24:54.000Z ${line}`),
    ].join("\n");

  it("reads a command that logs no apply as none, routine failures included", () => {
    expect(
      applyOf(runLog("1 test failed", "ERROR: fetch failed; retrying")),
    ).toEqual({ _tag: "None" });
  });

  it("reads an apply as in progress from the banner until its summary", () => {
    expect(
      applyOf(runLog(BANNER, "[Website] ready at http://localhost:1")),
    ).toEqual({ _tag: "Applying" });
    expect(
      applyOf(runLog(BANNER, "[04:17:25.506] INFO: Done: 6 succeeded (10.0s)")),
    ).toEqual({ _tag: "Applied" });
  });

  it("names the failure, from the summary on", () => {
    expect(
      applyOf(
        runLog(
          BANNER,
          "[04:17:48.756] INFO: Failed: 0 succeeded, 4 failed (3.2s)",
        ),
      ),
    ).toEqual({
      _tag: "Failed",
      failure: "Failed: 0 succeeded, 4 failed (3.2s)",
      diagnostic: null,
    });
    expect(
      applyOf(
        runLog(
          BANNER,
          "[04:17:48.756] INFO: Failed: 0 succeeded, 4 failed (3.2s)",
          APPLY_FAILED,
        ),
      ),
    ).toEqual({
      _tag: "Failed",
      failure:
        "alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.",
      diagnostic: null,
    });
  });

  it("reads a failure before any apply as failed", () => {
    expect(
      applyOf(
        runLog(
          BANNER,
          "[t] ERROR: alchemy dev: run failed; waiting for the next file change to retry.",
        ),
      ),
    ).toMatchObject({ _tag: "Failed" });
  });

  it("reads an internally interrupted apply, which logs no summary, as failed", () => {
    expect(
      applyOf(
        runLog(
          BANNER,
          "[t] ERROR: alchemy dev: apply was interrupted internally (a bug in a provider or the engine — please report it with the trace below); keeping dev alive so healthy resources keep serving.",
        ),
      ),
    ).toMatchObject({ _tag: "Failed" });
  });

  it("reopens the apply on a reload, which settles the failure before it", () => {
    const reloaded = "[t] INFO: Reloading stack: changed src/backend.ts";
    expect(applyOf(runLog(BANNER, APPLY_FAILED, reloaded))).toEqual({
      _tag: "Applying",
    });
    expect(
      applyOf(
        runLog(
          BANNER,
          APPLY_FAILED,
          reloaded,
          BANNER,
          "[t] INFO: Done: 6 succeeded (1s)",
        ),
      ),
    ).toEqual({ _tag: "Applied" });
  });
});

describe("applyOf's diagnostic", () => {
  const recorded = fs
    .readFileSync(
      path.join(import.meta.dirname, "fixtures/apply-failed.log"),
      "utf8",
    )
    .split("\n");
  const STAMP = "2026-11-15T08:25:19.238Z ";
  const START = `${STAMP}==== dev start 2026-11-15T08:24:53.781Z run=2765bcc1`;
  const FAILURE =
    "alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.";
  const DIAGNOSTIC =
    'RewrittenMigrationHistoryError: Applied migration history in "__alchemy_migrations" does not match the local files (changed 0001_init.sql). Add a new forward migration instead of editing or deleting already-applied files.';
  const throughSummary = recorded.slice(
    0,
    recorded.findIndex((line) => line.includes("] INFO: Failed: ")) + 1,
  );
  const applyOfLines = (lines: readonly string[]) => applyOf(lines.join("\n"));
  const runOf = (...lines: string[]) =>
    applyOfLines([START, ...lines.map((line) => STAMP + line)]);

  it("names the cause alchemy reported after a failed apply, not the stack or the exit", () => {
    expect(applyOfLines(recorded)).toEqual({
      _tag: "Failed",
      failure: FAILURE,
      diagnostic: DIAGNOSTIC,
    });
  });

  it("names the first resource's failure while the report is not written yet", () => {
    expect(applyOfLines(throughSummary)).toEqual({
      _tag: "Failed",
      failure: "Failed: 0 succeeded, 4 failed (6.3s)",
      diagnostic: DIAGNOSTIC,
    });
  });

  it("drops the elapsed time from a resource's failure", () => {
    expect(
      applyOfLines(
        throughSummary.filter(
          (line) =>
            !/\[(?:AdminSeed|Backend|BetterAuthMigrate)\] fail/u.test(line),
        ),
      ),
    ).toMatchObject({ diagnostic: DIAGNOSTIC });
  });

  it("names a reload's own failure, never the one before it", () => {
    const reload = "[t] INFO: Reloading stack: changed src/backend.ts";
    expect(
      applyOfLines([
        ...throughSummary,
        STAMP + reload,
        `${STAMP}[t] ERROR: [Backend] fail (local) — TypeError: x is not a function (1.2s)`,
        `${STAMP}[t] INFO: Failed: 0 succeeded, 1 failed (1.3s)`,
        `${STAMP}[t] ERROR: ${FAILURE}`,
        `${STAMP}TypeError: x is not a function`,
        `${STAMP}    at y (backend.ts:1:1)`,
      ]),
    ).toEqual({
      _tag: "Failed",
      failure: FAILURE,
      diagnostic: "TypeError: x is not a function",
    });
    expect(
      applyOfLines([
        ...throughSummary,
        STAMP + reload,
        `${STAMP}[t] INFO: Failed: 0 succeeded, 1 failed (1.3s)`,
      ]),
    ).toEqual({
      _tag: "Failed",
      failure: "Failed: 0 succeeded, 1 failed (1.3s)",
      diagnostic: null,
    });
    expect(
      applyOfLines([
        ...throughSummary,
        STAMP + reload,
        `${STAMP}[t] INFO: Done: 4 succeeded (1s)`,
      ]),
    ).toEqual({ _tag: "Applied" });
  });

  it("names the cause of a failure before any apply, in the shape alchemy's exec.ts logs it", () => {
    expect(
      runOf(
        "[t] INFO: Dev · dev-mw",
        "[t] ERROR: alchemy dev: run failed; waiting for the next file change to retry.",
        "SyntaxError: Unexpected token '}'",
        "    at parse (alchemy.run.ts:3:1)",
      ),
    ).toEqual({
      _tag: "Failed",
      failure:
        "alchemy dev: run failed; waiting for the next file change to retry.",
      diagnostic: "SyntaxError: Unexpected token '}'",
    });
  });

  it("names no cause for an internally interrupted apply", () => {
    expect(
      runOf(
        "[t] INFO: Dev · dev-mw",
        "[t] ERROR: alchemy dev: apply was interrupted internally (a bug in a provider or the engine — please report it with the trace below); keeping dev alive so healthy resources keep serving.",
        "All fibers interrupted without error",
      ),
    ).toMatchObject({ _tag: "Failed", diagnostic: null });
  });

  it("names no cause when the report has none, and never alchemy's exit", () => {
    expect(
      runOf(
        "[t] INFO: Dev · dev-mw",
        "[t] INFO: Failed: 0 succeeded, 1 failed (1s)",
        `[t] ERROR: ${FAILURE}`,
        "    at apply (Apply.ts:1:1)",
        "",
        "Exited.",
        "==== dev exit run=2765bcc1 signal=SIGTERM",
      ),
    ).toEqual({ _tag: "Failed", failure: FAILURE, diagnostic: null });
    expect(
      runOf(
        "[t] INFO: Dev · dev-mw",
        `[t] ERROR: ${FAILURE}`,
        "==== dev exit run=2765bcc1 signal=SIGTERM",
      ),
    ).toEqual({ _tag: "Failed", failure: FAILURE, diagnostic: null });
  });

  it("ignores workerd's SQLite errors, which alchemy logs at info in healthy applies too", () => {
    const sqlite =
      "[t] INFO: workerd/jsg/util.c++:410: error: e = workerd/util/sqlite.c++:1772: failed: SQLite failed; dbErrorMessage(err, db) = attempt to write a readonly database: SQLITE_READONLY";
    expect(
      runOf(
        "[t] INFO: Dev · dev-mw",
        sqlite,
        "[t] INFO: Done: 6 succeeded (1s)",
      ),
    ).toEqual({ _tag: "Applied" });
    expect(
      runOf(
        "[t] INFO: Dev · dev-mw",
        sqlite,
        "[t] INFO: Failed: 0 succeeded, 1 failed (1s)",
      ),
    ).toEqual({
      _tag: "Failed",
      failure: "Failed: 0 succeeded, 1 failed (1s)",
      diagnostic: null,
    });
  });
});

describe("stateOf", () => {
  const record = Option.some({
    rigging: 1 as const,
    name: ServerName.make("dev"),
    run: RunId.make("0123abcd"),
    pid: 10,
    group: 11,
    startedAt: "2026-11-03T00:00:00.000Z",
    command: ["node"],
  });

  it("reads a dead runner with a live group as orphaned", () => {
    expect(
      stateOf(record, {
        runner: false,
        group: true,
        answering: true,
        apply: { _tag: "None" },
      }),
    ).toBe("orphaned");
  });

  it("reads a record with nothing alive as stopped", () => {
    expect(
      stateOf(record, {
        runner: false,
        group: false,
        answering: false,
        apply: { _tag: "None" },
      }),
    ).toBe("stopped");
  });

  it("reads a live runner whose command logged a failure as degraded, though it answers", () => {
    expect(
      stateOf(record, {
        runner: true,
        group: true,
        answering: true,
        apply: { _tag: "Failed", failure: "x", diagnostic: null },
      }),
    ).toBe("degraded");
  });

  it("reads a live runner that answers while its apply runs as starting", () => {
    expect(
      stateOf(record, {
        runner: true,
        group: true,
        answering: true,
        apply: { _tag: "Applying" },
      }),
    ).toBe("starting");
  });

  it("reads a live runner that does not answer yet as starting", () => {
    expect(
      stateOf(record, {
        runner: true,
        group: true,
        answering: false,
        apply: { _tag: "None" },
      }),
    ).toBe("starting");
  });
});

describe("listenerOf", () => {
  const command = 100;
  const parents = new Map([
    [100, 50],
    [101, 100],
    [102, 101],
    [200, 1],
    [201, 1],
  ]);
  const unmarked = new Set<number>();

  it("counts a listener that descends from the command as the server, though it left its group", () => {
    expect(listenerOf([102], parents, command, unmarked)).toEqual({
      _tag: "Server",
    });
  });

  it("reads any listener outside the command's tree as taken", () => {
    expect(listenerOf([101, 200], parents, command, unmarked)).toEqual({
      _tag: "Taken",
      pids: [200],
    });
  });

  it("counts a listener adopted by launchd as the server when it carries the run's marker", () => {
    expect(listenerOf([200, 201], parents, command, new Set([200]))).toEqual({
      _tag: "Taken",
      pids: [201],
    });
    expect(listenerOf([200], parents, command, new Set([200]))).toEqual({
      _tag: "Server",
    });
  });

  it("reads a port whose listeners have all exited as free", () => {
    expect(listenerOf([300], parents, command, unmarked)).toEqual({
      _tag: "Free",
    });
  });
});
