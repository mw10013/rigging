---
name: verify-server-start
description: Model-check what `rigging server start` tells its caller (running, ServerDegradedError, ServerExitedError, PortTakenError) against every interleaving of the runner, alchemy dev, its sidecar, the log pipe and a stranger on the port. Use when a change touches src/core/server/server.ts (start, run, sight, waitAnswering, stopRecorded), src/core/server/domain.ts (stateOf, listenerOf, applyOf, runLines) or src/core/server/port.ts, or when a start misreports a server's state.
---

# Verify `rigging server start`

## The promise

**Rule.** When `rigging server start` reports running, degraded, exited or port taken, that was true of the server at some moment while start ran.

**Harm when it breaks.** The caller acts on a false report. An e2e run tests a stack that is still applying or has failed. An agent chases a port conflict that does not exist, or restarts a server that is fine.

The model is `verification/server-start/ServerStart.tla`. Each rule is an invariant there:

| Invariant                | start said            | it must be true that                                                                               |
| ------------------------ | --------------------- | -------------------------------------------------------------------------------------------------- |
| `RunningMeansApplied`    | `state: "running"`    | the server answered on its port while alchemy's latest apply had ended in `Done:`                  |
| `DegradedMeansFailed`    | `ServerDegradedError` | this run's alchemy really logged a failure (not an earlier run's)                                  |
| `ExitedMeansDied`        | `ServerExitedError`   | the command or its runner really died                                                              |
| `PortTakenMeansStranger` | `PortTakenError`      | a process outside the server held the port when start ran `lsof` (**known finding, breaks today**) |

## Run it

```sh
vp run verify:server-start
```

It takes about 3 seconds. `verification/server-start/check.sh` runs TLC through `verification/tlc.sh`, with the Java and TLC that the root `mise.toml` pins. The first run installs them and needs the network. TLC's full output for each run goes to `$OUT`, a temp folder by default. The script does four things:

1. **Conformance.** `conformance.ts` runs the real `stateOf`, `listenerOf` and `applyOf` from `src/core/server/domain.ts` on every input the model can give them. That covers 64 sightings, 8 listener cases, and 121 sequences of alchemy log lines after a stale failed run. TLC then checks the model's `StateOf`, `ListenerOf` and `ApplyAfter` against those answers. A mismatch prints the rows that differ.
2. **Rules.** `main.cfg` checks `RunningMeansApplied`, `DegradedMeansFailed`, `ExitedMeansDied` and `TypeOK`. That is about 56,000 distinct states.
3. **Known finding.** `finding.cfg` checks `PortTakenMeansStranger` and expects it to break.

4. **Staleness.** It diffs `server.ts`, `domain.ts` and `port.ts` against the sync commit below.

Exit 0 means every step came out as recorded here and the covered code has not changed since the sync commit. Exit 1 means a check failed, and the output says which one. Exit 2 means every check passed, but the covered code has changed since the sync commit. Conformance cannot see most of that code, so a 2 is not a pass. Do the review in "Does my change touch it?".

To try a model change without touching the repo copy, copy the `.tla` and `.cfg` files to a scratch folder, edit them there, and run `MODEL_DIR=<folder> verification/server-start/check.sh`. Conformance still runs against this checkout's code.

## Does my change touch it?

Coverage, and how each piece is kept in step with the code:

| Code                                                                                                                          | Model                                                                                                                                                                  | Kept in step by                |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `domain.ts` `stateOf`                                                                                                         | `StateOf`                                                                                                                                                              | conformance (automatic)        |
| `domain.ts` `listenerOf`, `descends`                                                                                          | `ListenerOf`                                                                                                                                                           | conformance (automatic)        |
| `domain.ts` `applyOf`, `runLines`, `APPLY_EVENTS`                                                                             | `ApplyAfter`, `LogWritesLine`                                                                                                                                          | conformance (automatic)        |
| `server.ts` `start`: the stale-record branch, the runner spawn, `waitUntil(recorded, RECORD_TIMEOUT)`                         | `StartClearsStale`, `StartLaunchesRunner`, `StartSeesRecord`, `StartRecordTimesOut`                                                                                    | reading                        |
| `server.ts` `sight`: the order of its reads (record, endpoint, `portListener`, log, `runnerAlive`, `groupAlive`, `answering`) | `SightReadsRecord` … `SightFetches`, one action per read, in that order                                                                                                | reading                        |
| `server.ts` `waitAnswering`: the order of its checks (running, failure, `Taken`, not starting, deadline)                      | `Verdict`, `StartDecides`, `StartPollsAgain`, `StartTimesOut`                                                                                                          | reading                        |
| `server.ts` `run`: spawn, record write, `finish` (logger drains, exit marker, `removeFiles`)                                  | `RunnerSpawnsCommand`, `RunnerWritesRecord`, `RunnerRemovesFiles`, `RunnerExits`, `RunnerCrashes`                                                                      | reading                        |
| `port.ts` `publishFreePort`                                                                                                   | `CommandPublishesPort`, `StrangerTakesPort`                                                                                                                            | reading                        |
| alchemy dev's apply lines and sidecar (`node_modules/alchemy/src/Local/RpcSpawner.ts`, `Cli/commands/dev.ts`)                 | `AlchemyBegins`, `AlchemyFailsEarly`, `SidecarBinds`, `AlchemyApplies`, `AlchemyFails`, `AlchemyReloads`, `CommandExits`, `CommandCrashes`, `SidecarNoticesParentGone` | reading, on an alchemy upgrade |

**Sync commit: `d6d259ddf01c5f15a5f9e370d3f234d4eaf4dee1`.** At that commit the model was confirmed to describe the code above. To see what changed since then:

```sh
git diff d6d259ddf01c5f15a5f9e370d3f234d4eaf4dee1 -- src/core/server/server.ts src/core/server/domain.ts src/core/server/port.ts
```

`check.sh` runs that diff as its last step, and it exits 2 when the diff is not empty. Conformance catches changes to the three pure functions. For every other row marked "reading", open the changed code and the model action beside it. Check that the action still does what the code does, in the same order, with the same split into steps. A change to `sight` that conformance missed was caught this way: answering without `listener._tag === "Server"` needs `snap.lis = "server"` dropped from `SightFetches`, and then `RunningMeansApplied` breaks, because a stranger binds the port between `lsof` and the fetch. In particular:

- `sight` reads one thing per step, and `waitAnswering` decides from those reads. A new read, a reordered read, or a check that moves within `waitAnswering` changes the model.
- An `await`, a spawned process, or a file write between two lines of code is a point where other processes move. Two code steps with one of these between them must stay two model steps.

Move the sync commit forward, here and only here, only after you have confirmed that the model describes the code at the new commit and `check.sh` exits 0.

## Read a result

Read every TLC result with the pstack `/statechart` skill. Run it on a scratch copy of `ServerStart.tla` with `main.cfg` or `finding.cfg`. For a broken rule it gives the shortest path that breaks it. When every rule holds, it draws how a start moves between states. `check.sh` prints only the action names of a path. The full trace is in `$OUT/main.out` or `$OUT/finding.out`.

To tell a real bug from a modeling error, replay the path against the real code, one step per action. The replay of the known finding, below, shows the pattern: a scratch checkout (`git init`, a `package.json` of `{"name":"app"}`), a small Node script that plays alchemy's part, and `vpx <repo>/src/bin/rigging.ts server start dev -- <command>`. If the real code does not do what the path says, the model is wrong. Fix the model, not the rule. If the real code does misreport, it is a finding. Report it with the path in the code's words. Do not weaken the rule or the model to make it pass, and do not change product code unless the user asks.

## When a change is meant to change behavior

1. Change the model action or operator that mirrors the code, in a scratch copy, and run it with `MODEL_DIR`.
2. If a rule breaks, read the path with `/statechart` and replay it. A new rule that the change promises goes into the model as an invariant and into `main.cfg`.
3. Show the new or changed rule failing on a broken variant, such as a removed check or a reordered step, before you trust it passing.
4. Copy the model back, run `check.sh`, update the coverage table, and move the sync commit.

These broken variants were each confirmed to fail at the sync commit. Use them to check that the check still has teeth:

| Broken variant                                                                                    | Fails                          |
| ------------------------------------------------------------------------------------------------- | ------------------------------ |
| `stateOf` drops `&& seen.apply._tag !== "Applying"`                                               | conformance (`StateOf` rows)   |
| …and the model's `StateOf` follows it (`ELSE IF ans THEN "running"`)                              | `RunningMeansApplied`          |
| `applyOf` reads `log.split("\n")` instead of `runLines(log, name, run)`                           | conformance (`ApplyAfter` row) |
| …and the model's `SightReadsLog` reads the stale run's failure when this run has logged nothing   | `DegradedMeansFailed`          |
| `waitAnswering` exits on `now.state !== "running"` instead of `!== "starting"` (model: `Verdict`) | `ExitedMeansDied`              |
| `BindWaitsForBanner = FALSE` in `main.cfg` (assumption A1 dropped)                                | `RunningMeansApplied`          |

## Known finding: a crashed alchemy's own sidecar reads as a stranger

`PortTakenMeansStranger` breaks at the sync commit:

1. start launches the runner, which spawns the command and writes `record.json`.
2. `rigging server port` publishes the port. alchemy prints `Dev · <stage>`, and its sidecar binds the port for the Website.
3. alchemy's supervisor dies abruptly while the apply is still running. Its sidecar runs in its own process group and lives on until it notices the RPC link to its parent has closed.
4. `sight` runs `lsof`. The sidecar's parent is gone, so launchd has adopted it, and `listenerOf` finds a listener that does not descend from `record.group`. It returns `Taken`.
5. The runner is still alive (it has not yet removed the record), so the state is `starting` and the run matches. `waitAnswering` checks `Taken` before it checks whether the server exited. It fails with `PortTakenError: port N … is held by another process, so the server was stopped`, and it names the server's own sidecar.

Expected: `ServerExitedError` with the run's log lines. The report sends the caller after a port conflict that does not exist, and it hides the crash.

This was replayed against the real code. A `bash -c 'node supervisor.mjs; sleep 4'` command, where `supervisor.mjs` publishes a free port, spawns a detached sidecar that listens on it, and then SIGKILLs itself, gets `PortTakenError` naming that sidecar's pid. When the code is fixed, `check.sh` exits 1 and says that `PortTakenMeansStranger` now holds. Then move it into `main.cfg`, delete `finding.cfg` and its step from `check.sh`, and remove this section.

## Scope

**Bounds** (`main.cfg`): one new run, plus an optional stale record from a dead earlier run whose apply failed. At most one reload, one stranger, and one runner crash.

**Assumptions**:

- **A1** (`BindWaitsForBanner`): alchemy's `Dev · <stage>` banner reaches `log/current` before the sidecar binds the port. In the saas fixture (`src/core/server/fixtures/apply-failed.log`) the gap is 18 seconds, against milliseconds of pipe latency. Without A1, start can return running while the first apply is in progress, because `applyOf` reads a log with no banner yet as `None`.
- **A2**: a live runner writes `record.json` within `RECORD_TIMEOUT` (30 s). A runner slower than that would be reported as exited while it still starts.
- Alchemy's lines all reach the log in the order printed. `Stream.merge(child.stdout, child.stderr)` keeps order within each stream. If alchemy splits apply lines across stdout and stderr, two lines printed close together could swap.
- The command's process group is modeled as one process: it dies whenever alchemy's supervisor dies. In the fixture command, `kill -TERM 0` runs right after `alchemy dev` exits.

**Left out**: concurrent starts or stops of one name (`docs/server.md` rules them out), `stop` and `stopRecorded`, an adopted start of an older run, log rotation, `ServerExitedError`'s output text and the diagnostic text, commands other than alchemy dev (they read by port alone), and timing such as the 3-minute deadline and the 1-second poll. `StartTimesOut` may fire on any poll. The rules are safety rules only: they say what a report means, not that start reports promptly.
