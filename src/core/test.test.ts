import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "@effect/vitest";

import { e2eConfig, runningServer } from "#rigging/core/test.ts";

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

describe("e2eConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("unsets NO_COLOR, which Playwright's workers get beside FORCE_COLOR=1", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("E2E_RUN_DIR", mkdtempSync(path.join(tmpdir(), "rigging-e2e-")));
    expect(() => e2eConfig({ root: stoppedApp() })).toThrow(
      "the e2e server is stopped",
    );
    expect(process.env.NO_COLOR).toBeUndefined();
  });
});
