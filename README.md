# OpenClaw Custom UI Gateway (Our OS)

This repository packages OpenClaw for Our OS with a custom UI-first runtime.

## What this runtime does

- Replaces OpenClaw default GUI with a custom UI (`/` and `/app/*`)
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

Set these environment variables for `/api/ui/system/metrics`:

- `OUR_OS_METRICS_BASE_URL` (required)
- `OUR_OS_METRICS_PATH` (optional, default `/api/v1/system/metrics`)
- `OUR_OS_METRICS_AUTH_MODE` (`none`, `bearer`, `x-api-key`)
- `OUR_OS_METRICS_TOKEN` or `OUR_OS_METRICS_TOKEN_FILE`
- `OUR_OS_METRICS_TIMEOUT_MS` (optional, default `3500`)

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
docker build -t openclaw-our-os:dev .
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

- `ouros/openclaw/` contains our OS package metadata, compose, and lifecycle hooks.
- `openclaw` npm updates are automated via workflows in `.github/workflows/`.
