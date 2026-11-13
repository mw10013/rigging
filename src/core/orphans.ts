/**
 * An integration run's workerd outlives a test process that dies mid-run: Alchemy's sidecar,
 * workerd's parent, exits without stopping it, so it holds its ports with pid 1 as its parent.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as Duration from "effect/Duration";

export interface Orphan {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
}

const STOP_GRACE = Duration.seconds(3);
const STOP_POLL = Duration.millis(100);

const output = (program: string, args: readonly string[]) => {
  try {
    return execFileSync(program, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `lsof` exits 1 when some pid has gone, and still prints the rest.
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
};

export const parseProcesses = (text: string) =>
  text.split("\n").flatMap((line) => {
    const fields = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.+?)\s*$/u.exec(
      line,
    )?.groups;
    return fields?.pid === undefined ||
      fields.ppid === undefined ||
      fields.command === undefined
      ? []
      : [
          {
            pid: Number(fields.pid),
            ppid: Number(fields.ppid),
            command: fields.command,
          },
        ];
  });

export const parseCwds = (text: string) => {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined)
      cwds.set(pid, line.slice(1));
  }
  return cwds;
};

export const isWithin = (cwd: string, directory: string) =>
  cwd === directory || cwd.startsWith(`${directory}${path.sep}`);

export const orphansIn = (directory: string): readonly Orphan[] => {
  const root = fs.realpathSync(directory);
  const parentless = parseProcesses(
    output("ps", ["-A", "-o", "pid=,ppid=,comm="]),
  ).filter((process) => process.ppid === 1);
  if (parentless.length === 0) return [];
  const cwds = parseCwds(
    output("lsof", [
      "-a",
      "-d",
      "cwd",
      "-Fpn",
      "-p",
      parentless.map((process) => String(process.pid)).join(","),
    ]),
  );
  return parentless.flatMap(({ pid, command }) => {
    const cwd = cwds.get(pid);
    return cwd !== undefined && isWithin(cwd, root)
      ? [{ pid, command, cwd }]
      : [];
  });
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already.
  }
};

export const stopOrphans = (orphans: readonly Orphan[]) => {
  for (const { pid } of orphans) signal(pid, "SIGTERM");
  const deadline = performance.now() + Duration.toMillis(STOP_GRACE);
  let running = orphans.filter(({ pid }) => alive(pid));
  while (running.length > 0 && performance.now() < deadline) {
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Duration.toMillis(STOP_POLL),
    );
    running = running.filter(({ pid }) => alive(pid));
  }
  for (const { pid } of running) signal(pid, "SIGKILL");
};

export const describeOrphan = ({ pid, command }: Orphan) =>
  `pid ${String(pid)} (${path.basename(command)})`;
