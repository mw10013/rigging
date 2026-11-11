/**
 * A Playwright reporter that rewrites the `json` reporter's `outputFile` without ANSI escapes,
 * after every reporter has finished. Playwright runs its workers with `FORCE_COLOR=1`, so error
 * messages, stacks and captured output reach the `json` reporter coloured. Like the `json`
 * reporter, it takes `PLAYWRIGHT_JSON_OUTPUT_FILE` over `outputFile`.
 *
 * @module
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";

export default class PlainJsonReporter {
  readonly #outputFile: string;

  constructor({ outputFile }: { readonly outputFile: string }) {
    const override = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
    this.#outputFile = path.resolve(
      override === undefined || override === "" ? outputFile : override,
    );
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
