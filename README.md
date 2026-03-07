# Semo AI Runtime

This repository packages the Semo AI runtime with a custom UI-first gateway and deployment assets for both Our OS and CasaOS-style Docker installs.

## What this runtime does

- Replaces the default OpenClaw GUI with a custom Semo AI UI (`/` and `/app/*`)
- Exposes custom UI API namespace under `/api/ui/*`
- Proxies OpenClaw gateway API through `/api/oc/*`
- Proxies OpenClaw gateway WebSocket through `/ws/oc/*`
- Keeps gateway token injection server-side only
- Blocks legacy OpenClaw GUI direct routing paths

## API surface

- `GET /api/ui/health`
- `GET /api/ui/onboarding/state`
- `GET /api/ui/onboarding/options`
- `POST /api/ui/onboarding/apply`
- `POST /api/ui/onboarding/cancel`
- `WS /api/ui/onboarding/auth/:sessionId`
- `WS /api/ui/onboarding/terminal`
- `GET /api/ui/system/metrics`
- `GET|POST /api/oc/*` -> proxied to internal OpenClaw gateway (`127.0.0.1:18790`)
- `WS /ws/oc/*` -> proxied to internal OpenClaw gateway

`GET /api/ui/onboarding/state` includes:

- `mode`: `gui | terminal`
- `interactiveAuthInProgress`: `boolean`
- `lastErrorCode`: `string | null`

## Metrics configuration

Set these environment variables for `/api/ui/system/metrics` when you want to read an external metrics API:

- `OUR_OS_METRICS_BASE_URL` (optional)
- `OUR_OS_METRICS_PATH` (optional, default `/api/v1/system/metrics`)
- `OUR_OS_METRICS_AUTH_MODE` (`none`, `bearer`, `x-api-key`)
- `OUR_OS_METRICS_TOKEN` or `OUR_OS_METRICS_TOKEN_FILE`
- `OUR_OS_METRICS_TIMEOUT_MS` (optional, default `3500`)

If `OUR_OS_METRICS_BASE_URL` is not set, the server falls back to local container metrics for CPU, memory, disk, and network usage. This is the default mode for CasaOS deployments.

Normalized response schema:

- `cpuPercent`
- `cpuTempC`
- `memUsedGb`
- `memTotalGb`
- `memPercent`
- `diskUsedGb`
- `diskTotalGb`
- `diskPercent`
- `rxBps`
- `txBps`
- `ts`

## CasaOS 설치 가이드 (한국어)

이 저장소는 CasaOS에서 `Custom Install`로 바로 올릴 수 있게 준비되어 있습니다.

기준:

- 설치 대상: `CasaOS`
- 장비 아키텍처: `x86`
- 설치 방식: `Custom Install`
- 실행 방식: Docker 앱

중요한 점:

- CasaOS 장비에서 소스를 직접 빌드하지 않습니다.
- 미리 빌드된 `linux/amd64` 이미지를 pull 해서 실행합니다.
- 설정, OAuth 인증 정보, 실행 이력은 `/DATA/AppData/semo-ai` 아래에 저장됩니다.

### 1. 설치 전에 필요한 것

아래 값 하나만 준비하면 됩니다.

- `SEMO_AI_IMAGE`

예시:

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.2-amd64@sha256:REPLACE_ME
```

즉 설치 담당자는 아래 3가지를 받아야 합니다.

- Docker 이미지 주소
- 정확한 태그
- 정확한 digest

### 2. CasaOS에 무엇을 넣어야 하나

CasaOS의 `Custom Install` 화면에 아래 파일 내용을 넣으면 됩니다.

- compose: [deploy/casaos/docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml)
- 환경변수 예시: [deploy/casaos/.env.example](/Users/hj/workspace/semo-ai-app/deploy/casaos/.env.example)
- 상세 안내: [deploy/casaos/README.md](/Users/hj/workspace/semo-ai-app/deploy/casaos/README.md)

### 3. 가장 쉬운 설치 순서

1. CasaOS에서 `Custom Install`을 엽니다.
2. [deploy/casaos/docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml) 내용을 그대로 붙여넣습니다.
3. `SEMO_AI_IMAGE`를 실제 릴리스 이미지 태그+digest로 바꿉니다.
4. 설치를 실행합니다.

기본 compose 핵심 구조는 아래와 같습니다.

```yaml
version: "3.8"

services:
  semo-ai:
    image: ${SEMO_AI_IMAGE:-ghcr.io/your-org/semo-ai:2026.3.2-amd64@sha256:REPLACE_ME}
    container_name: semo-ai
    platform: linux/amd64
    init: true
    restart: unless-stopped
    ports:
      - "18789:18789"
    environment:
      SEMO_ASSISTANT_NAME: ${SEMO_ASSISTANT_NAME:-Semo AI}
      TMPDIR: ${TMPDIR:-/data/.tmp}
      TMP: ${TMP:-/data/.tmp}
      TEMP: ${TEMP:-/data/.tmp}
      OUR_OS_METRICS_BASE_URL: ${OUR_OS_METRICS_BASE_URL:-}
    volumes:
      - /DATA/AppData/semo-ai/data:/data
      - /DATA/AppData/semo-ai/linuxbrew:/home/linuxbrew
```

### 4. 설치 후 어디로 접속하나

브라우저에서 아래 주소로 접속하면 됩니다.

```text
http://<CasaOS IP>:18789
```

예시:

```text
http://192.168.0.10:18789
```

### 5. 처음 설치 후 꼭 확인할 것

처음 열었을 때 아래 흐름이 보여야 정상입니다.

1. 온보딩 화면이 열린다
2. OpenAI OAuth 또는 API Key 설정이 가능하다
3. 홈 화면으로 진입된다
4. 대화 페이지가 열린다
5. 실행 페이지가 열린다
6. 스킬 페이지가 열린다
7. 모니터 페이지가 열린다

### 6. 이 버전에서 반영된 중요한 수정

- OpenAI OAuth가 브라우저 인증 후 다음 단계로 넘어가지 않던 문제 수정
- 리디렉트 URL 입력 후 멈추지 않도록 서버에서 직접 OAuth 완료 처리
- 임시 파일 경로를 `/data/.tmp`로 고정
- 잘못된 onboarding config 때문에 gateway가 죽던 문제 자동 정리
- CasaOS에서는 `OUR_OS_METRICS_BASE_URL`가 없어도 모니터가 로컬 fallback 메트릭으로 동작

### 7. 왜 `/DATA/AppData/semo-ai`를 쓰나

이 경로에 아래 데이터가 저장됩니다.

- API 키
- OAuth 인증 정보
- 실행 이력
- 결과 문서
- 브라우저 프로필
- Linuxbrew 관련 파일

즉 컨테이너를 다시 띄워도 데이터가 유지됩니다.

기본 마운트:

- `/DATA/AppData/semo-ai/data:/data`
- `/DATA/AppData/semo-ai/linuxbrew:/home/linuxbrew`

### 8. 설치 담당자가 헷갈리기 쉬운 포인트

`Q. CasaOS 장비에서 직접 빌드해야 하나요?`

- 아닙니다. CasaOS 장비에서는 이미 만들어진 Docker 이미지를 pull 해서 실행하는 것이 기준입니다.

`Q. ARM 장비도 되나요?`

- 현재 이 가이드는 `x86` 기준입니다.

`Q. 왜 OUR_OS_METRICS_BASE_URL는 비워 두나요?`

- CasaOS에는 Our OS 전용 메트릭 API가 없을 수 있어서 기본은 비워 둡니다.
- 비워 두면 서버가 로컬 컨테이너 기준 CPU/메모리/디스크/네트워크 값을 반환합니다.

`Q. 왜 /tmp 대신 /data/.tmp를 쓰나요?`

- 온보딩/OAuth 과정에서 임시 파일이 필요합니다.
- 컨테이너 루트의 `/tmp`는 공간 이슈가 날 수 있어서 AppData 아래 임시 경로를 사용합니다.

### 9. 업데이트 방법

업데이트는 `이미지 주소만 새 버전으로 바꾼 뒤 다시 배포`하면 됩니다.

먼저 백업:

```bash
cd /DATA/AppData
tar -czf "semo-ai-backup-$(date +%Y%m%d-%H%M%S).tgz" semo-ai
```

그다음 `SEMO_AI_IMAGE`를 새 값으로 바꿉니다.

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.3-amd64@sha256:NEW_DIGEST
```

업데이트 후에는 아래를 확인하면 됩니다.

1. 앱이 켜지는지
2. 기존 설정이 유지되는지
3. 대화가 되는지
4. 웹 리서치가 되는지
5. 모니터가 보이는지

### 10. 롤백 방법

문제가 생기면 이전 이미지 digest로 되돌리면 됩니다.

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.2-amd64@sha256:OLD_DIGEST
```

필요하면 AppData도 복원합니다.

```bash
cd /DATA/AppData
mv semo-ai "semo-ai.broken.$(date +%Y%m%d-%H%M%S)"
tar -xzf semo-ai-backup-YYYYMMDD-HHMMSS.tgz
```

## Local development (Docker runtime + UI HMR)

This is the default development workflow.

- Runtime/Gateway: Docker container (`localhost:18789`)
- UI editing/HMR: local Vite (`localhost:5173`)

1. Install dependencies:

```bash
npm install
npm --prefix ui install
```

2. Start backend + UI dev server (one command):

```bash
npm run dev:docker-ui
```

3. Open:

```text
http://127.0.0.1:5173
```

4. Useful helper commands:

```bash
npm run dev:docker-up     # start backend only
npm run dev:docker-logs   # tail backend logs
npm run dev:docker-down   # stop backend
```

### Notes

- In Docker development mode, do not use `npm run dev` as the primary loop.
- Data is persisted at `${OPENCLAW_DATA_PATH:-./data}` (mounted to `/data` in container).
- Linuxbrew data path is `${OPENCLAW_LINUXBREW_PATH:-./data/linuxbrew}`.
- To use a different local path:

```bash
cp .env.example .env
# edit .env values if needed
export OPENCLAW_DATA_PATH=/absolute/path/to/openclaw-data
export OPENCLAW_LINUXBREW_PATH=/absolute/path/to/openclaw-data/linuxbrew
```

- For real app packaging, use OS-managed app data path (not fixed `./data`).
  - [`ouros/openclaw/docker-compose.yml`](/Users/hj/workspace/semo-ai-app/ouros/openclaw/docker-compose.yml) already uses:
    - `${APP_DATA_DIR}/data:/data`
    - `${APP_DATA_DIR}/data/linuxbrew:/home/linuxbrew`
  - CasaOS custom install assets live under [`deploy/casaos`](/Users/hj/workspace/semo-ai-app/deploy/casaos).
- If onboarding does not appear due to stale config, reset local app data:

```bash
rm -rf "${OPENCLAW_DATA_PATH:-./data}"
```

### Troubleshooting

- Docker daemon not running:
  - If Docker Desktop is installed, start Docker Desktop.
  - If you use Colima, keep Colima running (`colima start`). Dev scripts auto-fallback to `colima` context.
- `docker compose` not found: dev scripts automatically fallback to direct `docker run` mode for this project.
- Port conflict on `18789`: stop conflicting process or change mapping.
- Backend readiness failure: run `npm run dev:docker-logs` and inspect errors.

## Onboarding behavior (v1)

- Default onboarding UI is a GUI modal stepper.
- Fixed onboarding policy:
  - `--flow quickstart`
  - `--skip-channels --skip-skills --skip-daemon --skip-ui --skip-health`
  - `--mode local --gateway-port 18790`
- API key methods use non-interactive apply (`/api/ui/onboarding/apply`).
- OAuth/setup-token style methods start an interactive auth session (`/api/ui/onboarding/auth/:sessionId`), then server finalizes onboarding with `--auth-choice skip`.
- Existing `WS /api/ui/onboarding/terminal` is kept as advanced fallback mode.

## Container build

```bash
docker build -t semo-ai:dev .
```

## Onboarding Prompt Discovery (No local OpenClaw install)

You can capture real onboarding prompts without installing OpenClaw on your laptop.

1. Run interactive capture in Docker (builds image, runs onboarding, saves log + parsed JSON):

```bash
npm run onboarding:capture
```

2. Optional flow override:

```bash
FLOW=advanced npm run onboarding:capture
```

Artifacts are written to `onboarding-artifacts/`:

- `onboard-<flow>-<timestamp>.log` (raw terminal transcript)
- `onboard-<flow>-<timestamp>.json` (structured steps for GUI planning)

3. Parse an existing log file only:

```bash
npm run onboarding:parse -- --in onboarding-artifacts/onboard-quickstart-YYYYMMDD-HHMMSS.log
```

## Notes

- [`ouros/openclaw/`](/Users/hj/workspace/semo-ai-app/ouros/openclaw) contains Our OS package metadata, compose, and lifecycle hooks.
- [`deploy/casaos/`](/Users/hj/workspace/semo-ai-app/deploy/casaos) contains CasaOS custom install assets, backup/update guidance, and the x86-only deployment compose.
- `openclaw` npm updates are automated via workflows in `.github/workflows/`.
