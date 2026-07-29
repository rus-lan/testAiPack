#!/usr/bin/env bash
# Build cross-platform standalone binaries for testaipack via `bun build --compile`.
# Produces 5 binaries + a SHA256 checksums file under dist/release/.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
PKG_VERSION=$(node -p "require('./package.json').version")
if [ -z "$VERSION" ]; then
  VERSION="$PKG_VERSION"
elif [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "VERSION argument ($VERSION) does not match package.json version ($PKG_VERSION)." >&2
  echo "The binaries would still self-report $PKG_VERSION — bin/testaipack.ts reads its" >&2
  echo "version from package.json at build time, not from this argument. Bump" >&2
  echo "package.json to $VERSION first, or pass no argument to build the current version." >&2
  exit 1
fi

OUT_DIR="dist/release"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

BUN="./node_modules/.bin/bun"
ENTRY="bin/testaipack.ts"
INSTALL_SCRIPT="install.sh"

if [ ! -x "$BUN" ]; then
  echo "bun not found at $BUN" >&2
  exit 1
fi
if [ ! -f "$ENTRY" ]; then
  echo "entry not found: $ENTRY" >&2
  exit 1
fi
if [ ! -f "$INSTALL_SCRIPT" ]; then
  echo "install script not found: $INSTALL_SCRIPT" >&2
  exit 1
fi

echo "Copying $INSTALL_SCRIPT..."
cp "$INSTALL_SCRIPT" "$OUT_DIR/install.sh"

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
