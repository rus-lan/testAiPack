#!/usr/bin/env bash
# Build cross-platform standalone binaries for testaipack via `bun build --compile`.
# Produces 5 binaries + a SHA256 checksums file under dist/release/.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('./package.json').version")
fi

OUT_DIR="dist/release"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

BUN="./node_modules/.bin/bun"
ENTRY="bin/testaipack.ts"

if [ ! -x "$BUN" ]; then
  echo "bun not found at $BUN" >&2
  exit 1
fi
if [ ! -f "$ENTRY" ]; then
  echo "entry not found: $ENTRY" >&2
  exit 1
fi

echo "Building testaipack v${VERSION} for 5 platforms..."

TARGETS=(
  "bun-linux-x64:testaipack-linux-x64"
  "bun-linux-arm64:testaipack-linux-arm64"
  "bun-darwin-x64:testaipack-darwin-x64"
  "bun-darwin-arm64:testaipack-darwin-arm64"
  "bun-windows-x64:testaipack-windows-x64.exe"
)

FAILED=()
for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  echo "  -> $name (target=$target)"
  if "$BUN" build --compile --target="$target" --outfile="$OUT_DIR/$name" "$ENTRY"; then
    :
  else
    echo "  !! FAILED to build $name" >&2
    FAILED+=("$name")
  fi
done

echo "Generating SHA256 checksums..."
( cd "$OUT_DIR" && sha256sum * > checksums-sha256.txt )

echo ""
echo "Built artifacts in $OUT_DIR:"
ls -la "$OUT_DIR"

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "" >&2
  echo "WARNING: ${#FAILED[@]} target(s) failed: ${FAILED[*]}" >&2
  exit 1
fi
