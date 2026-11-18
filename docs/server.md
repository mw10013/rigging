# rigging server

rigging server runs a checkout's dev servers in the background, one per name, and tells
scripts where they are. A server picks its own port and publishes it, so nothing
assigns ports ahead of time and many checkouts run side by side.

## Usage

Run rigging server from anywhere inside the checkout. It works on the app root around
the working directory: the nearest folder upward that holds a `package.json`,
never above the git worktree's toplevel. Outside any app it fails with `NoAppError`. In a
single-app repo that is the toplevel; in a monorepo each app (`apps/x`) has its
own servers. The command runs there, and `.rigging/servers/` and the status JSON's `log`
path are relative to it.

```sh
rigging server start <name> [--note text] [--timeout seconds] -- <command...>
rigging server status <name>
rigging server stop <name>
rigging server logs <name> [-n lines] [-f]
rigging server port                # pick a free port, publish it, print it
```

- `start` adopts the checkout's running server of that name, or launches the
  command detached, then waits until it answers (3 minutes by default). It
  prints the server's status JSON. A server that exits first fails the start
  with `ServerExitedError` and that run's log lines. A published port that
  another process holds fails the start with `PortTakenError`, which names the
  holder's pid, command and working directory, and stops the server. A server
  whose command logs a failure fails the start with `ServerDegradedError`,
  and keeps running. Its message names Alchemy's diagnostic, or the failure
  line when there is none, and points to the log; it quotes no log lines.
- `status` prints the status JSON. It exits 0 when the server answers and has
  logged no failure, and 3 otherwise.
- `stop` sends SIGTERM to the command's process group, waits for the exit to
  be logged, and sends SIGKILL after 30 seconds. It then ends every process
  left that carries the run's `BOSUN_RUN`, so none outlives the run.
- `logs` prints the last lines of the log, or follows it across rotation.
- `run` is internal: the foreground runner that `start` launches.

rigging server takes no lock. Two starts of one name at the same moment can launch two
servers; one checkout has one agent, so that does not arise.

## The endpoint contract

rigging server gives the command `RIGGING_ENDPOINT`, a file path. Once the command knows
where it listens, it writes `{"port": <n>, "url": "<optional public url>"}`
there. rigging server counts the server as running once the command, or one of its
descendants, listens on that port and the port answers any HTTP request. For
`alchemy dev`, it also waits for the apply to settle, because Alchemy's Website
answers while the rest of the stack is still applying. A
descendant counts though it left the command's process group, as Alchemy's dev
server does. Anything else listening there means the port was taken between
the moment the command chose it and the moment it bound it. For a Shopify app, the web command can write it from the variables
Shopify CLI hands it:

```sh
printf '{"port":%s,"url":"%s"}' "$BACKEND_PORT" "$APP_URL" > "$RIGGING_ENDPOINT"
```

## Status JSON

```json
{
  "rigging": 1,
  "name": "dev",
  "state": "running",
  "run": "9df4baf3",
  "pid": 43986,
  "group": 44007,
  "startedAt": "2026-11-03T14:56:35.734Z",
  "port": 50713,
  "url": "https://example.trycloudflare.com",
  "failure": null,
  "diagnostic": null,
  "log": ".rigging/servers/dev/log/current"
}
```

`state` is `running`, `starting`, `degraded`, `stopped` or `orphaned`. A server whose
port another process holds reads `starting`.

rigging server reads `alchemy dev`'s apply from this run's log. The `Dev · <stage>`
banner, or `Reloading stack:` after a file change, starts an apply, and the server
reads `starting` until a `Done:` or `Failed:` summary ends it. A failed apply
reads `degraded`. Alchemy stays up after it, so the resources that did apply keep
serving. `failure` holds the failure line (`alchemy dev: apply failed; …`), and
is null in every other state. `diagnostic` holds what Alchemy said went wrong,
such as `RewrittenMigrationHistoryError: Applied migration history … does not
match the local files (changed 0001_init.sql). …`. It is the line right after
Alchemy's `alchemy dev: … failed;` report, or, until that report is written or
when it has none, the message of the first resource that logged `fail` in the
apply. It is null when neither exists, as after an internally interrupted
apply, and in every state but `degraded`. The next reload starts a new apply,
and its diagnostic is its own. A command that
logs none of these lines is read by its port alone.

The apply lines come from Alchemy's plain console output. Only a failed apply
also leaves a log record, so the console summary is the one signal that marks
an apply's end either way. rigging server removes `ALCHEMY_LOG_FORMAT` and
`ALCHEMY_LOG_LEVEL` from the command's environment, since either one can turn
those lines off. A command that passes `--log-format json` or a
`--log-level` above `info` to `alchemy dev` turns them off too, and its server
is read by its port alone. An orphaned server's
runner died while its command lives on; `stop` ends it and `start` replaces it.
The fields other than `rigging`, `name`, `state` and `log` are null when stopped.
A typed failure prints `{ "rigging": 1, "error": { "_tag", "message" } }` and
exits 1. Version 1 only grows.

## Files

rigging server keeps everything in `.rigging/servers/`, which ignores itself with a `.gitignore`
of `*`, so a checkout needs no ignore line for it. Nothing else writes there.

| Path                                    | Written by | Holds                                               |
| --------------------------------------- | ---------- | --------------------------------------------------- |
| `.rigging/servers/<name>/record.json`   | the runner | Its pid, the command's process group, the run id.   |
| `.rigging/servers/<name>/endpoint.json` | the server | Its port and URL.                                   |
| `.rigging/servers/<name>/log/current`   | `s6-log`   | The server's output between start and exit markers. |

Each file has one writer. The runner removes its record and the endpoint when
the command exits. The log rotates at 5 MiB, 20 files, 100 MiB in all, and each
line starts with a timestamp.

## Processes

The runner, the command and `s6-log` each lead their own process group. A stop
signals the command's group alone, so the runner and the logger outlive it,
drain its last output and write `==== <name> exit run=<id> code=<n>`, or
`signal=<name>` for a command the signal ended (one that does not catch it). When the
command exits, the runner also ends anything left in its group, since a
straggler would hold the logger's pipe open. It then ends every process whose
environment carries `BOSUN_RUN=<run>`, which the command's descendants inherit:
SIGTERM, then SIGKILL after 2 seconds. Alchemy's sidecar and workerd leave the
command's group, and outlive a SIGKILL of it with the local databases locked.
`stop` does the same once the group is gone, and `start` before it replaces a stopped or orphaned server, for a runner that died.
