# CasaOS에서 Semo AI 설치하는 방법

이 문서는 CasaOS 담당자가 `Semo AI`를 직접 설치하고 테스트할 때 보는 안내서입니다.

기준:

- 설치 대상: `CasaOS`
- 장비 아키텍처: `x86`
- 설치 방식: `Custom Install`
- 실행 방식: CasaOS 안에서 Docker 앱으로 실행

중요한 점:

- CasaOS 장비에서 소스를 빌드하지 않습니다.
- 미리 빌드된 `linux/amd64` Docker 이미지를 pull 해서 실행합니다.
- 설정, 인증 정보, 실행 이력은 모두 `/DATA/AppData/semo-ai` 아래에 저장됩니다.

## 1. 설치 전에 준비할 것

아래 1가지만 있으면 설치할 수 있습니다.

- `SEMO_AI_IMAGE`

예시:

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.2-amd64@sha256:REPLACE_ME
```

즉 설치 담당자는 우리에게 아래 값을 받아야 합니다.

- Docker 이미지 주소
- 정확한 태그
- 정확한 digest

## 2. CasaOS에서 어디에 넣어야 하나

CasaOS의 `Custom Install` 화면에 [docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml) 내용을 넣으면 됩니다.

같이 참고할 파일:

- compose: [docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml)
- 환경변수 예시: [.env.example](/Users/hj/workspace/semo-ai-app/deploy/casaos/.env.example)

## 3. 가장 쉬운 설치 순서

### 3-1. CasaOS에서 Custom Install 열기

CasaOS 화면에서 새 앱을 추가할 때 `Custom Install`을 엽니다.

### 3-2. compose 붙여넣기

[docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml) 내용을 그대로 붙여넣습니다.

현재 기본 compose는 아래 구조입니다.

```yaml
version: "3.8"

services:
  semo-ai:
    image: ${SEMO_AI_IMAGE:-ghcr.io/your-org/semo-ai:2026.3.2-amd64@sha256:REPLACE_ME}
    container_name: semo-ai
    platform: linux/amd64
    init: true
    restart: unless-stopped
    stop_grace_period: 1m
    ports:
      - "18789:18789"
    environment:
      SEMO_ASSISTANT_NAME: ${SEMO_ASSISTANT_NAME:-Semo AI}
      TMPDIR: ${TMPDIR:-/data/.tmp}
      TMP: ${TMP:-/data/.tmp}
      TEMP: ${TEMP:-/data/.tmp}
      OUR_OS_METRICS_BASE_URL: ${OUR_OS_METRICS_BASE_URL:-}
      OUR_OS_METRICS_PATH: ${OUR_OS_METRICS_PATH:-/api/v1/system/metrics}
      OUR_OS_METRICS_AUTH_MODE: ${OUR_OS_METRICS_AUTH_MODE:-none}
      OUR_OS_METRICS_TOKEN: ${OUR_OS_METRICS_TOKEN:-}
      OUR_OS_METRICS_TOKEN_FILE: ${OUR_OS_METRICS_TOKEN_FILE:-}
      OUR_OS_METRICS_TIMEOUT_MS: ${OUR_OS_METRICS_TIMEOUT_MS:-3500}
    volumes:
      - /DATA/AppData/semo-ai/data:/data
      - /DATA/AppData/semo-ai/linuxbrew:/home/linuxbrew
```

### 3-3. image 값 바꾸기

위 compose 안의 `SEMO_AI_IMAGE`를 실제 릴리스 값으로 바꿉니다.

예시:

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.2-amd64@sha256:REAL_DIGEST
```

### 3-4. 설치 실행

설치를 실행하면 CasaOS가 이미지를 pull 하고 컨테이너를 올립니다.

## 4. 설치 후 어디로 접속하나

브라우저에서 아래 주소로 접속합니다.

```text
http://<CasaOS IP>:18789
```

예시:

```text
http://192.168.0.10:18789
```

## 5. 처음 설치 후 꼭 확인할 것

처음 열었을 때 아래 흐름이 보여야 정상입니다.

1. 온보딩 화면이 열린다
2. OpenAI OAuth 또는 API Key 설정이 가능하다
3. 홈 화면으로 진입된다
4. 대화 페이지가 열린다
5. 실행 페이지가 열린다
6. 스킬 페이지가 열린다
7. 모니터 페이지가 열린다

## 6. 이 버전에서 반영된 중요한 수정

이번 CasaOS 배포 기준에서 특히 중요한 점은 아래입니다.

- OpenAI OAuth가 브라우저 인증 후 다음 단계로 넘어가지 않던 문제 수정
- 리디렉트 URL 입력 후 멈추지 않도록 서버에서 직접 OAuth 완료 처리
- 임시 파일 경로를 `/data/.tmp`로 고정
- 잘못된 onboarding config 때문에 gateway가 죽던 문제 자동 정리
- CasaOS에서는 `OUR_OS_METRICS_BASE_URL`가 없어도 모니터가 로컬 fallback 메트릭으로 동작

## 7. 왜 `/DATA/AppData/semo-ai`를 쓰나

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

## 8. 설치 담당자가 헷갈리기 쉬운 포인트

### Q1. CasaOS 장비에서 직접 빌드해야 하나요?

아니요.

CasaOS 장비에서는 빌드하지 않고, 이미 만들어진 Docker 이미지를 pull 해서 실행하는 것이 기준입니다.

### Q2. ARM 장비도 되나요?

현재 이 가이드는 `x86` 기준입니다.

### Q3. 왜 `OUR_OS_METRICS_BASE_URL`는 비워 두나요?

CasaOS에는 Our OS 전용 메트릭 API가 없을 수 있어서, 기본은 비워 둡니다.

비워 두면 서버가 로컬 컨테이너 기준 CPU/메모리/디스크/네트워크 값을 반환합니다.

### Q4. `/tmp` 대신 `/data/.tmp`를 쓰는 이유는?

온보딩/OAuth 과정에서 임시 파일이 필요합니다.

컨테이너 루트의 `/tmp`는 공간이 부족해질 수 있어서, AppData 아래 임시 경로를 쓰도록 고정했습니다.

## 9. 업데이트 방법

업데이트는 `이미지 주소만 새 버전으로 바꾼 뒤 다시 배포`하면 됩니다.

먼저 백업:

```bash
cd /DATA/AppData
tar -czf "semo-ai-backup-$(date +%Y%m%d-%H%M%S).tgz" semo-ai
```

그다음 compose 안 `SEMO_AI_IMAGE`를 새 값으로 바꿉니다.

예시:

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.3-amd64@sha256:NEW_DIGEST
```

업데이트 후 확인:

1. 앱이 켜지는지
2. 기존 설정이 유지되는지
3. 대화가 되는지
4. 웹 리서치가 되는지
5. 모니터가 보이는지

## 10. 롤백 방법

문제가 생기면 이전 이미지 digest로 되돌리면 됩니다.

예시:

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.2-amd64@sha256:OLD_DIGEST
```

필요하면 AppData도 복원합니다.

```bash
cd /DATA/AppData
mv semo-ai "semo-ai.broken.$(date +%Y%m%d-%H%M%S)"
tar -xzf semo-ai-backup-YYYYMMDD-HHMMSS.tgz
```

## 11. 설치 담당자에게 전달하면 되는 한 문장

아래처럼 전달하면 됩니다.

`CasaOS에서는 deploy/casaos/docker-compose.yml 내용을 Custom Install에 넣고, SEMO_AI_IMAGE만 실제 x86 릴리스 이미지 태그+digest로 바꿔서 설치해 주세요. 설치 후에는 http://<장비IP>:18789 로 접속하면 됩니다.`
