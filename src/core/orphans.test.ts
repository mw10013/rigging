import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isWithin,
  orphaned,
  orphansIn,
  parseCwds,
  parseProcesses,
  stopOrphans,
} from "./orphans.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const directories: string[] = [];
const pids: number[] = [];

const directory = () => {
  const made = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "orphans-")),
  );
  directories.push(made);
  return made;
};

const orphan = (cwd: string) => {
  const pid = Number(
    execFileSync("sh", ["-c", "sleep 600 >/dev/null 2>&1 & echo $!"], {
      cwd,
      encoding: "utf8",
    }).trim(),
  );
  pids.push(pid);
  return pid;
};

afterEach(() => {
  for (const pid of pids.splice(0))
    if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const made of directories.splice(0))
    fs.rmSync(made, { recursive: true, force: true });
});

describe("orphansIn", () => {
  it("finds an orphan working inside the directory and stops it", () => {
    const root = directory();
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    const inside = orphan(nested);
    const outside = orphan(directory());

    const found = orphansIn(root);
    expect(found.map(({ pid }) => pid)).toEqual([inside]);
    expect(path.basename(found[0].command)).toBe("sleep");

    stopOrphans(found);
    expect(alive(inside)).toBe(false);
    expect(alive(outside)).toBe(true);
  });

  it("ignores a process whose parent still runs", () => {
    const root = directory();
    const owned = spawn("sleep", ["600"], { cwd: root, stdio: "ignore" });
    if (owned.pid === undefined) throw new Error("sleep did not spawn");
    pids.push(owned.pid);
    expect(orphansIn(root)).toEqual([]);
  });
});

describe("stopOrphans", () => {
  it("passes over a pid that has already exited", () => {
    const gone = Number(
      execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim(),
    );

    expect(() => {
      stopOrphans([{ pid: gone, command: "sleep", cwd: "/" }]);
    }).not.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)(
    "throws when it may not signal the pid",
    () => {
      expect(() => {
        stopOrphans([{ pid: 1, command: "launchd", cwd: "/" }]);
      }).toThrow(expect.objectContaining({ code: "EPERM" }));
    },
  );
});

describe("parsers", () => {
  it("reads ps lines whose executable path has spaces", () => {
    expect(
      parseProcesses(
        "  12     1 /Applications/My App/bin/workerd\n 13 12 sh\n",
      ),
    ).toEqual([
      { pid: 12, ppid: 1, command: "/Applications/My App/bin/workerd" },
      { pid: 13, ppid: 12, command: "sh" },
    ]);
  });

  it("takes a workerd under pid 1 or a systemd user manager as orphaned, not one under a shell", () => {
    const table = parseProcesses(
      [
        "    1     0 /usr/lib/systemd/systemd",
        "  900     1 systemd",
        "  901     1 workerd",
        "  902   900 workerd",
        "  950   900 bash",
        "  951   950 workerd",
      ].join("\n"),
    );
    expect(
      orphaned(table)
        .filter(({ command }) => command === "workerd")
        .map(({ pid }) => pid),
    ).toEqual([901, 902]);
  });

  it("reads lsof's pid and name fields", () => {
    expect(parseCwds("p12\nfcwd\nn/a/b\np13\nfcwd\nn/c\n")).toEqual(
      new Map([
        [12, "/a/b"],
        [13, "/c"],
      ]),
    );
  });

  it("counts a directory and what is below it, not a sibling sharing its prefix", () => {
    expect(isWithin("/w/app", "/w/app")).toBe(true);
    expect(isWithin("/w/app/src", "/w/app")).toBe(true);
    expect(isWithin("/w/app-2", "/w/app")).toBe(false);
  });
});
