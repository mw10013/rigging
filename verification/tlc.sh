#!/usr/bin/env bash
# Runs TLC on a TLA+ spec with the Java and tla2tools that the repo's mise.toml pins.
# Usage: verification/tlc.sh SPEC.tla [CONFIG.cfg] [extra TLC args...]
set -euo pipefail

spec=${1:?usage: verification/tlc.sh SPEC.tla [CONFIG.cfg] [TLC args...]}
shift
config=${spec%.tla}.cfg
if [[ $# -gt 0 && $1 == *.cfg ]]; then
  config=$1
  shift
fi

cd "$(dirname "$spec")"
mise install --quiet
jar=$(mise where http:tla2tools)/tla2tools.jar

meta=$(mktemp -d)
trap 'rm -rf "$meta"' EXIT
mise exec -- java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -cleanup -metadir "$meta" \
  -workers auto -config "$(basename "$config")" "$@" "$(basename "$spec")"
