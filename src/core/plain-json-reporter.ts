/**
 * A Playwright reporter that rewrites the `json` reporter's `outputFile` without ANSI escapes,
 * after every reporter has finished. Playwright runs its workers with `FORCE_COLOR=1`, so error
 * messages, stacks and captured output reach the `json` reporter coloured. It finds the file as the
 * `json` reporter does: `PLAYWRIGHT_JSON_OUTPUT_FILE` against the working directory, else
 * `outputFile` against the config's directory.
 *
 * @module
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";

export default class PlainJsonReporter {
  readonly #outputFile: string;

  constructor({
    outputFile,
    configDir,
  }: {
    readonly outputFile: string;
    readonly configDir: string;
  }) {
    const override = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
    this.#outputFile =
      override === undefined || override === ""
        ? path.resolve(configDir, outputFile)
        : path.resolve(override);
  }

  printsToStdio() {
    return false;
  }

  onExit() {
    const report: unknown = JSON.parse(
      readFileSync(this.#outputFile, "utf8"),
      (_key, value: unknown) =>
        typeof value === "string" ? stripVTControlCharacters(value) : value,
    );
    writeFileSync(this.#outputFile, JSON.stringify(report, undefined, 2));
  }
}
