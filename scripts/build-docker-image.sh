#!/usr/bin/env bash
# Build the local opencode image used by `testaipack run --isolation docker`.
# There is no published upstream image, so this must be built once per machine.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_NAME="${1:-testaipack-opencode}"
IMAGE_TAG="${2:-latest}"
IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
# Optional 3rd arg overrides the opencode version pinned in Dockerfile.opencode
# (its ARG OPENCODE_VERSION default) — for a one-off test build only.
OPENCODE_VERSION="${3:-}"

BUILD_ARGS=()
if [ -n "$OPENCODE_VERSION" ]; then
  BUILD_ARGS=(--build-arg "OPENCODE_VERSION=${OPENCODE_VERSION}")
fi

echo "Building Docker image ${IMAGE}..."
docker build "${BUILD_ARGS[@]}" -t "${IMAGE}" -f "${PROJECT_DIR}/Dockerfile.opencode" "${PROJECT_DIR}"

echo "Verifying image works (opencode --version)..."
docker run --rm "${IMAGE}" opencode --version

echo "✓ Image ${IMAGE} ready"
echo "Use with:"
echo "  testaipack run <repo> --isolation docker --docker-image ${IMAGE} --pack ... --prompt ..."
