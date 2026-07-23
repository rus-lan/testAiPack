#!/usr/bin/env sh
# testaipack installer — downloads the latest release binary for your platform.
# Usage: curl -fsSL https://raw.githubusercontent.com/rus-lan/testAiPack/main/install.sh | sh
#   or:  wget -qO- https://raw.githubusercontent.com/rus-lan/testAiPack/main/install.sh | sh
#
# Override the install dir with:  INSTALL_DIR=/opt/bin sh install.sh
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

# --- find the latest release's download URL for our asset ---
echo "testaipack: resolving latest release..."
API_URL="https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"

RELEASE_JSON=$(curl -fsSL "$API_URL" 2>/dev/null || true)
if [ -z "$RELEASE_JSON" ]; then
  RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${OWNER}/${REPO}/releases" 2>/dev/null | head -c 200000)
fi

if [ -z "$RELEASE_JSON" ]; then
  echo "testaipack: could not reach GitHub API. Check your network connection." >&2
  exit 1
fi

# Extract the browser_download_url whose path ends with our asset name.
# grep/sed parsing avoids a hard dependency on jq.
DOWNLOAD_URL=$(printf '%s\n' "$RELEASE_JSON" \
  | grep -o '"browser_download_url":[[:space:]]*"https://[^"]*"' \
  | grep -o "https://[^\"' ]*/${asset}\"" \
  | sed 's/"$//' \
  | head -1)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "testaipack: asset '$asset' not found in the latest release." >&2
  echo "Available assets:" >&2
  printf '%s\n' "$RELEASE_JSON" | grep -o '"name":[[:space:]]*"[^"]*"' | head -20 >&2
  exit 1
fi

# --- install ---
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"

TARGET="$INSTALL_DIR/$BINARY_NAME"
if [ "$os" = "windows" ]; then
  TARGET="${TARGET}.exe"
fi

echo "testaipack: downloading $asset..."
curl -fsSL -o "$TARGET" "$DOWNLOAD_URL"
chmod +x "$TARGET" 2>/dev/null || true

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
