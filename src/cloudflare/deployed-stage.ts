import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv, stripVTControlCharacters } from "node:util";

import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  checkStageEnv,
  type StageFieldEnv,
  type StageFields,
} from "#rigging/cloudflare/deployed-stack.ts";
import {
  branchOf,
  Deployed,
  ResettableDeployed,
  STAGE_RUN,
  type StageRun,
  workerNameOf,
} from "#rigging/cloudflare/stage.ts";
import { app } from "#rigging/core/app.ts";
import { runCommand } from "#rigging/core/command.ts";

class StageError extends Schema.TaggedError<StageError>()("StageError", {
  message: Schema.String,
}) {}

/**
 * The account's one build token, chosen by name because its uuid is not ours to fix. Builds
 * deploys with its permissions, so it must cover everything a deploy touches (Workers, D1,
 * routes and custom domains).
 */
export const SHARED_BUILD_TOKEN = "Workers Builds - 2026-05-31 17:29";

export const STAGE_ENV_MODULE = "stacks/stage-env.ts";

const websiteOf = (stage: Deployed) =>
  workerNameOf(app().name, stage, "website");

/** A secret's value reads back `null`, so only its name and secrecy are decoded. */
const Variables = Schema.Record(
  Schema.String,
  Schema.Struct({ is_secret: Schema.Boolean }),
);
type Variables = typeof Variables.Type;

export const BuildConfig = Schema.Struct({
  git_repository: Schema.Struct({
    repo_name: Schema.String,
    branch: Schema.String,
  }),
  production_settings: Schema.Struct({
    build_token_uuid: Schema.String,
    build_command: Schema.String,
    deploy_command: Schema.String,
    root_directory: Schema.String,
    path_includes: Schema.Array(Schema.String),
    path_excludes: Schema.Array(Schema.String),
    build_caching_enabled: Schema.Boolean,
    environment_variables: Variables,
  }),
  previews_enabled: Schema.Boolean,
});
export type BuildConfig = typeof BuildConfig.Type;

export const canonicalBuild = (stage: Deployed, buildTokenUuid: string) => ({
  branch: branchOf(stage),
  previews_enabled: false,
  production_settings: {
    build_token_uuid: buildTokenUuid,
    build_command: "",
    deploy_command: `pnpm exec vp run deploy:${stage}`,
    root_directory: "/",
    path_includes: ["*"],
    path_excludes: [],
    build_caching_enabled: false,
  },
});
export type CanonicalBuild = ReturnType<typeof canonicalBuild>;

export const buildDrift = (
  config: BuildConfig,
  canonical: CanonicalBuild,
): readonly string[] => [
  ...(
    Object.keys(
      canonical.production_settings,
    ) as (keyof CanonicalBuild["production_settings"])[]
  ).filter(
    (key) =>
      JSON.stringify(config.production_settings[key]) !==
      JSON.stringify(canonical.production_settings[key]),
  ),
  ...(config.git_repository.branch === canonical.branch ? [] : ["branch"]),
  ...(config.previews_enabled === canonical.previews_enabled
    ? []
    : ["previews_enabled"]),
];

export type BuildStep =
  | { readonly _tag: "Create" }
  | { readonly _tag: "Update"; readonly settings: readonly string[] }
  | { readonly _tag: "Delete"; readonly repoName: string };

/** Builds' update cannot change a configuration's repository. */
export const buildPlan = (
  canonical: CanonicalBuild,
  repoName: string,
  config: Option.Option<BuildConfig>,
): readonly BuildStep[] => {
  if (Option.isNone(config)) return [{ _tag: "Create" }];
  const found = config.value.git_repository.repo_name;
  if (found !== repoName)
    return [{ _tag: "Delete", repoName: found }, { _tag: "Create" }];
  const settings = buildDrift(config.value, canonical);
  return settings.length > 0 ? [{ _tag: "Update", settings }] : [];
};

const describeStep =
  (stage: Deployed) =>
  (step: BuildStep): string => {
    switch (step._tag) {
      case "Create": {
        return `create the ${stage} build configuration`;
      }
      case "Update": {
        return `update ${step.settings.join(", ")} on the ${stage} build configuration`;
      }
      case "Delete": {
        return `delete the ${stage} build configuration, which builds ${step.repoName}`;
      }
    }
  };

export type StageVariable = Extract<StageFieldEnv, { readonly _tag: "Set" }>;

export const stageVariables = Effect.fn("DeployedStage.stageVariables")(
  function* (
    fields: StageFields,
    file: Readonly<Record<string, string>>,
    source: string,
  ) {
    const env = yield* checkStageEnv(fields, file);
    const invalid = env
      .filter((field) => field._tag === "Invalid")
      .map(({ name }) => name);
    const undeclared = Object.keys(file).filter(
      (name) => !Object.hasOwn(fields.fields, name),
    );
    const problems = [
      ...(invalid.length > 0
        ? [`lacks or has invalid ${invalid.join(", ")}`]
        : []),
      ...(undeclared.length > 0
        ? [
            `holds ${undeclared.join(", ")}, which ${STAGE_ENV_MODULE} does not declare`,
          ]
        : []),
    ];
    if (problems.length > 0)
      return yield* new StageError({
        message: `${source} ${problems.join(" and ")}`,
      });
    return env.filter((field): field is StageVariable => field._tag === "Set");
  },
);

export const staleVariables = (
  variables: readonly StageVariable[],
  existing: Variables,
): readonly string[] =>
  Object.keys(existing).filter(
    (name) => !variables.some((variable) => variable.name === name),
  );

/** Compares by name and secrecy only: a secret's value cannot be read back. */
export const variableProblems = (
  variables: readonly StageVariable[],
  existing: Variables,
): readonly string[] => [
  ...variables.flatMap(({ name, secret }) => {
    const found = existing[name];
    if (found === undefined) return [`the build configuration lacks ${name}`];
    if (found.is_secret !== secret)
      return [
        `the build configuration holds ${name} as ${found.is_secret ? "a secret" : "plain"}`,
      ];
    return [];
  }),
  ...staleVariables(variables, existing).map(
    (name) =>
      `the build configuration holds ${name}, which the file does not set`,
  ),
];

const decodeJson =
  <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    what: string,
  ) =>
  (text: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(
        () => new StageError({ message: `unexpected output from ${what}` }),
      ),
    );

const cf = (args: readonly string[]) =>
  runCommand("cf", args).pipe(
    Effect.mapError((error) => new StageError({ message: error.message })),
  );

const loadStageFields = Effect.fn("DeployedStage.loadStageFields")(
  function* () {
    const file = path.join(app().root, STAGE_ENV_MODULE);
    const module: unknown = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(file).href),
      catch: () => new StageError({ message: `cannot load ${file}` }),
    });
    const fields =
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : undefined;
    if (!Schema.isSchema(fields) || !("fields" in fields))
      return yield* new StageError({
        message: `${STAGE_ENV_MODULE} must export a Schema.Struct of the stage's fields as its default`,
      });
    return fields as StageFields;
  },
);

const readStageFile = Effect.fn("DeployedStage.readStageFile")(function* (
  stage: Deployed,
) {
  const fields = yield* loadStageFields();
  const name = `.env.${stage}`;
  const text = yield* (yield* FileSystem.FileSystem)
    .readFileString(path.join(app().root, name))
    .pipe(
      Effect.mapError(
        () =>
          new StageError({ message: `cannot read ${name} at ${app().root}` }),
      ),
    );
  const file = Object.fromEntries(
    Object.entries(parseEnv(text)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return yield* stageVariables(fields, file, name);
});

const findTag = Effect.fn("DeployedStage.findTag")(function* (name: string) {
  const scripts = yield* cf([
    "workers",
    "scripts",
    "search",
    "--name",
    name,
  ]).pipe(
    Effect.flatMap(
      decodeJson(
        Schema.Array(
          Schema.Struct({ id: Schema.String, script_name: Schema.String }),
        ),
        "cf workers scripts search",
      ),
    ),
  );
  return Option.map(
    Option.fromNullishOr(scripts.find((script) => script.script_name === name)),
    (script) => script.id,
  );
});

const sharedBuildToken = Effect.fn("DeployedStage.sharedBuildToken")(
  function* () {
    const tokens = yield* cf(["builds", "tokens", "list"]).pipe(
      Effect.flatMap(
        decodeJson(
          Schema.Array(
            Schema.Struct({
              build_token_uuid: Schema.String,
              build_token_name: Schema.String,
            }),
          ),
          "cf builds tokens list",
        ),
      ),
    );
    const token = tokens.find(
      (candidate) => candidate.build_token_name === SHARED_BUILD_TOKEN,
    );
    if (token === undefined)
      return yield* new StageError({
        message: `no build token named "${SHARED_BUILD_TOKEN}"; the owner makes it in the dashboard`,
      });
    return token.build_token_uuid;
  },
);

/** `cf` exits 1 with error 12040, a 404, when Builds has no configuration for the Worker. */
export const readBuildConfig = Effect.fn("DeployedStage.readBuildConfig")(
  function* (tag: string) {
    const output = yield* runCommand("cf", [
      "builds",
      "workers",
      "get",
      tag,
    ]).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) =>
          error.message.includes("12040") ||
          error.message.includes("404 Not Found"),
        () => Effect.succeedNone,
      ),
      Effect.mapError((error) => new StageError({ message: error.message })),
    );
    if (Option.isNone(output)) return Option.none<BuildConfig>();
    return Option.some(
      yield* decodeJson(BuildConfig, "cf builds workers get")(output.value),
    );
  },
);

const git = (args: readonly string[]) =>
  runCommand("git", ["-C", app().root, ...args]).pipe(
    Effect.map((output) => output.trim()),
    Effect.mapError((error) => new StageError({ message: error.message })),
  );

const githubRepo = Effect.fn("DeployedStage.githubRepo")(function* () {
  const url = yield* git(["remote", "get-url", "origin"]);
  const match = /github\.com[:/](?<owner>[^/]+)\/(?<name>.+?)(?:\.git)?$/u.exec(
    url,
  );
  if (match === null)
    return yield* new StageError({
      message: `origin is not a GitHub repository: ${url}`,
    });
  return { owner: match.groups?.owner ?? "", name: match.groups?.name ?? "" };
});

const githubIds = (repo: { readonly owner: string; readonly name: string }) =>
  runCommand("gh", ["api", `repos/${repo.owner}/${repo.name}`]).pipe(
    Effect.mapError((error) => new StageError({ message: error.message })),
    Effect.flatMap(
      decodeJson(
        Schema.Struct({
          id: Schema.Number,
          name: Schema.String,
          owner: Schema.Struct({ id: Schema.Number, login: Schema.String }),
        }),
        "gh api repos",
      ),
    ),
  );

const readPlan = Effect.fn("DeployedStage.readPlan")(function* (
  stage: Deployed,
  tag: Option.Option<string>,
) {
  const canonical = canonicalBuild(stage, yield* sharedBuildToken());
  const repo = yield* githubRepo();
  const config = Option.isSome(tag)
    ? yield* readBuildConfig(tag.value)
    : Option.none<BuildConfig>();
  return {
    canonical,
    repo,
    config,
    steps: buildPlan(canonical, repo.name, config),
  };
});

const ensureBuild = Effect.fn("DeployedStage.ensureBuild")(function* (
  stage: Deployed,
  tag: string,
) {
  const { canonical, repo, steps } = yield* readPlan(stage, Option.some(tag));
  const apply = (step: BuildStep) => {
    switch (step._tag) {
      case "Create": {
        return Effect.gen(function* () {
          const ids = yield* githubIds(repo);
          yield* cf([
            "builds",
            "workers",
            "create",
            tag,
            "--body",
            JSON.stringify({
              script_tag: tag,
              git_repository: {
                provider_type: "github",
                provider_account_id: String(ids.owner.id),
                provider_account_name: ids.owner.login,
                repo_id: String(ids.id),
                repo_name: ids.name,
                branch: canonical.branch,
              },
              production_settings: canonical.production_settings,
              // The API requires previews' settings even with previews off.
              previews_base_config: canonical.production_settings,
              previews_enabled: canonical.previews_enabled,
            }),
          ]).pipe(
            Effect.mapError(
              (error) =>
                new StageError({
                  message: `${error.message}\nBuilds reaches ${repo.owner}/${repo.name} through the Cloudflare GitHub App, which needs access to it; only the owner can grant that`,
                }),
            ),
          );
        });
      }
      case "Update": {
        return cf([
          "builds",
          "workers",
          "update",
          tag,
          "--body",
          JSON.stringify({
            git_repository: { branch: canonical.branch },
            production_settings: canonical.production_settings,
            previews_enabled: canonical.previews_enabled,
          }),
        ]);
      }
      case "Delete": {
        return cf(["builds", "workers", "delete", tag, "--force"]);
      }
    }
  };
  yield* Effect.forEach(
    steps,
    (step) =>
      apply(step).pipe(
        Effect.tap(() =>
          Console.error(`stage: did ${describeStep(stage)(step)}`),
        ),
      ),
    { discard: true },
  );
  const after = yield* readPlan(stage, Option.some(tag));
  if (after.steps.length > 0 || Option.isNone(after.config))
    return yield* new StageError({
      message: `the ${stage} build configuration is still not canonical: it needs to ${after.steps.map(describeStep(stage)).join("; ")}`,
    });
  return after.config.value;
});

const syncVariables = Effect.fn("DeployedStage.syncVariables")(function* (
  tag: string,
  variables: readonly StageVariable[],
  existing: Variables,
) {
  const fs = yield* FileSystem.FileSystem;
  const failed = () =>
    new StageError({ message: "cannot write the variables' request body" });
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "rigging-stage-" })
    .pipe(Effect.mapError(failed));
  const body = path.join(directory, "variables.json");
  const stale = staleVariables(variables, existing);
  yield* fs
    .writeFileString(
      body,
      JSON.stringify({
        production_settings: {
          environment_variables: {
            ...Object.fromEntries(
              variables.map(({ name, value, secret }) => [
                name,
                { value: Redacted.value(value), is_secret: secret },
              ]),
            ),
            // Builds deletes a variable set to `null`.
            ...Object.fromEntries(stale.map((name) => [name, null])),
          },
        },
      }),
      { mode: 0o600 },
    )
    .pipe(Effect.mapError(failed));
  yield* cf(["builds", "workers", "update", tag, "--body", `@${body}`]);
  yield* Console.error(
    `stage: set ${variables.map(({ name }) => name).join(", ")}`,
  );
  if (stale.length > 0)
    yield* Console.error(`stage: deleted ${stale.join(", ")}`);
}, Effect.scoped);

const requireBranchCheckout = Effect.fn("DeployedStage.requireBranchCheckout")(
  function* (stage: Deployed) {
    const branch = branchOf(stage);
    if ((yield* git(["status", "--porcelain"])) !== "")
      return yield* new StageError({
        message: `the first deploy of ${stage} ships this checkout, which has uncommitted changes; commit or stash them, then rerun`,
      });
    yield* git(["fetch", "origin", branch]);
    const head = yield* git(["rev-parse", "HEAD"]);
    const remote = yield* git(["rev-parse", `origin/${branch}`]);
    if (head !== remote)
      return yield* new StageError({
        message: `the first deploy of ${stage} ships this checkout, whose HEAD ${head} is not origin/${branch} ${remote}; check out ${branch} at origin/${branch} (git switch ${branch}, then git pull --ff-only if behind or git push if ahead), then rerun`,
      });
  },
);

/**
 * The Website's tag. A stage with none gets its first deploy here, since a build configuration
 * is keyed to the Worker's tag: Alchemy from this checkout, once {@link requireBranchCheckout}
 * passes, with the file's values in its environment as Builds passes them.
 */
export const ensureWebsite = Effect.fn("DeployedStage.ensureWebsite")(
  function* (stage: Deployed, variables: readonly StageVariable[]) {
    const tag = yield* findTag(websiteOf(stage));
    if (Option.isSome(tag)) return tag.value;
    yield* requireBranchCheckout(stage);
    yield* alchemy(["deploy", "--stage", stage, "--yes"], "up", variables);
    const deployed = yield* findTag(websiteOf(stage));
    if (Option.isNone(deployed))
      return yield* new StageError({
        message: `the first deploy of ${stage} made no ${websiteOf(stage)}`,
      });
    return deployed.value;
  },
);

const Build = Schema.Struct({
  build_uuid: Schema.String,
  status: Schema.String,
  build_outcome: Schema.NullOr(Schema.String),
});

const BUILD_POLL = Duration.seconds(15);
const BUILD_TIMEOUT = Duration.minutes(30);

const build = Effect.fn("DeployedStage.build")(function* (
  stage: Deployed,
  tag: string,
) {
  const started = yield* cf([
    "builds",
    "create",
    tag,
    "--branch",
    branchOf(stage),
  ]).pipe(Effect.flatMap(decodeJson(Build, "cf builds create")));
  const logs = `cf builds logs get ${started.build_uuid}`;
  yield* Console.error(
    `stage: started build ${started.build_uuid} of ${branchOf(stage)}; its log: ${logs}`,
  );
  const done = yield* cf(["builds", "get", started.build_uuid]).pipe(
    Effect.flatMap(decodeJson(Build, "cf builds get")),
    Effect.repeat({
      schedule: Schedule.spaced(BUILD_POLL),
      until: (current) => current.status === "stopped",
    }),
    Effect.timeoutOrElse({
      duration: BUILD_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new StageError({
            message: `build ${started.build_uuid} is still running; watch it with ${logs}`,
          }),
        ),
    }),
  );
  if (done.build_outcome !== "success")
    return yield* new StageError({
      message: `build ${done.build_uuid} ended ${done.build_outcome ?? "without an outcome"}; read ${logs}`,
    });
  yield* Console.log(`${stage}: build ${done.build_uuid} succeeded`);
});

// Runs from a laptop: the Builds API takes only a user API token.
export const up = Effect.fn("DeployedStage.up")(function* (
  stage: Deployed,
  options: { readonly dryRun: boolean; readonly confirmed: boolean },
) {
  const variables = yield* readStageFile(stage);
  const names = variables.map(({ name }) => name).join(", ");
  yield* Console.log(`${stage}: .env.${stage} holds ${names}`);
  if (!options.dryRun && stage === "production" && !options.confirmed)
    return yield* new StageError({
      message:
        "up production writes production's configuration only with --confirm production",
    });
  if (options.dryRun) {
    const tag = yield* findTag(websiteOf(stage));
    const { config, steps } = yield* readPlan(stage, tag);
    const existing = Option.match(config, {
      onNone: () => ({}),
      onSome: ({ production_settings }) =>
        production_settings.environment_variables,
    });
    const stale = staleVariables(variables, existing);
    const writes = [
      ...(Option.isNone(tag)
        ? [`first deploy of ${branchOf(stage)} from this checkout`]
        : []),
      ...steps.map(describeStep(stage)),
      `set ${names}`,
      ...(stale.length > 0 ? [`delete ${stale.join(", ")}`] : []),
      `start a build of ${branchOf(stage)} and wait for it`,
    ];
    yield* Console.log(
      `${stage}: up would\n${writes.map((write) => `  - ${write}`).join("\n")}`,
    );
    return;
  }
  const tag = yield* ensureWebsite(stage, variables);
  const config = yield* ensureBuild(stage, tag);
  yield* syncVariables(
    tag,
    variables,
    config.production_settings.environment_variables,
  );
  yield* build(stage, tag);
  yield* Console.log(`${stage}: up`);
});

const alchemyEnv = (variables: readonly StageVariable[], run: StageRun) => ({
  ...Object.fromEntries(
    variables.map(({ name, value }) => [name, Redacted.value(value)]),
  ),
  [STAGE_RUN]: run,
});

const alchemy = Effect.fn("DeployedStage.alchemy")(function* (
  args: readonly string[],
  run: StageRun,
  variables: readonly StageVariable[] = [],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make("alchemy", [...args], {
        cwd: app().root,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        env: alchemyEnv(variables, run),
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.mapError(() => new StageError({ message: "cannot run alchemy" })),
    );
  if (exitCode !== ChildProcessSpawner.ExitCode(0))
    return yield* new StageError({
      message: `alchemy ${args.join(" ")} exited ${String(exitCode)}`,
    });
});

/**
 * Whether an `alchemy plan` replaces the Website Worker. A replaced Worker gets a new tag, and
 * Cloudflare deletes the build configuration with the old one. Alchemy prints a resource's line as
 * `[<FQN>] <action>`, after its log prefix `[<time>] <LEVEL>: `.
 *
 * @see `formatPlan` in Alchemy's `src/Cli/LoggingCli.ts` and `prettyLine` in `src/Util/ConsoleSink.ts`
 */
export const replacesWebsite = (plan: string) =>
  /^(?:\[[\d:.]+\] [A-Z]+: )?\[Website\] replace\b/mu.test(
    stripVTControlCharacters(plan),
  );

/**
 * `alchemy plan`'s output, captured, run with the file's values in its environment as Builds would
 * run the deploy. Without `--detailed` it names resources only, never values.
 */
const plan = Effect.fn("DeployedStage.plan")(function* (
  stage: Deployed,
  variables: readonly StageVariable[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = () => new StageError({ message: "cannot run alchemy plan" });
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("alchemy", ["plan", "--stage", stage], {
        cwd: app().root,
        stdin: "ignore",
        env: { ...alchemyEnv(variables, "check"), NO_COLOR: "1" },
        extendEnv: true,
      }),
    )
    .pipe(Effect.mapError(failed));
  const [stdout, stderr] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(failed));
  const exitCode = yield* handle.exitCode.pipe(Effect.mapError(failed));
  return {
    ok: exitCode === ChildProcessSpawner.ExitCode(0),
    output: `${stdout}${stderr}`,
  };
}, Effect.scoped);

const LatestBuilds = Schema.Array(
  Schema.Struct({
    build_uuid: Schema.String,
    build_outcome: Schema.NullOr(Schema.String),
  }),
);

export const check = Effect.fn("DeployedStage.check")(function* (
  stage: Deployed,
) {
  const variables = yield* readStageFile(stage);
  const problems: string[] = [];
  const planned = yield* plan(stage, variables);
  if (planned.ok) {
    yield* Console.log(`${stage}: plan succeeds`);
    if (replacesWebsite(planned.output))
      yield* Console.error(
        `stage: warning: the plan replaces the Website Worker, which deletes its build configuration; run vp run stage up ${stage} after the deploy`,
      );
  } else {
    yield* Console.error(
      planned.output.trimEnd().split("\n").slice(-20).join("\n"),
    );
    problems.push("the plan fails");
  }
  const tag = yield* findTag(websiteOf(stage));
  if (Option.isNone(tag)) problems.push(`${websiteOf(stage)} does not exist`);
  else {
    const { config, steps } = yield* readPlan(stage, tag);
    problems.push(
      ...steps.map((step) => `it needs to ${describeStep(stage)(step)}`),
    );
    if (Option.isSome(config)) {
      problems.push(
        ...variableProblems(
          variables,
          config.value.production_settings.environment_variables,
        ),
      );
      const [latest] = yield* cf([
        "builds",
        "list",
        "--worker",
        tag.value,
        "--per-page",
        "1",
      ]).pipe(Effect.flatMap(decodeJson(LatestBuilds, "cf builds list")));
      if (latest === undefined) problems.push("no build has run");
      else if (latest.build_outcome === "success")
        yield* Console.log(`${stage}: build ${latest.build_uuid} succeeded`);
      else
        problems.push(
          `the latest build ${latest.build_uuid} ended ${latest.build_outcome ?? "without an outcome yet"}`,
        );
    }
  }
  if (problems.length > 0)
    return yield* new StageError({
      message: `${stage}: ${problems.join("; ")}. Run vp run stage up ${stage}`,
    });
  yield* Console.log(
    `${stage}: the build configuration is canonical and holds every field of .env.${stage}`,
  );
});

const reset = Effect.fn("DeployedStage.reset")(function* (
  stage: ResettableDeployed,
) {
  yield* readStageFile(stage);
  yield* requireBranchCheckout(stage);
  yield* alchemy(["destroy", "--stage", stage, "--yes"], "reset");
  yield* up(stage, { dryRun: false, confirmed: false });
});

const toUserError = (error: StageError) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const stageArgument = Argument.Literals("stage", Deployed.literals).pipe(
  Argument.withDescription("staging or production"),
);

const upCommand = Command.make(
  "up",
  {
    stage: stageArgument,
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Read and print what up would write, names only"),
      Flag.withDefault(false),
    ),
    confirm: Flag.String("confirm").pipe(
      Flag.withDescription("production, to let up write production"),
      Flag.optional,
    ),
  },
  ({ stage, dryRun, confirm }) =>
    up(stage, {
      dryRun,
      confirmed: Option.contains(confirm, "production"),
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Make the stage match .env.<stage>: the Website (a first deploy from this checkout, clean and at the stage's branch on origin, when it has none), its canonical build configuration, the configuration's variables, and a build of the stage's branch.",
  ),
);

const checkCommand = Command.make(
  "check",
  { stage: stageArgument },
  ({ stage }) => check(stage).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Read only: whether the plan succeeds and replaces the Website, the build configuration is canonical, its variables match .env.<stage> by name, and the latest build succeeded.",
  ),
);

const resetCommand = Command.make(
  "reset",
  {
    stage: Argument.Literals("stage", ResettableDeployed.literals).pipe(
      Argument.withDescription("staging; production is never reset"),
    ),
    confirm: Flag.String("confirm").pipe(
      Flag.withDescription(
        "The stage again, to confirm its data is to be deleted",
      ),
    ),
  },
  ({ stage, confirm }) =>
    (confirm === stage
      ? reset(stage)
      : Effect.fail(
          new StageError({
            message: `--confirm must repeat the stage, ${stage}`,
          }),
        )
    ).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Destroy staging, deleting its D1 and Durable Object data, then run up staging.",
  ),
);

export const command = Command.make("stage").pipe(
  Command.withDescription(
    "Set up, check and reset staging and production's Workers Builds deploys.",
  ),
  Command.withSubcommands([upCommand, checkCommand, resetCommand]),
);
