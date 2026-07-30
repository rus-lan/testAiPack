#!/usr/bin/env sh
# testaipack installer — downloads the release binary for your platform.
# The latest release's tag is resolved with a single redirect probe against
# GitHub's release-download URL (avoids the REST API's per-IP rate limit);
# the binary and its checksums are then downloaded from that release's
# pinned releases/download/<tag>/ path.
# Usage: curl -fsSL https://github.com/rus-lan/testAiPack/releases/latest/download/install.sh | sh
#   or:  wget -qO- https://github.com/rus-lan/testAiPack/releases/latest/download/install.sh | sh
#
# Override the install dir with:   INSTALL_DIR=/opt/bin sh install.sh
# Pin a specific version with:     TESTAIPACK_VERSION=0.5.0 sh install.sh
# Skip checksum verification with: TESTAIPACK_SKIP_CHECKSUM=1 sh install.sh
set -eu

OWNER="rus-lan"
REPO="testAiPack"
BINARY_NAME="testaipack"

# --- detect platform ---
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  linux*)  os="linux"  ;;
  darwin*) os="darwin" ;;
  mingw*|msys*|cygwin*) os="windows" ;;
  *) echo "testaipack: unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  arch="x64"   ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "testaipack: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [ "$os" = "windows" ]; then
  asset="${BINARY_NAME}-${os}-${arch}.exe"
else
  asset="${BINARY_NAME}-${os}-${arch}"
fi

# --- resolve the release path: latest, or a pinned TESTAIPACK_VERSION ---
# "latest" is resolved to one concrete tag with a single redirect probe, then
# every asset (binary + checksums) is downloaded from that same
# releases/download/<tag>/ path — two independent "latest" lookups can never
# race and disagree between the binary and its checksum file.
if [ -n "${TESTAIPACK_VERSION:-}" ]; then
  RESOLVED_TAG="v${TESTAIPACK_VERSION#v}"
  echo "testaipack: installing pinned version ${RESOLVED_TAG}..."
else
  echo "testaipack: resolving latest release..."
  PROBE_URL="https://github.com/${OWNER}/${REPO}/releases/latest/download/checksums-sha256.txt"
  if ! REDIRECT_URL=$(curl -fsS --no-location -o /dev/null -w '%{redirect_url}' "$PROBE_URL"); then
    echo "testaipack: could not resolve the latest release from GitHub (network error, rate limit, or HTTP failure — see curl's message above)." >&2
    echo "  probed: $PROBE_URL" >&2
    exit 1
  fi
  if [ -z "$REDIRECT_URL" ]; then
    echo "testaipack: GitHub did not redirect while resolving the latest release — no release may exist yet." >&2
    echo "  probed: $PROBE_URL" >&2
    exit 1
  fi
  RESOLVED_TAG=$(printf '%s' "$REDIRECT_URL" | sed -n 's#.*/releases/download/\(v[^/]*\)/.*#\1#p')
  if [ -z "$RESOLVED_TAG" ]; then
    echo "testaipack: could not parse a release tag from GitHub's redirect." >&2
    echo "  redirect target: $REDIRECT_URL" >&2
    exit 1
  fi
  echo "testaipack: resolved latest release to ${RESOLVED_TAG}."
fi
RELEASE_PATH="releases/download/${RESOLVED_TAG}"
BASE_URL="https://github.com/${OWNER}/${REPO}/${RELEASE_PATH}"
DOWNLOAD_URL="${BASE_URL}/${asset}"

# --- install ---
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"

if [ ! -w "$INSTALL_DIR" ]; then
  echo "testaipack: cannot write to $INSTALL_DIR — check permissions or ownership." >&2
  echo "  re-run with sudo, or set INSTALL_DIR to a writable location, e.g.:" >&2
  echo "  INSTALL_DIR=\$HOME/.local/bin sh install.sh" >&2
  exit 1
fi

TARGET="$INSTALL_DIR/$BINARY_NAME"
if [ "$os" = "windows" ]; then
  TARGET="${TARGET}.exe"
fi

# TMP_FILE lives inside INSTALL_DIR (not $TMPDIR) so the final "mv" below is
# an atomic same-filesystem rename instead of a cross-filesystem copy, which
# could otherwise leave a truncated file at $TARGET if it runs out of space
# or is interrupted partway through.
TMP_FILE=$(mktemp "$INSTALL_DIR/.testaipack-dl.XXXXXX")
TMP_CHECKSUMS=""
cleanup() {
  rm -f "$TMP_FILE" "$TMP_CHECKSUMS" 2>/dev/null
}
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 131' QUIT
trap 'cleanup; exit 143' TERM

echo "testaipack: downloading $asset..."
if ! curl -fsSL -o "$TMP_FILE" "$DOWNLOAD_URL"; then
  echo "testaipack: could not download $asset from $DOWNLOAD_URL" >&2
  if [ -n "${TESTAIPACK_VERSION:-}" ]; then
    echo "testaipack: check that release ${RESOLVED_TAG} exists and includes this asset:" >&2
    echo "  https://github.com/${OWNER}/${REPO}/releases/tag/${RESOLVED_TAG}" >&2
  else
    echo "testaipack: check your network connection, or browse releases at:" >&2
    echo "  https://github.com/${OWNER}/${REPO}/releases/latest" >&2
  fi
  exit 1
fi

# --- verify checksum against checksums-sha256.txt from the same release ---
# Verification is mandatory: a missing sha256 tool, a failed checksums
# download, or a missing entry for this asset all hard-fail the install.
# Set TESTAIPACK_SKIP_CHECKSUM=1 to downgrade those three to a warning and
# install unverified anyway. An actual checksum mismatch is always fatal,
# regardless of that variable — a corrupted or tampered binary must never
# be installed.
SHA_CMD=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
fi

if [ -z "$SHA_CMD" ]; then
  if [ "${TESTAIPACK_SKIP_CHECKSUM:-}" = "1" ]; then
    echo "testaipack: WARNING: neither sha256sum nor shasum is available — skipping integrity check." >&2
  else
    echo "testaipack: neither sha256sum nor shasum is available — cannot verify the download." >&2
    echo "  set TESTAIPACK_SKIP_CHECKSUM=1 to install anyway without verification." >&2
    exit 1
  fi
else
  CHECKSUMS_URL="${BASE_URL}/checksums-sha256.txt"
  TMP_CHECKSUMS=$(mktemp "${TMPDIR:-/tmp}/testaipack-sha.XXXXXX")
  if ! curl -fsSL -o "$TMP_CHECKSUMS" "$CHECKSUMS_URL"; then
    rm -f "$TMP_CHECKSUMS"
    if [ "${TESTAIPACK_SKIP_CHECKSUM:-}" = "1" ]; then
      echo "testaipack: WARNING: could not download checksums-sha256.txt — skipping integrity check." >&2
    else
      echo "testaipack: could not download checksums-sha256.txt — cannot verify the download." >&2
      echo "  set TESTAIPACK_SKIP_CHECKSUM=1 to install anyway without verification." >&2
      exit 1
    fi
  else
    EXPECTED=$(grep -E "  ${asset}\$" "$TMP_CHECKSUMS" | awk '{print $1}' | head -1)
    rm -f "$TMP_CHECKSUMS"
    if [ -z "$EXPECTED" ]; then
      if [ "${TESTAIPACK_SKIP_CHECKSUM:-}" = "1" ]; then
        echo "testaipack: WARNING: no checksum entry for '$asset' — skipping integrity check." >&2
      else
        echo "testaipack: no checksum entry for '$asset' in checksums-sha256.txt — cannot verify the download." >&2
        echo "  set TESTAIPACK_SKIP_CHECKSUM=1 to install anyway without verification." >&2
        exit 1
      fi
    else
      ACTUAL=$($SHA_CMD "$TMP_FILE" | awk '{print $1}')
      if [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "testaipack: checksum mismatch for $asset — aborting install." >&2
        echo "  expected: $EXPECTED" >&2
        echo "  actual:   $ACTUAL" >&2
        exit 1
      fi
      echo "testaipack: checksum verified ($asset)."
    fi
  fi
fi

mv "$TMP_FILE" "$TARGET"
chmod 755 "$TARGET" 2>/dev/null || true

# --- PATH hint ---
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "NOTE: $INSTALL_DIR is not in your PATH."
    SHELL_NAME=$(basename "${SHELL:-sh}")
    case "$SHELL_NAME" in
      bash) rc="$HOME/.bashrc" ;;
      zsh)  rc="$HOME/.zshrc"  ;;
      fish) rc="$HOME/.config/fish/config.fish" ;;
      *)    rc="" ;;
    esac
    if [ -n "$rc" ]; then
      echo "Add this line to $rc:"
      echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    fi
    ;;
esac

echo ""
echo "testaipack: installed to $TARGET"
"$TARGET" --version 2>/dev/null || "$TARGET" --help 2>/dev/null | head -3 || true
echo ""
echo "Run: testaipack doctor   (to verify your environment)"
