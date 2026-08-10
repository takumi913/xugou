#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
persist_dir=$(mktemp -d "${TMPDIR:-/tmp}/xugou-live-e2e.XXXXXX")
server_pid=""

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$persist_dir"
}
trap cleanup EXIT HUP INT TERM

cd "$repository_root"
pnpm exec wrangler d1 migrations apply DB --local --persist-to "$persist_dir"

pnpm exec wrangler dev \
  --local \
  --persist-to "$persist_dir" \
  --ip 127.0.0.1 \
  --port 4174 \
  --var SESSION_HMAC_SECRET:test-session-hmac-secret-with-more-than-32-bytes \
  --var ADMIN_INITIAL_PASSWORD:test-initial-password \
  --var AGENT_TOKEN_PEPPER:test-agent-token-pepper-with-more-than-32-bytes \
  --var NOTIFICATION_KEK:dGVzdC1ub3RpZmljYXRpb24ta2VrLTMyLWJ5dGVzISE= &
server_pid=$!
wait "$server_pid"
