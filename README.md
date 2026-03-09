# Semo AI

이 저장소는 `Semo AI`를 CasaOS에 설치하고 운영하기 위한 배포 자산을 포함합니다.

현재 기준:

- 설치 대상: `CasaOS`
- 장비 아키텍처: `x86`
- 설치 방식: `Custom Install`
- 실행 방식: Docker 앱

중요한 점:

- CasaOS 장비에서 소스를 직접 빌드하지 않습니다.
- 미리 빌드된 `linux/amd64` 이미지를 pull 해서 실행합니다.
- 설정, OAuth 인증 정보, 실행 이력은 모두 `/DATA/AppData/semo-ai` 아래에 저장됩니다.

## 1. 먼저 이해하면 좋은 것

설치 담당자가 가장 먼저 알아야 하는 건 아래 3가지입니다.

- GitHub 저장소: 소스코드가 들어 있는 곳
- GitHub Actions: 설치용 이미지를 자동으로 만드는 곳
- GHCR: 만들어진 Docker 이미지를 보관하는 곳

쉽게 비유하면:

- GitHub 저장소 = 설계도 보관함
- GitHub Actions = 자동 제작기
- GHCR = 완성된 앱 박스 창고

즉 CasaOS는 소스코드를 직접 실행하는 게 아니라, `GHCR에 올라간 완성된 앱 이미지`를 내려받아 실행합니다.

## 2. GHCR가 무엇인가

`GHCR`은 `GitHub Container Registry`의 줄임말입니다.

쉽게 말하면:

- GitHub 안에 있는 Docker 이미지 저장소
- CasaOS가 실제로 설치할 앱 파일 대신, 실행 가능한 앱 이미지를 보관하는 장소

예시 이미지 값:

```env
SEMO_AI_IMAGE=ghcr.io/wekeepgrowing/semo-ai-app:semo-ai-2026.3.2-amd64
```

이 값의 의미:

- `ghcr.io` = GitHub 이미지 저장소
- `wekeepgrowing/semo-ai-app` = 저장소 이름
- `semo-ai-2026.3.2-amd64` = 설치할 버전 이름

## 3. 왜 파일로 안 주고 Actions로 올리나

CasaOS는 보통 압축파일을 직접 받아 설치하는 방식보다, Docker 이미지 주소를 받아 설치하는 방식이 더 자연스럽습니다.

그래서 흐름은 이렇게 됩니다.

1. 코드를 GitHub에 푸시한다
2. GitHub Actions가 자동으로 Docker 이미지를 만든다
3. 만들어진 이미지를 GHCR에 올린다
4. CasaOS가 그 이미지를 pull 해서 실행한다

이 방식의 장점:

- 설치 담당자가 소스를 빌드할 필요가 없음
- 업데이트가 쉬움
- 문제가 생기면 이전 태그로 롤백하기 쉬움
- 큰 파일을 따로 전달하지 않아도 됨

## 4. 설치 전에 준비할 것

설치 담당자는 아래 값 하나만 있으면 됩니다.

- `SEMO_AI_IMAGE`

예시:

```env
SEMO_AI_IMAGE=ghcr.io/wekeepgrowing/semo-ai-app:semo-ai-2026.3.2-amd64
```

즉 아래 3가지를 받아야 합니다.

- Docker 이미지 주소
- 정확한 태그

## 5. 설치 전에 어디서 확인하나

아래 2가지를 확인하면 설치 준비가 끝난 상태입니다.

- GitHub Actions에서 `Publish CasaOS Image` 워크플로가 성공했는지
- GitHub Packages 또는 GHCR에서 이미지 태그가 올라갔는지

확인 링크:

- Actions: [https://github.com/wekeepgrowing/semo-ai-app/actions](https://github.com/wekeepgrowing/semo-ai-app/actions)
- Packages: [https://github.com/wekeepgrowing/semo-ai-app/pkgs/container/semo-ai-app](https://github.com/wekeepgrowing/semo-ai-app/pkgs/container/semo-ai-app)

## 6. CasaOS에서 무엇을 넣어야 하나

CasaOS의 `Custom Install` 화면에 아래 파일 내용을 넣으면 됩니다.

- compose: [deploy/casaos/docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml)
- 환경변수 예시: [deploy/casaos/.env.example](/Users/hj/workspace/semo-ai-app/deploy/casaos/.env.example)
- 상세 설치 문서: [deploy/casaos/README.md](/Users/hj/workspace/semo-ai-app/deploy/casaos/README.md)

## 7. 가장 쉬운 설치 순서

1. CasaOS에서 `Custom Install`을 엽니다.
2. [deploy/casaos/docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml) 내용을 그대로 붙여넣습니다.
3. `SEMO_AI_IMAGE`를 실제 릴리스 이미지 값으로 넣습니다.
4. 설치를 실행합니다.

기본 compose 핵심 구조:

```yaml
version: "3.8"

services:
  semo-ai:
    image: ${SEMO_AI_IMAGE:-ghcr.io/wekeepgrowing/semo-ai-app:semo-ai-2026.3.2-amd64}
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

## 8. 설치 후 어디로 접속하나

브라우저에서 아래 주소로 접속하면 됩니다.

```text
http://<CasaOS IP>:18789
```

예시:

```text
http://192.168.0.10:18789
```

이미지가 private로 올라가 있는 경우에는 CasaOS 서버에서 먼저 GHCR 로그인이 필요할 수 있습니다.

```bash
docker login ghcr.io
```

이때 `read:packages` 권한이 있는 GitHub 토큰을 사용하면 됩니다.

## 9. 처음 설치 후 꼭 확인할 것

처음 열었을 때 아래가 보여야 정상입니다.

1. 온보딩 화면이 열린다
2. OpenAI OAuth 또는 API Key 설정이 가능하다
3. 홈 화면으로 진입된다
4. 대화 페이지가 열린다
5. 실행 페이지가 열린다
6. 스킬 페이지가 열린다
7. 모니터 페이지가 열린다

## 10. 이 버전에서 중요한 반영 사항

- OpenAI OAuth가 브라우저 인증 후 다음 단계로 넘어가지 않던 문제 수정
- 리디렉트 URL 입력 후 멈추지 않도록 서버에서 직접 OAuth 완료 처리
- 임시 파일 경로를 `/data/.tmp`로 고정
- 잘못된 onboarding config 때문에 gateway가 죽던 문제 자동 정리
- `/data/.openclaw/openclaw.json`에 `gateway.mode`가 누락돼도 `local`로 자동 보정
- 이 보정으로 첫 채팅 시 `gateway closed (1006)`로 끊기던 케이스를 예방
- `OUR_OS_METRICS_BASE_URL`가 없어도 모니터가 로컬 fallback 메트릭으로 동작

## 11. 왜 `/DATA/AppData/semo-ai`를 쓰나

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

## 12. 자주 헷갈리는 부분

`Q. CasaOS 장비에서 직접 빌드해야 하나요?`

- 아닙니다. 이미 만들어진 Docker 이미지를 pull 해서 실행하는 것이 기준입니다.

`Q. GHCR이 꼭 필요한가요?`

- 네. CasaOS가 실제로 설치할 대상은 GHCR에 올라간 Docker 이미지입니다.
- 코드 저장소 주소만으로는 설치할 수 없습니다.

`Q. 왜 GitHub Actions가 필요한가요?`

- 설치용 이미지를 자동으로 만들고 GHCR에 올리는 역할을 합니다.
- 담당자가 이미지를 직접 빌드하지 않아도 되게 하기 위한 과정입니다.

`Q. ARM 장비도 되나요?`

- 현재 이 가이드는 `x86` 기준입니다.

`Q. 왜 OUR_OS_METRICS_BASE_URL는 비워 두나요?`

- CasaOS에는 Our OS 전용 메트릭 API가 없을 수 있어서 기본은 비워 둡니다.
- 비워 두면 서버가 로컬 컨테이너 기준 CPU, 메모리, 디스크, 네트워크 값을 반환합니다.

`Q. 왜 /tmp 대신 /data/.tmp를 쓰나요?`

- 온보딩과 OAuth 과정에서 임시 파일이 필요합니다.
- 컨테이너 루트의 `/tmp`는 공간 이슈가 날 수 있어서 AppData 아래 임시 경로를 사용합니다.

## 13. 업데이트 방법

업데이트는 `이미지 주소만 새 버전으로 바꾼 뒤 다시 배포`하면 됩니다.

먼저 백업:

```bash
cd /DATA/AppData
tar -czf "semo-ai-backup-$(date +%Y%m%d-%H%M%S).tgz" semo-ai
```

그다음 `SEMO_AI_IMAGE`를 새 값으로 바꿉니다.

```env
SEMO_AI_IMAGE=ghcr.io/wekeepgrowing/semo-ai-app:semo-ai-2026.3.3-amd64
```

업데이트 후에는 아래를 확인하면 됩니다.

1. 앱이 켜지는지
2. 기존 설정이 유지되는지
3. 대화가 되는지
4. 웹 리서치가 되는지
5. 모니터가 보이는지

## 14. 롤백 방법

문제가 생기면 이전 이미지 digest로 되돌리면 됩니다.

```env
SEMO_AI_IMAGE=ghcr.io/wekeepgrowing/semo-ai-app:semo-ai-2026.3.2-amd64
```

필요하면 AppData도 복원합니다.

```bash
cd /DATA/AppData
mv semo-ai "semo-ai.broken.$(date +%Y%m%d-%H%M%S)"
tar -xzf semo-ai-backup-YYYYMMDD-HHMMSS.tgz
```

## 15. 설치 담당자에게 전달하면 되는 문장

아래처럼 전달하면 됩니다.

`CasaOS에서는 deploy/casaos/docker-compose.yml 내용을 Custom Install에 넣고, SEMO_AI_IMAGE를 ghcr.io/wekeepgrowing/semo-ai-app:semo-ai-2026.3.2-amd64 로 설정해서 설치해 주세요. 설치 후에는 http://<장비IP>:18789 로 접속하면 됩니다.`

## 16. 개발자가 참고할 파일

- CasaOS 배포 compose: [deploy/casaos/docker-compose.yml](/Users/hj/workspace/semo-ai-app/deploy/casaos/docker-compose.yml)
- CasaOS 배포 상세 문서: [deploy/casaos/README.md](/Users/hj/workspace/semo-ai-app/deploy/casaos/README.md)
- Our OS 패키지 자산: [ouros/openclaw](/Users/hj/workspace/semo-ai-app/ouros/openclaw)
