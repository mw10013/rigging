#!/usr/bin/env bash
# Checks the `rigging server start` model: conformance to domain.ts and the
# rules that must hold. Run as `vp run verify:server-start`.
# MODEL_DIR=<folder> checks a copy of the .tla and .cfg files there instead,
# against this checkout's code (for trying a model change in scratch).
# TLC's full output for each run goes to ${OUT:-a temp folder}.
# Exit 0: conformance holds, every rule in main.cfg holds, and the covered
# code matches the sync commit.
# Exit 1: a check failed; the output says which.
# Exit 2: every check passed, but covered code changed since the sync commit
# in .claude/skills/verify-server-start/SKILL.md, so the model may no longer
# describe it. Review the diff as that skill says, then move the sync commit.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${OUT:-$(mktemp -d)}
mkdir -p "$out"
# Inside the repo, so tlc.sh finds the repo's mise.toml.
work=$(mktemp -d "$here/.work.XXXXXX")
trap 'rm -rf "$work"' EXIT

model=${MODEL_DIR:-$here}
cp "$model"/*.tla "$model"/*.cfg "$work"/
rm -f "$work/CodeTables.tla"
(cd "$root" && node verification/server-start/conformance.ts) >"$work/CodeTables.tla"

# Runs one config and keeps its output in $out/<config>.out.
tlc() {
  "$here/../tlc.sh" "$work/$2" "$work/$1.cfg" >"$out/$1.out" 2>&1 || true
  cat "$out/$1.out"
}
passed() { grep -q "Model checking completed. No error has been found." <<<"$1"; }

status=0

echo "== conformance: the model's StateOf, ListenerOf, ApplyAfter against domain.ts"
result=$(tlc Conformance Conformance.tla)
if passed "$result"; then
  echo "ok"
else
  sed -n '/^Starting\.\.\./,$p' <<<"$result" | grep -v "^Starting\|^Finished" | head -40
  echo "FAIL: domain.ts and the model disagree. Bring the model's operator in line with the code (or the code with the model), then rerun. Output: $out/Conformance.out"
  status=1
fi

echo "== rules: RunningMeansApplied, DegradedMeansFailed, ExitedMeansDied, PortTakenMeansStranger"
result=$(tlc main ServerStart.tla)
if passed "$result"; then
  grep "distinct states found" <<<"$result"
  echo "ok"
else
  grep -E "^Error|violated|^State [0-9]+:" <<<"$result" | sed 's/ line [0-9].*//'
  echo "FAIL: a rule broke. Read the path with /statechart before you decide it is a bug. Output: $out/main.out"
  status=1
fi

covered=(src/core/server/server.ts src/core/server/domain.ts src/core/server/port.ts)
sync=$(sed -n 's/^\*\*Sync commit: `\([0-9a-f]\{40\}\)`.*/\1/p' "$root/.claude/skills/verify-server-start/SKILL.md")
echo "== covered code against the sync commit ${sync:0:12}"
if [ -z "$sync" ]; then
  echo "FAIL: no sync commit found in .claude/skills/verify-server-start/SKILL.md"
  status=1
elif ! git -C "$root" diff --quiet "$sync" -- "${covered[@]}"; then
  git -C "$root" diff --stat "$sync" -- "${covered[@]}"
  echo "STALE: the conformance check covers only stateOf, listenerOf and applyOf. Compare the rest of this diff with the model's actions, as the skill's coverage table says."
  [ $status -eq 0 ] && status=2
else
  echo "ok"
fi

exit $status
