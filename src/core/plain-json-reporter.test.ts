import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import PlainJsonReporter from "#rigging/core/plain-json-reporter.ts";

const report = (paint: (text: string) => string) => ({
  suites: [
    {
      specs: [
        {
          ok: false,
          tests: [
            {
              results: [
                {
                  retry: 0,
                  error: { message: `${paint("Expected")}: 2` },
                  stdout: [{ text: `{ n: ${paint("1")} }\n` }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const colouredReport = () => {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "rigging-report-")),
    "results.json",
  );
  writeFileSync(
    file,
    JSON.stringify(report((text) => `\u001B[31m${text}\u001B[39m`)),
  );
  return file;
};

const expectPlain = (file: string) => {
  const written = readFileSync(file, "utf8");
  expect(written).not.toContain(String.raw`\u001b`);
  expect(JSON.parse(written)).toEqual(report((text) => text));
};

describe("PlainJsonReporter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rewrites the json report without ANSI escapes", () => {
    const outputFile = colouredReport();
    new PlainJsonReporter({ outputFile }).onExit();
    expectPlain(outputFile);
  });

  it("rewrites the file PLAYWRIGHT_JSON_OUTPUT_FILE names, as the json reporter does", () => {
    const outputFile = colouredReport();
    vi.stubEnv("PLAYWRIGHT_JSON_OUTPUT_FILE", outputFile);
    new PlainJsonReporter({
      outputFile: path.join(path.dirname(outputFile), "configured.json"),
    }).onExit();
    expectPlain(outputFile);
  });
});
