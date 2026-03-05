#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:18789/api/ui/health}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-60}"
SLEEP_SECONDS=2
ATTEMPTS=$((MAX_WAIT_SECONDS / SLEEP_SECONDS))
DOCKER_HELPER="${ROOT_DIR}/scripts/dev/docker-compose-dev.sh"

fail() {
  echo "[dev:docker-ui] $*" >&2
  exit 1
}

cd "${ROOT_DIR}"

echo "[dev:docker-ui] Starting Docker backend (service: openclaw)..."
bash "${DOCKER_HELPER}" up

echo "[dev:docker-ui] Waiting for backend readiness: ${HEALTH_URL}"
READY=0
for ((i = 1; i <= ATTEMPTS; i++)); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep "${SLEEP_SECONDS}"
done

if [[ "${READY}" -ne 1 ]]; then
  echo "[dev:docker-ui] Backend did not become ready in ${MAX_WAIT_SECONDS}s."
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:18789 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[dev:docker-ui] Port 18789 is in use:"
      lsof -nP -iTCP:18789 -sTCP:LISTEN || true
    fi
  fi
  echo "[dev:docker-ui] Recent backend logs:"
  bash "${DOCKER_HELPER}" logs-tail 80 || true
  fail "Readiness check failed."
fi

echo "[dev:docker-ui] Backend ready."
echo "[dev:docker-ui] Starting local UI dev server with HMR at http://127.0.0.1:5173"
echo "[dev:docker-ui] Tip: Ctrl+C stops only Vite. Backend remains running."
exec npm --prefix ui run dev -- --host 127.0.0.1 --port 5173
