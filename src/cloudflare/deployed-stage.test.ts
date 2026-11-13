import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { app } from "#rigging/core/app.ts";

import {
  type BuildConfig,
  buildDrift,
  buildPlan,
  canonicalBuild,
  ensureWebsite,
  readBuildConfig,
  replacesWebsite,
  stageVariables,
  staleVariables,
  variableProblems,
} from "./deployed-stage.ts";

const TOKEN = "9faa0f15-edb6-4265-aa27-2f944dd4c14e";

const configFor = (
  canonical: ReturnType<typeof canonicalBuild>,
  overrides: {
    readonly repo_name?: string;
    readonly branch?: string;
    readonly previews_enabled?: boolean;
    readonly production_settings?: Partial<BuildConfig["production_settings"]>;
  } = {},
): BuildConfig => ({
  git_repository: {
    repo_name: overrides.repo_name ?? "baton",
    branch: overrides.branch ?? canonical.branch,
  },
  production_settings: {
    ...canonical.production_settings,
    environment_variables: {},
    ...overrides.production_settings,
  },
  previews_enabled: overrides.previews_enabled ?? canonical.previews_enabled,
});

describe("canonicalBuild", () => {
  it("builds the stage's branch with previews off and deploys through the stage's script", () => {
    expect(canonicalBuild("staging", TOKEN)).toStrictEqual({
      branch: "main",
      previews_enabled: false,
      production_settings: {
        build_token_uuid: TOKEN,
        build_command: "",
        deploy_command: "pnpm exec vp run deploy:staging",
        root_directory: "/",
        path_includes: ["*"],
        path_excludes: [],
        build_caching_enabled: false,
      },
    });
    expect(canonicalBuild("production", TOKEN).branch).toBe("production");
  });
});

describe("buildDrift", () => {
  const canonical = canonicalBuild("production", TOKEN);

  it("is empty for a canonical configuration, whatever its variables", () => {
    expect(
      buildDrift(
        configFor(canonical, {
          production_settings: {
            environment_variables: { API_KEY: { is_secret: false } },
          },
        }),
        canonical,
      ),
    ).toStrictEqual([]);
  });

  it("names each differing setting, the branch and previews", () => {
    expect(
      buildDrift(
        configFor(canonical, {
          branch: "main",
          previews_enabled: true,
          production_settings: {
            build_token_uuid: "other-token",
            deploy_command:
              "pnpm exec vp exec alchemy deploy --stage production --yes",
            path_includes: ["src/*"],
          },
        }),
        canonical,
      ),
    ).toStrictEqual([
      "build_token_uuid",
      "deploy_command",
      "path_includes",
      "branch",
      "previews_enabled",
    ]);
  });
});

describe("buildPlan", () => {
  const canonical = canonicalBuild("production", TOKEN);

  it("creates the configuration when the Website has none", () => {
    expect(buildPlan(canonical, "baton", Option.none())).toStrictEqual([
      { _tag: "Create" },
    ]);
  });

  it("replaces a configuration on another repository", () => {
    expect(
      buildPlan(
        canonical,
        "baton",
        Option.some(configFor(canonical, { repo_name: "other" })),
      ),
    ).toStrictEqual([
      { _tag: "Delete", repoName: "other" },
      { _tag: "Create" },
    ]);
  });

  it("updates a drifted configuration in place, previews included", () => {
    expect(
      buildPlan(
        canonical,
        "baton",
        Option.some(
          configFor(canonical, {
            previews_enabled: true,
            production_settings: { build_caching_enabled: true },
          }),
        ),
      ),
    ).toStrictEqual([
      {
        _tag: "Update",
        settings: ["build_caching_enabled", "previews_enabled"],
      },
    ]);
  });

  it("is empty for a canonical configuration", () => {
    expect(
      buildPlan(canonical, "baton", Option.some(configFor(canonical))),
    ).toStrictEqual([]);
  });
});

const PLAN = `[20:38:14.751] INFO: Plan ready (20.7s)
[20:38:14.752] INFO: Plan: 2 to update, 1 tasks
[20:38:14.752] INFO: [Backend] update
[20:38:14.753] INFO: [Database] noop
[20:38:14.753] INFO: [Website] update
[20:38:14.753] INFO: [Website/BACKEND] noop
[20:38:14.753] INFO: [Seed] run [action]
`;

describe("replacesWebsite", () => {
  it("spots the Website's replacement after the log prefix", () => {
    expect(
      replacesWebsite(PLAN.replace("[Website] update", "[Website] replace")),
    ).toBe(true);
    expect(
      replacesWebsite(
        "\u001B[90m[20:38:14.753]\u001B[0m \u001B[32mINFO\u001B[0m: \u001B[36m[Website]\u001B[0m \u001B[33mreplace\u001B[0m",
      ),
    ).toBe(true);
  });

  it("ignores an update and the replacement of another resource or a binding", () => {
    expect(replacesWebsite(PLAN)).toBe(false);
    expect(
      replacesWebsite(
        `${PLAN.replace("[Backend] update", "[Backend] replace").replace(
          "[Website/BACKEND] noop",
          "[Website/BACKEND] replace",
        )}[20:38:14.753] INFO: [WebsiteAssets] replace\n`,
      ),
    ).toBe(false);
  });
});

const Fields = Schema.Struct({
  API_KEY: Schema.NonEmptyString,
  API_SECRET: Schema.Redacted(Schema.String.check(Schema.isPattern(/^sk_/u))),
  CONTROL_TOKEN: Schema.optional(
    Schema.Redacted(Schema.String.check(Schema.isPattern(/^ct_/u))),
  ),
});

const SECRET = "sk_s3cr3t-value";
const CONTROL_TOKEN = "ct_s3cr3t-token";

const variablesOf = (file: Record<string, string>) =>
  Effect.runSyncExit(stageVariables(Fields, file, ".env.staging"));

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

const shownVariablesOf = (file: Record<string, string>) => {
  const exit = variablesOf(file);
  return Exit.isSuccess(exit)
    ? exit.value.map(({ name, value, secret }) => ({
        name,
        value: Redacted.value(value),
        secret,
      }))
    : failureOf(exit);
};

describe("stageVariables", () => {
  it("makes one variable per field the file sets, a Redacted field a secret, the value the file's raw string", () => {
    expect(
      shownVariablesOf({
        API_KEY: "key",
        API_SECRET: SECRET,
        CONTROL_TOKEN,
      }),
    ).toStrictEqual([
      { name: "API_KEY", value: "key", secret: false },
      { name: "API_SECRET", value: SECRET, secret: true },
      { name: "CONTROL_TOKEN", value: CONTROL_TOKEN, secret: true },
    ]);
  });

  it("makes no variable for an optional field the file leaves out or leaves empty", () => {
    const required = [
      { name: "API_KEY", value: "key", secret: false },
      { name: "API_SECRET", value: SECRET, secret: true },
    ];
    expect(
      shownVariablesOf({ API_KEY: "key", API_SECRET: SECRET }),
    ).toStrictEqual(required);
    expect(
      shownVariablesOf({
        API_KEY: "key",
        API_SECRET: SECRET,
        CONTROL_TOKEN: "",
      }),
    ).toStrictEqual(required);
  });

  it("names an optional field the file holds invalid, never its value", () => {
    const message = failureOf(
      variablesOf({
        API_KEY: "key",
        API_SECRET: SECRET,
        CONTROL_TOKEN: "bad-token",
      }),
    );
    expect(message).toContain("lacks or has invalid CONTROL_TOKEN");
    expect(message).not.toContain("bad-token");
  });

  it("names a missing, invalid or undeclared field, never a value", () => {
    const message = failureOf(
      variablesOf({ API_SECRET: "not-a-key", EXTRA: SECRET }),
    );
    expect(message).toContain("lacks or has invalid API_KEY, API_SECRET");
    expect(message).toContain(
      "holds EXTRA, which stacks/stage-env.ts does not declare",
    );
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("not-a-key");
  });

  it("refuses an empty value for a non-empty field", () => {
    expect(
      failureOf(variablesOf({ API_KEY: "", API_SECRET: SECRET })),
    ).toContain("lacks or has invalid API_KEY");
  });
});

describe("build configuration variables", () => {
  const variablesFor = (file: Record<string, string>) => {
    const exit = variablesOf(file);
    return Exit.isSuccess(exit) ? exit.value : [];
  };
  const variables = variablesFor({ API_KEY: "key", API_SECRET: SECRET });

  it("finds the configuration's variables the file does not set", () => {
    expect(
      staleVariables(variables, {
        API_KEY: { is_secret: false },
        OLD: { is_secret: true },
      }),
    ).toStrictEqual(["OLD"]);
  });

  it("reports a missing name, a wrong secrecy and an undeclared name, and nothing when they match", () => {
    expect(
      variableProblems(variables, {
        API_KEY: { is_secret: true },
        OLD: { is_secret: false },
      }),
    ).toStrictEqual([
      "the build configuration holds API_KEY as a secret",
      "the build configuration lacks API_SECRET",
      "the build configuration holds OLD, which the file does not set",
    ]);
    expect(
      variableProblems(variables, {
        API_KEY: { is_secret: false },
        API_SECRET: { is_secret: true },
      }),
    ).toStrictEqual([]);
  });

  it("deletes an optional field the file leaves out from the configuration, and sets it where the file holds it", () => {
    const existing = {
      API_KEY: { is_secret: false },
      API_SECRET: { is_secret: true },
      CONTROL_TOKEN: { is_secret: true },
    };
    expect(variables.map(({ name }) => name)).toStrictEqual([
      "API_KEY",
      "API_SECRET",
    ]);
    expect(staleVariables(variables, existing)).toStrictEqual([
      "CONTROL_TOKEN",
    ]);
    expect(variableProblems(variables, existing)).toStrictEqual([
      "the build configuration holds CONTROL_TOKEN, which the file does not set",
    ]);
    const staging = variablesFor({
      API_KEY: "key",
      API_SECRET: SECRET,
      CONTROL_TOKEN,
    });
    expect(staleVariables(staging, existing)).toStrictEqual([]);
    expect(variableProblems(staging, existing)).toStrictEqual([]);
  });
});

const FAKES = {
  cf: `#!/bin/sh
case "$*" in
  "workers scripts search --name "*) cat "$DEVKIT_FAKES/scripts.json" ;;
  "builds workers get "*)
    if [ -f "$DEVKIT_FAKES/config.json" ]; then cat "$DEVKIT_FAKES/config.json"
    else cat "$DEVKIT_FAKES/config.err" >&2; exit 1; fi ;;
  *) echo "unexpected cf $*" >&2; exit 1 ;;
esac
`,
  git: `#!/bin/sh
shift 2
echo "$*" >> "$DEVKIT_FAKES/git.log"
case "$*" in
  "status --porcelain") cat "$DEVKIT_FAKES/status" ;;
  "fetch origin "*) ;;
  "rev-parse HEAD") cat "$DEVKIT_FAKES/head" ;;
  "rev-parse origin/"*) cat "$DEVKIT_FAKES/origin" ;;
  *) echo "unexpected git $*" >&2; exit 1 ;;
esac
`,
  alchemy: `#!/bin/sh
echo "$*" > "$DEVKIT_FAKES/alchemy.args"
echo "$DEVKIT_STAGE_RUN $API_KEY $API_SECRET" > "$DEVKIT_FAKES/alchemy.env"
cp "$DEVKIT_FAKES/deployed.json" "$DEVKIT_FAKES/scripts.json"
`,
};

const useFakes = () => {
  const saved = { path: process.env.PATH, fakes: process.env.DEVKIT_FAKES };
  let fakes = "";
  const fake = (file: string) => path.join(fakes, file);

  beforeEach(() => {
    fakes = fs.mkdtempSync(path.join(os.tmpdir(), "rigging-stage-"));
    for (const [name, script] of Object.entries(FAKES))
      fs.writeFileSync(fake(name), script, { mode: 0o755 });
    fs.writeFileSync(fake("scripts.json"), "[]");
    fs.writeFileSync(fake("deployed.json"), website("staging", "tag-new"));
    process.env.PATH = `${fakes}:/usr/bin:/bin`;
    process.env.DEVKIT_FAKES = fakes;
  });

  afterEach(() => {
    process.env.PATH = saved.path;
    process.env.DEVKIT_FAKES = saved.fakes;
    fs.rmSync(fakes, { recursive: true, force: true });
  });

  return {
    dir: () => fakes,
    fake,
    read: (file: string) =>
      fs.existsSync(fake(file)) ? fs.readFileSync(fake(file), "utf8") : "",
  };
};

const website = (stage: "staging" | "production", id: string) =>
  JSON.stringify([{ id, script_name: `${app().name}-website-${stage}` }]);

describe("readBuildConfig", () => {
  const { fake } = useFakes();
  const run = () =>
    Effect.runPromiseExit(
      readBuildConfig("tag-old").pipe(Effect.provide(NodeServices.layer)),
    );
  const canonical = canonicalBuild("staging", TOKEN);

  it("reads the Worker's configuration", async () => {
    const config = configFor(canonical, {
      production_settings: {
        environment_variables: { API_KEY: { is_secret: false } },
      },
    });
    fs.writeFileSync(fake("config.json"), JSON.stringify(config));
    const result = await run();
    expect(Exit.isSuccess(result) && result.value).toStrictEqual(
      Option.some(config),
    );
  });

  it("reads none when Builds has no configuration for the Worker, so the plan creates one", async () => {
    fs.writeFileSync(
      fake("config.err"),
      "[12040] No build configuration associated with that script tag was found\n404 Not Found\n",
    );
    const result = await run();
    expect(Exit.isSuccess(result) && result.value).toStrictEqual(Option.none());
    expect(
      Exit.isSuccess(result) && buildPlan(canonical, "baton", result.value),
    ).toStrictEqual([{ _tag: "Create" }]);
  });

  it("fails on any other cf failure", async () => {
    fs.writeFileSync(fake("config.err"), "[10000] Authentication error\n");
    expect(failureOf(await run())).toContain("Authentication error");
  });
});

describe("ensureWebsite", () => {
  const { dir, fake, read } = useFakes();
  const checkout = (state: {
    status?: string;
    head?: string;
    origin?: string;
  }) => {
    fs.writeFileSync(fake("status"), state.status ?? "");
    fs.writeFileSync(fake("head"), state.head ?? "abc123\n");
    fs.writeFileSync(fake("origin"), state.origin ?? "abc123\n");
  };
  const exit = variablesOf({ API_KEY: "key", API_SECRET: SECRET });
  const variables = Exit.isSuccess(exit) ? exit.value : [];
  const run = (stage: "staging" | "production") =>
    Effect.runPromiseExit(
      ensureWebsite(stage, variables).pipe(Effect.provide(NodeServices.layer)),
    );

  it("reaches only the fake alchemy", () => {
    expect(
      (process.env.PATH ?? "")
        .split(":")
        .filter((directory) => fs.existsSync(path.join(directory, "alchemy"))),
    ).toStrictEqual([dir()]);
  });

  it("deploys a missing Website from a clean checkout at origin, values in the environment only", async () => {
    checkout({});
    const result = await run("staging");
    expect(Exit.isSuccess(result) && result.value).toBe("tag-new");
    expect(read("git.log")).toContain("fetch origin main");
    expect(read("alchemy.args")).toBe("deploy --stage staging --yes\n");
    expect(read("alchemy.env")).toBe(`up key ${SECRET}\n`);
  });

  it("checks production's checkout against origin/production", async () => {
    checkout({});
    fs.writeFileSync(fake("deployed.json"), website("production", "tag-prod"));
    const result = await run("production");
    expect(Exit.isSuccess(result) && result.value).toBe("tag-prod");
    expect(read("git.log")).toContain("rev-parse origin/production");
    expect(read("alchemy.args")).toBe("deploy --stage production --yes\n");
  });

  it("refuses a dirty checkout before deploying", async () => {
    checkout({ status: " M src/app.ts\n" });
    expect(failureOf(await run("staging"))).toContain(
      "has uncommitted changes; commit or stash them",
    );
    expect(read("alchemy.args")).toBe("");
  });

  it("refuses a checkout that is not origin's branch", async () => {
    checkout({ head: "abc123\n", origin: "def456\n" });
    expect(failureOf(await run("staging"))).toContain(
      "HEAD abc123 is not origin/main def456; check out main at origin/main (git switch main, then git pull --ff-only if behind or git push if ahead)",
    );
    expect(read("alchemy.args")).toBe("");
  });

  it("deploys nothing and reads no checkout when the Website exists", async () => {
    fs.writeFileSync(fake("scripts.json"), website("staging", "tag-old"));
    const result = await run("staging");
    expect(Exit.isSuccess(result) && result.value).toBe("tag-old");
    expect(read("git.log")).toBe("");
    expect(read("alchemy.args")).toBe("");
  });
});
