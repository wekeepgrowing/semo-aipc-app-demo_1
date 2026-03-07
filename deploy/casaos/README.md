# CasaOS용 Semo AI 배포 가이드

이 번들은 CasaOS의 `Custom Install`에 넣는 용도입니다. CasaOS 장비에서 소스를 직접 빌드하지 않고, 외부에서 미리 빌드한 `linux/amd64` 이미지를 pull 해서 실행하는 방식을 기준으로 합니다.

## 최신 반영 내용

- OpenAI OAuth는 리디렉트 URL 제출 후 멈추지 않도록 direct 처리 경로가 반영돼 있습니다.
- 임시 작업 경로는 `/data/.tmp`를 사용해서 컨테이너 루트 `/tmp` 부족으로 온보딩이 깨지지 않도록 맞춰져 있습니다.
- gateway 부팅 시 invalid config를 만들던 `wizard.*` 확장 키는 제거됐고, 기존 잘못된 키도 자동 정리됩니다.

## 포함 파일

- [docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml)
- [.env.example](/Users/hj/workspace/semo-ai-app/deploy/casaos/.env.example)

## 배포 전제

- 대상 장비: `x86`
- 설치 방식: CasaOS `Custom Install`
- 업데이트 방식: 수동 업데이트
- 롤백 방식: 이전 image digest로 되돌린 뒤 재배포
- AppData 경로: `/DATA/AppData/semo-ai`

## 1. 준비

1. registry에 업로드된 `linux/amd64` 이미지와 digest를 확보합니다.
2. [docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml)의 `SEMO_AI_IMAGE` 값을 실제 릴리스 이미지로 바꿉니다.
3. CasaOS에서 `Custom Install`을 열고 compose 내용을 붙여넣습니다.

기본 마운트는 아래처럼 고정합니다.

- `/DATA/AppData/semo-ai/data:/data`
- `/DATA/AppData/semo-ai/linuxbrew:/home/linuxbrew`

이 경로에 API 키, 런타임 상태, 결과 문서, 브라우저 프로필이 영속 저장됩니다.
임시 작업 디렉터리도 `/data/.tmp`를 쓰도록 고정해서, 컨테이너 루트 파일시스템의 `/tmp`가 부족해도 온보딩/OAuth가 계속 동작하도록 합니다.

## 2. 권장 compose

현재 권장 compose는 [docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml) 그대로 사용하면 됩니다.

중요한 점:

- `platform: linux/amd64`로 고정
- `SEMO_AI_IMAGE`는 반드시 `버전 태그 + digest` 사용
- `TMPDIR`, `TMP`, `TEMP`는 `/data/.tmp`로 유지
- `OUR_OS_METRICS_BASE_URL`는 CasaOS에서는 비워 두는 것이 기본

`OUR_OS_METRICS_BASE_URL`를 비워두면 서버가 외부 Our OS API 대신 로컬 컨테이너 기준 CPU, 메모리, 디스크, 네트워크 지표를 반환합니다.

## 2-1. 이미지 빌드 메모

권장 방식은 CI나 x86 개발 장비에서 `linux/amd64` 이미지를 빌드하는 것입니다.

```bash
docker build --platform linux/amd64 -t ghcr.io/your-org/semo-ai:2026.3.2-amd64 .
docker push ghcr.io/your-org/semo-ai:2026.3.2-amd64
```

Apple Silicon 맥에서 `linux/amd64`를 직접 빌드해야 할 때는 build-time Linuxbrew 설치를 끄고, 실제 x86 장비 첫 부팅 때 Linuxbrew를 자동 설치하도록 빌드하는 것이 안전합니다.

```bash
docker build \
  --platform linux/amd64 \
  --build-arg INSTALL_HOMEBREW_AT_BUILD=0 \
  -t ghcr.io/your-org/semo-ai:2026.3.2-amd64 .
```

## 3. CasaOS 설치 절차

1. CasaOS에서 `Custom Install`을 엽니다.
2. [docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml) 내용을 붙여넣습니다.
3. 필요하면 `.env.example` 값을 기준으로 환경변수를 수정합니다.
4. 설치 후 `http://<CasaOS IP>:18789` 로 접속합니다.

처음 접속 후 확인할 것:

- 온보딩 화면 진입
- 설정 모달에서 LLM 인증
- 대화 생성
- 웹 리서치 실행
- 모니터 페이지 정상 표시

## 4. 필수/선택 환경변수

필수:

- `SEMO_AI_IMAGE`

선택:

- `SEMO_ASSISTANT_NAME`
- `TMPDIR`
- `TMP`
- `TEMP`
- `OUR_OS_METRICS_BASE_URL`
- `OUR_OS_METRICS_PATH`
- `OUR_OS_METRICS_AUTH_MODE`
- `OUR_OS_METRICS_TOKEN`
- `OUR_OS_METRICS_TOKEN_FILE`
- `OUR_OS_METRICS_TIMEOUT_MS`

CasaOS 기본값에서는 `OUR_OS_METRICS_*`를 비워두는 것을 권장합니다.

## 5. 수동 업데이트

업데이트 전에 먼저 AppData를 백업합니다.

```bash
cd /DATA/AppData
tar -czf "semo-ai-backup-$(date +%Y%m%d-%H%M%S).tgz" semo-ai
```

그다음 새 릴리스 이미지로 `SEMO_AI_IMAGE`를 바꿉니다.

예시:

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.3-amd64@sha256:NEW_DIGEST
```

재배포 후 아래를 확인합니다.

- 앱 기동
- 대화 생성
- 웹 리서치 실행
- 모니터 페이지
- 기존 설정/결과 문서 유지

## 6. 수동 롤백

문제가 생기면 `SEMO_AI_IMAGE`를 이전 digest로 되돌리고 다시 배포합니다.

예시:

```env
SEMO_AI_IMAGE=ghcr.io/your-org/semo-ai:2026.3.2-amd64@sha256:OLD_DIGEST
```

롤백 후 확인할 것:

- 앱이 정상 기동하는지
- 기존 AppData를 읽는지
- 대화/실행/설정이 기본적으로 유지되는지

필요하면 백업한 AppData도 복원합니다.

```bash
cd /DATA/AppData
mv semo-ai "semo-ai.broken.$(date +%Y%m%d-%H%M%S)"
tar -xzf semo-ai-backup-YYYYMMDD-HHMMSS.tgz
```

## 7. 주의사항

- CasaOS 장비에서 직접 빌드하지 않는 것이 기본입니다.
- ARM 장비는 현재 지원 대상이 아닙니다.
- v1에서는 기존 OpenClaw 기반 데이터 포맷과 경로를 내부적으로 호환 유지합니다.
- 업데이트 전에 AppData 백업을 반드시 수행하는 것을 권장합니다.
