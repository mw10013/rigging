import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

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

  it.each([
    {
      name: "an absolute outputFile",
      options: (file: string) => ({ outputFile: file, configDir: tmpdir() }),
    },
    {
      name: "an outputFile relative to configDir",
      options: (file: string) => ({
        outputFile: path.basename(file),
        configDir: path.dirname(file),
      }),
    },
    {
      name: "PLAYWRIGHT_JSON_OUTPUT_FILE, relative to the working directory",
      override: (file: string) => path.relative(process.cwd(), file),
      options: (file: string) => ({
        outputFile: "configured.json",
        configDir: path.dirname(file),
      }),
    },
    {
      name: "outputFile when PLAYWRIGHT_JSON_OUTPUT_FILE is empty",
      override: () => "",
      options: (file: string) => ({
        outputFile: path.basename(file),
        configDir: path.dirname(file),
      }),
    },
  ])(
    "rewrites the file the json reporter wrote: $name",
    ({ options, override }) => {
      const file = colouredReport();
      vi.stubEnv("PLAYWRIGHT_JSON_OUTPUT_FILE", override?.(file));
      new PlainJsonReporter(options(file)).onExit();
      expectPlain(file);
    },
  );
});
