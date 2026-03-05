#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/onboarding-artifacts}"
IMAGE_NAME="${IMAGE_NAME:-openclaw-probe:local}"
FLOW="${FLOW:-quickstart}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${OUT_DIR}/onboard-${FLOW}-${STAMP}.log"
JSON_FILE="${OUT_DIR}/onboard-${FLOW}-${STAMP}.json"
SESSION_FILE="${OUT_DIR}/session.log"

mkdir -p "${OUT_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found. Install Docker first." >&2
  exit 1
fi

echo "[1/4] Building image: ${IMAGE_NAME}"
docker build -t "${IMAGE_NAME}" "${ROOT_DIR}"

echo "[2/4] Starting interactive onboarding capture"
echo "      - Flow: ${FLOW}"
echo "      - Output log: ${LOG_FILE}"
echo "      - Complete onboarding or stop with Ctrl+C."

docker run --rm -it \
  --entrypoint bash \
  -e CAPTURE_FLOW="${FLOW}" \
  -v "${OUT_DIR}:/artifacts" \
  "${IMAGE_NAME}" \
  -lc '
set -euo pipefail
export HOME=/tmp/oc
mkdir -p "$HOME"
LOG_PATH="/artifacts/session.log"
CMD="openclaw onboard --flow ${CAPTURE_FLOW} --accept-risk --skip-channels --skip-skills --skip-daemon --skip-ui --skip-health --mode local --gateway-port 18790"
echo "Running: ${CMD}"
script -q "$LOG_PATH" -c "$CMD"
'

if [[ ! -f "${SESSION_FILE}" ]]; then
  echo "Capture failed: ${SESSION_FILE} not found." >&2
  exit 1
fi

mv "${SESSION_FILE}" "${LOG_FILE}"

echo "[3/4] Parsing log into structured steps"
node "${ROOT_DIR}/scripts/onboarding/parse-onboarding-log.mjs" --in "${LOG_FILE}" --out "${JSON_FILE}"

echo "[4/4] Done"
echo "      - Raw log: ${LOG_FILE}"
echo "      - Parsed steps: ${JSON_FILE}"
