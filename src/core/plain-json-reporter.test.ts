import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";

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

describe("PlainJsonReporter", () => {
  it("rewrites the json report without ANSI escapes", () => {
    const outputFile = path.join(
      mkdtempSync(path.join(tmpdir(), "rigging-report-")),
      "results.json",
    );
    writeFileSync(
      outputFile,
      JSON.stringify(report((text) => `\u001B[31m${text}\u001B[39m`)),
    );
    new PlainJsonReporter({ outputFile }).onExit();
    const written = readFileSync(outputFile, "utf8");
    expect(written).not.toContain(String.raw`\u001b`);
    expect(JSON.parse(written)).toEqual(report((text) => text));
  });
});
