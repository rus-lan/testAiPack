#!/usr/bin/env bash
# Publish a GitHub release for testaipack using the REST API.
# - creates the git tag if missing
# - creates the release (or reuses an existing one for the tag)
# - uploads every file under dist/release/ as a release asset
#
# Requires: GITHUB_TOKEN env var, dist/release/* built (run scripts/release.sh first),
#           dist/release-notes.md with the release body.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
OWNER="rus-lan"
REPO="testAiPack"
RELEASE_DIR="dist/release"
NOTES_FILE="dist/release-notes.md"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN not set" >&2
  exit 1
fi
if [ ! -f "$NOTES_FILE" ]; then
  echo "release notes not found: $NOTES_FILE" >&2
  exit 1
fi
if [ ! -d "$RELEASE_DIR" ] || [ -z "$(ls -A "$RELEASE_DIR" 2>/dev/null)" ]; then
  echo "no artifacts in $RELEASE_DIR — run scripts/release.sh first" >&2
  exit 1
fi

API="https://api.github.com/repos/${OWNER}/${REPO}"
AUTH="Authorization: Bearer ${GITHUB_TOKEN}"
ACCEPT="Accept: application/vnd.github+json"
API_VERSION="X-GitHub-Api-Version: 2022-11-28"

auth_curl() {
  curl -fsSL -H "$AUTH" -H "$ACCEPT" -H "$API_VERSION" "$@"
}

# --- tag ---
if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Creating tag $TAG..."
  git tag -a "$TAG" -m "Release $TAG"
  git push origin "$TAG"
else
  echo "Tag $TAG already exists locally."
  git ls-remote --exit-code origin "refs/tags/$TAG" >/dev/null 2>&1 || {
    echo "Pushing tag $TAG to origin..."
    git push origin "$TAG"
  }
fi

# --- release (reuse or create) ---
RELEASE_ID=$(auth_curl "${API}/releases/tags/${TAG}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)

if [ -n "$RELEASE_ID" ]; then
  echo "Release $TAG already exists (id=$RELEASE_ID), uploading assets..."
else
  echo "Creating release $TAG..."
  BODY_JSON=$(python3 -c '
import json, sys
body = open(sys.argv[1]).read()
print(json.dumps({
  "tag_name": sys.argv[2],
  "name": sys.argv[2],
  "body": body,
  "draft": False,
  "prerelease": False
}))
' "$NOTES_FILE" "$TAG")

  RESPONSE=$(printf '%s' "$BODY_JSON" | curl -fsSL -X POST \
    -H "$AUTH" -H "$ACCEPT" -H "$API_VERSION" \
    -H "Content-Type: application/json" \
    -d @- "${API}/releases")

  RELEASE_ID=$(printf '%s' "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  echo "Created release id=$RELEASE_ID"
fi

# --- upload assets ---
# Delete existing assets with the same name first (supports re-runs), then upload.
existing_assets_json=$(auth_curl "${API}/releases/${RELEASE_ID}" \
  | python3 -c '
import sys, json
data = json.load(sys.stdin)
for a in data.get("assets", []):
    print(a["name"] + "\t" + str(a["id"]))
')

UPLOAD_BASE="https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets"

shopt -s nullglob
for asset in "$RELEASE_DIR"/*; do
  name=$(basename "$asset")
  # remove previously uploaded asset with same name if present
  prev_id=$(printf '%s\n' "$existing_assets_json" | awk -F'\t' -v n="$name" '$1==n{print $2}')
  if [ -n "$prev_id" ]; then
    echo "  deleting previous $name (asset id=$prev_id)..."
    curl -fsSL -X DELETE -H "$AUTH" -H "$ACCEPT" -H "$API_VERSION" \
      "${API}/releases/assets/${prev_id}" >/dev/null 2>&1 || true
  fi
  echo "  uploading $name..."
  curl -fsSL -X POST \
    -H "$AUTH" -H "$ACCEPT" -H "$API_VERSION" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$asset" \
    "${UPLOAD_BASE}?name=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$name")" >/dev/null
done

echo ""
echo "Release $TAG published with assets:"
ls -la "$RELEASE_DIR"
echo ""
echo "Release URL: https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}"
