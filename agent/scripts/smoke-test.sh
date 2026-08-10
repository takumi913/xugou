#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

binary="${TMPDIR:-/tmp}/xugou-agent-smoke-$$"
output="${binary}.out"
cleanup() {
  rm -f "$binary" "$output"
}
trap cleanup EXIT HUP INT TERM

go build -trimpath \
  -ldflags="-X github.com/xugou/agent/cmd/agent.Version=0.0.0-smoke.1" \
  -o "$binary" .

test "$("$binary" version --short)" = "0.0.0-smoke.1"
"$binary" --help > "$output"
grep -q "Xugou Agent" "$output"

if "$binary" start > "$output" 2>&1; then
  echo "start without credentials unexpectedly succeeded" >&2
  exit 1
fi
grep -q "API" "$output"
