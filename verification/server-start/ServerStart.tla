---------------------------- MODULE ServerStart ----------------------------
(***************************************************************************)
(* `rigging server start` for an `alchemy dev` server, against everything *)
(* that moves while it polls. Code: src/core/server/server.ts (start,      *)
(* run, sight, waitAnswering) and src/core/server/domain.ts (applyOf,      *)
(* listenerOf, stateOf). The command is the fixture's shape: `rigging      *)
(* server port` publishes the port, then `alchemy dev` prints its banner,  *)
(* its sidecar binds the port for the Website, and the apply ends in       *)
(* `Done:` or `Failed:`.                                                   *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
  StaleRun,          \* a dead earlier run left its record and a failed apply in the log
  MaxReloads,        \* file changes alchemy reloads on (`Reloading stack:`)
  ForeignBinds,      \* another process may take the published port
  RunnerCanCrash,    \* the runner may die (SIGKILL, OOM) and orphan the command
  BindWaitsForBanner \* assumption A1: the banner reaches log/current before the sidecar binds

Applies == {"none", "applying", "done", "failed"}

VARIABLES
  \* the command: alchemy dev and its sidecar
  cmd,       \* "unborn" | "alive" | "dead"; the command's process group (record.group)
  endpoint,  \* endpoint.json exists
  truth,     \* the apply alchemy is really in
  reloads,
  sidecar,   \* "none" | "listening" | "gone": alchemy's sidecar, its own process group
  foreign,   \* a process outside the server listens on the port
  \* the log
  pipe,      \* apply lines printed, still in the pipe to s6-log
  logged,    \* applyOf(log, name, run) for the new run: the last apply line in log/current
  \* the runner (`rigging server run`)
  runner,    \* "unborn" | "booting" | "recorded" | "removed" | "dead"
  record,    \* record.json: "none" | "stale" | "new"
  \* start
  pc, snap, result,
  \* history, for the rules only
  wasGood, everFailed, everDied

vars == <<cmd, endpoint, truth, reloads, sidecar, foreign, pipe, logged,
          runner, record, pc, snap, result, wasGood, everFailed, everDied>>

noSnap == [rec |-> FALSE, ep |-> FALSE, lis |-> "free", apply |-> "none",
           runner |-> FALSE, group |-> FALSE, ans |-> FALSE,
           foreignAtLsof |-> FALSE]

(* The pieces of domain.ts the model uses. conformance.ts checks each     *)
(* against the code on every input the model can give it.                 *)

\* stateOf(record, sighting)
StateOf(rec, runnerUp, groupUp, ans, apply) ==
  IF ~rec THEN "stopped"
  ELSE IF ~runnerUp THEN (IF groupUp THEN "orphaned" ELSE "stopped")
  ELSE IF apply = "failed" THEN "degraded"
  ELSE IF ans /\ apply # "applying" THEN "running"
  ELSE "starting"

\* listenerOf(lsof pids, ps table, record.group, marked pids). The sidecar
\* descends from the command only while the command lives; then launchd
\* adopts it. It carries the run's marker (BOSUN_RUN) either way, so it is
\* the server's whether or not the command lives.
ListenerOf(sidecarListens, foreignListens, cmdAlive) ==
  IF ~sidecarListens /\ ~foreignListens THEN "free"
  ELSE IF foreignListens THEN "taken"
  ELSE "server"

\* applyOf: the apply after one more line of this run; the last line wins
ApplyAfter(apply, line) == line

RunnerUp == runner \in {"booting", "recorded", "removed"}
Good == cmd = "alive" /\ RunnerUp /\ sidecar = "listening" /\ truth = "done"

Ghost ==
  /\ wasGood' = (wasGood \/ Good')
  /\ everFailed' = (everFailed \/ truth' = "failed")
  /\ everDied' = (everDied \/ cmd' = "dead" \/ runner' = "dead")

Init ==
  /\ cmd = "unborn" /\ endpoint = FALSE /\ truth = "none" /\ reloads = 0
  /\ sidecar = "none" /\ foreign = FALSE /\ pipe = <<>> /\ logged = "none"
  /\ runner = "unborn"
  /\ record = IF StaleRun THEN "stale" ELSE "none"
  /\ pc = "launch" /\ snap = noSnap /\ result = "none"
  /\ wasGood = FALSE /\ everFailed = FALSE /\ everDied = FALSE

cmdVars == <<cmd, endpoint, truth, reloads, sidecar, foreign, pipe, logged>>
runVars == <<runner, record>>
startVars == <<pc, snap, result>>

---------------------------------------------------------------------------
(* start: src/core/server/server.ts `start`                               *)

\* A record whose runner and group are dead reads "stopped"; start removes it.
StartClearsStale ==
  /\ pc = "launch" /\ record = "stale"
  /\ record' = "none"
  /\ UNCHANGED <<cmdVars, runner, startVars>> /\ Ghost

\* spawner.spawn(vpx rigging server run <name> --run <id> -- <command>)
StartLaunchesRunner ==
  /\ pc = "launch" /\ record = "none"
  /\ runner' = "booting" /\ pc' = "waitRecord"
  /\ UNCHANGED <<cmdVars, record, snap, result>> /\ Ghost

\* waitUntil(recorded, RECORD_TIMEOUT)
StartSeesRecord ==
  /\ pc = "waitRecord" /\ record = "new"
  /\ pc' = "readRecord"
  /\ UNCHANGED <<cmdVars, runVars, snap, result>> /\ Ghost

\* Assumption A2: a live runner writes its record within RECORD_TIMEOUT.
StartRecordTimesOut ==
  /\ pc = "waitRecord" /\ record # "new" /\ runner \in {"removed", "dead"}
  /\ result' = "exited" /\ pc' = "done"
  /\ UNCHANGED <<cmdVars, runVars, snap>> /\ Ghost

(* sight: each read is its own step, in the code's order.                 *)

SightReadsRecord ==
  /\ pc = "readRecord"
  /\ snap' = [noSnap EXCEPT !.rec = (record = "new")]
  /\ pc' = "readEndpoint"
  /\ UNCHANGED <<cmdVars, runVars, result>> /\ Ghost

SightReadsEndpoint ==
  /\ pc = "readEndpoint"
  /\ snap' = [snap EXCEPT !.ep = endpoint]
  /\ pc' = "lsof"
  /\ UNCHANGED <<cmdVars, runVars, result>> /\ Ghost

\* portListener: lsof, then ps, then listenerOf
SightAsksWhoListens ==
  /\ pc = "lsof"
  /\ snap' = [snap EXCEPT
               !.lis = IF snap.rec /\ snap.ep
                         THEN ListenerOf(sidecar = "listening", foreign, cmd = "alive")
                         ELSE "free",
               !.foreignAtLsof = foreign]
  /\ pc' = "readLog"
  /\ UNCHANGED <<cmdVars, runVars, result>> /\ Ghost

SightReadsLog ==
  /\ pc = "readLog"
  /\ snap' = [snap EXCEPT !.apply = IF snap.rec THEN logged ELSE "none"]
  /\ pc' = "runnerAlive"
  /\ UNCHANGED <<cmdVars, runVars, result>> /\ Ghost

SightChecksRunner ==
  /\ pc = "runnerAlive"
  /\ snap' = [snap EXCEPT !.runner = snap.rec /\ RunnerUp]
  /\ pc' = "groupAlive"
  /\ UNCHANGED <<cmdVars, runVars, result>> /\ Ghost

SightChecksGroup ==
  /\ pc = "groupAlive"
  /\ snap' = [snap EXCEPT !.group = snap.rec /\ cmd = "alive"]
  /\ pc' = "fetch"
  /\ UNCHANGED <<cmdVars, runVars, result>> /\ Ghost

\* answering(port): a fetch, which whoever holds the port answers
SightFetches ==
  /\ pc = "fetch"
  /\ snap' = [snap EXCEPT !.ans = snap.rec /\ snap.ep /\ snap.lis = "server"
                                   /\ (sidecar = "listening" \/ foreign)]
  /\ pc' = "decide"
  /\ UNCHANGED <<cmdVars, runVars, result>> /\ Ghost

(* waitAnswering's checks, in order                                       *)

SnapState == StateOf(snap.rec, snap.runner, snap.group, snap.ans, snap.apply)
\* status JSON's run and port are null when stopped
SnapLive == SnapState # "stopped"

Verdict ==
  IF SnapState = "running" THEN "running"
  ELSE IF SnapState = "degraded" THEN "degraded"
  ELSE IF snap.lis = "taken" /\ SnapLive /\ snap.ep THEN "portTaken"
  ELSE IF SnapState # "starting" THEN "exited"
  ELSE "wait"

StartDecides ==
  /\ pc = "decide" /\ Verdict # "wait"
  /\ result' = Verdict /\ pc' = "done"
  /\ UNCHANGED <<cmdVars, runVars, snap>> /\ Ghost

StartPollsAgain ==
  /\ pc = "decide" /\ Verdict = "wait"
  /\ pc' = "readRecord"
  /\ UNCHANGED <<cmdVars, runVars, snap, result>> /\ Ghost

StartTimesOut ==
  /\ pc = "decide" /\ Verdict = "wait"
  /\ result' = "timeout" /\ pc' = "done"
  /\ UNCHANGED <<cmdVars, runVars, snap>> /\ Ghost

---------------------------------------------------------------------------
(* the runner: src/core/server/server.ts `run`                            *)

\* removeFiles, start marker, spawn the command and s6-log
RunnerSpawnsCommand ==
  /\ runner = "booting" /\ cmd = "unborn"
  /\ cmd' = "alive"
  /\ UNCHANGED <<endpoint, truth, reloads, sidecar, foreign, pipe, logged,
                 runVars, startVars>> /\ Ghost

RunnerWritesRecord ==
  /\ runner = "booting" /\ cmd # "unborn"
  /\ runner' = "recorded" /\ record' = "new"
  /\ UNCHANGED <<cmdVars, startVars>> /\ Ghost

\* The command ended: endMarked ends the run's processes outside its group
\* (the sidecar carries BOSUN_RUN); s6-log drains the pipe and exits; exit
\* marker; removeFiles.
RunnerRemovesFiles ==
  /\ runner = "recorded" /\ cmd = "dead" /\ pipe = <<>>
  /\ runner' = "removed" /\ record' = "none" /\ endpoint' = FALSE
  /\ sidecar' = IF sidecar = "listening" THEN "gone" ELSE sidecar
  /\ UNCHANGED <<truth, reloads, foreign, pipe, logged, cmd,
                 startVars>> /\ Ghost

RunnerExits ==
  /\ runner = "removed"
  /\ runner' = "dead"
  /\ UNCHANGED <<cmdVars, record, startVars>> /\ Ghost

RunnerCrashes ==
  /\ RunnerCanCrash /\ runner \in {"booting", "recorded"}
  /\ runner' = "dead"
  /\ UNCHANGED <<cmdVars, record, startVars>> /\ Ghost

---------------------------------------------------------------------------
(* the command                                                            *)

Prints(line) == pipe' = Append(pipe, line)

\* `port=$(rigging server port)`: src/core/server/port.ts publishFreePort
CommandPublishesPort ==
  /\ cmd = "alive" /\ ~endpoint /\ truth = "none"
  /\ endpoint' = TRUE
  /\ UNCHANGED <<cmd, truth, reloads, sidecar, foreign, pipe, logged,
                 runVars, startVars>> /\ Ghost

\* `INFO: Dev · <stage>`
AlchemyBegins ==
  /\ cmd = "alive" /\ endpoint /\ truth = "none"
  /\ truth' = "applying" /\ Prints("applying")
  /\ UNCHANGED <<cmd, endpoint, reloads, sidecar, foreign, logged,
                 runVars, startVars>> /\ Ghost

\* `alchemy dev: run failed; …` before any apply; alchemy stays up
AlchemyFailsEarly ==
  /\ cmd = "alive" /\ truth = "none"
  /\ truth' = "failed" /\ Prints("failed")
  /\ UNCHANGED <<cmd, endpoint, reloads, sidecar, foreign, logged,
                 runVars, startVars>> /\ Ghost

\* `[Website] Started … → http://localhost:<port>/`
SidecarBinds ==
  /\ cmd = "alive" /\ truth = "applying" /\ sidecar = "none" /\ ~foreign
  /\ BindWaitsForBanner => logged # "none"
  /\ sidecar' = "listening"
  /\ UNCHANGED <<cmd, endpoint, truth, reloads, foreign, pipe, logged,
                 runVars, startVars>> /\ Ghost

\* `INFO: Done: <n> succeeded`; the Website is one of the resources
AlchemyApplies ==
  /\ cmd = "alive" /\ truth = "applying" /\ sidecar = "listening"
  /\ truth' = "done" /\ Prints("done")
  /\ UNCHANGED <<cmd, endpoint, reloads, sidecar, foreign, logged,
                 runVars, startVars>> /\ Ghost

\* `Failed: <n> succeeded …` and `alchemy dev: apply failed; …`
AlchemyFails ==
  /\ cmd = "alive" /\ truth = "applying"
  /\ truth' = "failed" /\ Prints("failed")
  /\ UNCHANGED <<cmd, endpoint, reloads, sidecar, foreign, logged,
                 runVars, startVars>> /\ Ghost

\* `INFO: Reloading stack: <file>`
AlchemyReloads ==
  /\ cmd = "alive" /\ truth \in {"done", "failed"} /\ reloads < MaxReloads
  /\ truth' = "applying" /\ reloads' = reloads + 1 /\ Prints("applying")
  /\ UNCHANGED <<cmd, endpoint, sidecar, foreign, logged,
                 runVars, startVars>> /\ Ghost

\* A graceful exit runs alchemy's finalizer, which kills the sidecar first.
CommandExits ==
  /\ cmd = "alive"
  /\ cmd' = "dead" /\ sidecar' = IF sidecar = "listening" THEN "gone" ELSE sidecar
  /\ UNCHANGED <<endpoint, truth, reloads, foreign, pipe, logged,
                 runVars, startVars>> /\ Ghost

\* alchemy's supervisor dies abruptly; its sidecar lives until it notices
\* the RPC parent link closed (node_modules/alchemy/src/Local/RpcSpawner.ts).
CommandCrashes ==
  /\ cmd = "alive"
  /\ cmd' = "dead"
  /\ UNCHANGED <<endpoint, truth, reloads, sidecar, foreign, pipe, logged,
                 runVars, startVars>> /\ Ghost

SidecarNoticesParentGone ==
  /\ cmd = "dead" /\ sidecar = "listening"
  /\ sidecar' = "gone"
  /\ UNCHANGED <<cmd, endpoint, truth, reloads, foreign, pipe, logged,
                 runVars, startVars>> /\ Ghost

\* s6-log writes the next line to log/current; applyOf of this run's lines is
\* the last apply line among them
LogWritesLine ==
  /\ pipe # <<>>
  /\ logged' = ApplyAfter(logged, Head(pipe)) /\ pipe' = Tail(pipe)
  /\ UNCHANGED <<cmd, endpoint, truth, reloads, sidecar, foreign,
                 runVars, startVars>> /\ Ghost

\* rigging server port picks a free port, not a reserved one
StrangerTakesPort ==
  /\ ForeignBinds /\ endpoint /\ ~foreign /\ sidecar # "listening"
  /\ foreign' = TRUE
  /\ UNCHANGED <<cmd, endpoint, truth, reloads, sidecar, pipe, logged,
                 runVars, startVars>> /\ Ghost

\* start has returned and nothing else moves
Settled ==
  /\ pc = "done"
  /\ UNCHANGED vars

Next ==
  \/ StartClearsStale \/ StartLaunchesRunner \/ StartSeesRecord
  \/ StartRecordTimesOut
  \/ SightReadsRecord \/ SightReadsEndpoint \/ SightAsksWhoListens
  \/ SightReadsLog \/ SightChecksRunner \/ SightChecksGroup \/ SightFetches
  \/ StartDecides \/ StartPollsAgain \/ StartTimesOut
  \/ RunnerSpawnsCommand \/ RunnerWritesRecord \/ RunnerRemovesFiles
  \/ RunnerExits \/ RunnerCrashes
  \/ CommandPublishesPort \/ AlchemyBegins \/ AlchemyFailsEarly
  \/ SidecarBinds \/ AlchemyApplies \/ AlchemyFails \/ AlchemyReloads
  \/ CommandExits \/ CommandCrashes \/ SidecarNoticesParentGone
  \/ LogWritesLine \/ StrangerTakesPort
  \/ Settled

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* The rules. Each names what start told the caller, and requires that    *)
(* it was true at some moment since start began.                          *)

\* running: the server answered with an apply that ended in Done.
RunningMeansApplied == result = "running" => wasGood

\* ServerDegradedError: this run's alchemy really logged a failure.
DegradedMeansFailed == result = "degraded" => everFailed

\* ServerExitedError: the command or its runner really died.
ExitedMeansDied == result = "exited" => everDied

\* PortTakenError ("held by another process"): a process outside the
\* server held the port when start asked who listens.
PortTakenMeansStranger == result = "portTaken" => snap.foreignAtLsof

\* Once the runner has removed the run's files, none of the run's processes
\* still holds the port (#30).
RunnerEndsTheRun == runner = "removed" => sidecar # "listening"

TypeOK ==
  /\ cmd \in {"unborn", "alive", "dead"}
  /\ truth \in Applies /\ logged \in Applies
  /\ sidecar \in {"none", "listening", "gone"}
  /\ runner \in {"unborn", "booting", "recorded", "removed", "dead"}
  /\ record \in {"none", "stale", "new"}
  /\ result \in {"none", "running", "degraded", "portTaken", "exited", "timeout"}
=============================================================================
