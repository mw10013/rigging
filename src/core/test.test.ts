import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "@effect/vitest";

import { runningServer } from "#rigging/core/test.ts";

const stoppedApp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "rigging-test-"));
  writeFileSync(path.join(root, "package.json"), `{"name":"app"}`);
  return root;
};

beforeAll(() => {
  const bin = path.resolve(import.meta.dirname, "../../node_modules/.bin");
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
});

describe("runningServer", () => {
  it("names the app's start script when the server is stopped", () => {
    const root = stoppedApp();
    expect(() => runningServer("e2e", root)).toThrow(
      "the e2e server is stopped: start it with vp run e2e:start",
    );
    expect(() => runningServer("dev", root)).toThrow(
      "start it with vp run dev",
    );
    expect(() => runningServer("e2e", root, "vp run serve")).toThrow(
      "start it with vp run serve",
    );
  });
});
