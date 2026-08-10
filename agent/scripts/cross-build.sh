#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

output_prefix="${TMPDIR:-/tmp}/xugou-agent-cross-build-$$"
cleanup() {
  rm -f "${output_prefix}"-*
}
trap cleanup EXIT HUP INT TERM

for target in \
  linux/amd64 linux/arm64 \
  darwin/amd64 darwin/arm64 \
  windows/amd64 windows/arm64
do
  goos="${target%/*}"
  goarch="${target#*/}"
  suffix=""
  if [ "$goos" = "windows" ]; then
    suffix=".exe"
  fi
  echo "cross-build ${goos}/${goarch}"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
    go build -trimpath -o "${output_prefix}-${goos}-${goarch}${suffix}" .
done
