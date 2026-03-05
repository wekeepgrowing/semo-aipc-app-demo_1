#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACTION="${1:-}"
TAIL_LINES="${2:-80}"
IMAGE_NAME="openclaw-our-os:dev"
CONTAINER_NAME="openclaw-our-os"

fail() {
  echo "[docker-dev] $*" >&2
  exit 1
}

docker_cmd() {
  if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
    docker --context "${DOCKER_CONTEXT}" "$@"
  else
    docker "$@"
  fi
}

ensure_docker_daemon() {
  command -v docker >/dev/null 2>&1 || fail "Docker CLI not found. Install Docker first."

  if docker info >/dev/null 2>&1; then
    return 0
  fi

  if docker --context colima info >/dev/null 2>&1; then
    export DOCKER_CONTEXT="colima"
    echo "[docker-dev] Docker context fallback: colima"
    return 0
  fi

  if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "/Applications/Docker.app" ]]; then
    echo "[docker-dev] Docker daemon not reachable. Trying to start Docker Desktop..."
    open -ga Docker || true
    for _ in $(seq 1 30); do
      if docker info >/dev/null 2>&1; then
        return 0
      fi
      sleep 2
    done
  fi

  fail "Docker daemon is not running (desktop-linux unavailable, colima unavailable)."
}

compose_mode() {
  if docker_cmd compose version >/dev/null 2>&1; then
    echo "docker_compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker_compose_v1"
    return 0
  fi
  echo "none"
}

compose_run() {
  local mode="$1"
  shift

  if [[ "${mode}" == "docker_compose" ]]; then
    docker_cmd compose "$@"
    return 0
  fi
  if [[ "${mode}" == "docker_compose_v1" ]]; then
    docker-compose "$@"
    return 0
  fi
  fail "compose_run called without compose mode"
}

fallback_up() {
  mkdir -p "${ROOT_DIR}/data" "${ROOT_DIR}/data/linuxbrew"

  if ! docker_cmd image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
    echo "[docker-dev] Image not found. Building ${IMAGE_NAME}..."
    docker_cmd build -t "${IMAGE_NAME}" -f "${ROOT_DIR}/Dockerfile" "${ROOT_DIR}"
  fi

  docker_cmd rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker_cmd run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --init \
    -p 18789:18789 \
    -e OUR_OS_METRICS_BASE_URL="http://host.docker.internal:19090" \
    -e OUR_OS_METRICS_PATH="/api/v1/system/metrics" \
    -e OUR_OS_METRICS_AUTH_MODE="none" \
    -v "${ROOT_DIR}/data:/data" \
    -v "${ROOT_DIR}/data/linuxbrew:/home/linuxbrew" \
    "${IMAGE_NAME}" >/dev/null
}

fallback_down() {
  docker_cmd rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}

fallback_logs_follow() {
  docker_cmd logs -f "${CONTAINER_NAME}"
}

fallback_logs_tail() {
  docker_cmd logs --tail "${TAIL_LINES}" "${CONTAINER_NAME}" || true
}

ensure_docker_daemon

COMPOSE_MODE="$(compose_mode)"

cd "${ROOT_DIR}"

case "${ACTION}" in
  up)
    if [[ "${COMPOSE_MODE}" == "none" ]]; then
      echo "[docker-dev] Compose plugin not found. Using direct docker run fallback."
      fallback_up
    else
      compose_run "${COMPOSE_MODE}" up -d --pull never openclaw
    fi
    ;;
  down)
    if [[ "${COMPOSE_MODE}" == "none" ]]; then
      fallback_down
    else
      compose_run "${COMPOSE_MODE}" down
    fi
    ;;
  logs)
    if [[ "${COMPOSE_MODE}" == "none" ]]; then
      fallback_logs_follow
    else
      compose_run "${COMPOSE_MODE}" logs -f openclaw
    fi
    ;;
  logs-tail)
    if [[ "${COMPOSE_MODE}" == "none" ]]; then
      fallback_logs_tail
    else
      compose_run "${COMPOSE_MODE}" logs --tail="${TAIL_LINES}" openclaw
    fi
    ;;
  *)
    fail "Usage: $0 {up|down|logs|logs-tail [lines]}"
    ;;
esac
