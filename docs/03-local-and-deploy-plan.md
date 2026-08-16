# 로컬 개발 및 Cloudflare 배포 계획

## 로컬 실행 목표

프론트와 Worker를 별도 프로세스로 실행한다.

- Web: `http://localhost:5173`
- API: `http://localhost:8787`
- Web의 `VITE_API_BASE_URL=http://localhost:8787`

Workers AI는 Wrangler 로컬 개발에서도 실제 추론 사용량과 제한에 포함된다. 반복 UI 개발은 mock 모드를 기본으로 하고, 명시적인 smoke test에서만 실제 AI 바인딩을 호출한다.

## 환경 파일

```text
apps/web/.env.local
  VITE_API_BASE_URL=http://localhost:8787

apps/api/.dev.vars
  DEEPSEEK_API_KEY=사용자가_별도로_보유한_경우만
  DEEPSEEK_MODEL=현재_공식_모델명
  ALLOWED_ORIGINS=http://localhost:5173
```

`.dev.vars`, `.env.local`은 Git에서 제외하고 `.example` 파일에는 변수명만 둔다. 현재 환경에서는 `DEEPSEEK_API_KEY`가 탐지되지 않았으므로 첫 구현은 DeepSeek 없이도 전체 STT/PDF 기본 흐름이 동작하도록 한다.

## 개발 단계

1. Node LTS와 패키지 매니저 버전 고정
2. workspace 구성 후 web/api/contracts 설치
3. Hono mock API와 React 페이지 연결
4. Wrangler `AI` 바인딩 설정
5. 실제 STT smoke test
6. PDF WASM fixture 테스트
7. DeepSeek 키가 준비된 경우에만 구조화 smoke test
8. Playwright E2E와 빌드 검사

## Cloudflare 구성

### 무료 플랜 기준

- Pages 정적 자산 요청은 무료이며 데모 프론트에 적합하다.
- Worker는 100,000 요청/일, 요청당 CPU 10ms 한도다.
- Workers AI는 10,000 Neurons/일 무료다.
- Whisper large v3 turbo는 분당 46.63 Neurons이므로 이론상 약 214분/일이다.
- 무료 할당량을 넘으면 과금 대신 추가 AI 요청이 실패하므로 UI에서 다음 초기화 시각을 안내한다.
- PDF `toMarkdown`은 대부분의 형식 변환이 무료지만 이미지/OCR 경로는 AI 사용량을 소비할 수 있다.

### Pages

- 대상: `apps/web`
- 빌드: Vite production build
- 산출물: `dist`
- Preview/Production 각각 API URL 설정
- SPA fallback과 정적 캐시 설정

### Worker

- 대상: `apps/api`
- Hono entrypoint와 compatibility date 고정
- `AI` binding 추가
- `DEEPSEEK_API_KEY`는 `wrangler secret put`으로만 등록
- `ALLOWED_ORIGINS`는 환경별 Worker var로 등록
- custom domain 또는 `workers.dev` URL을 Pages 환경 변수에 연결

프론트 정적 파일과 API를 한 Worker에 합칠 수도 있지만, 사용자가 요청한 Pages + Worker 구성을 명확히 보여 주기 위해 첫 버전은 분리 배포한다.

## 배포 게이트

- typecheck, lint, unit test, production build 통과
- mock E2E 통과
- Preview에서 실제 마이크 권한/HTTPS 녹음 확인
- STT 1건, text PDF 1건, scanned PDF 1건 smoke test
- CORS가 Preview/Production 도메인 외 요청을 거부하는지 확인
- 소스맵과 로그에 secret/문서 본문이 없는지 확인

## 운영 안전장치

- 오디오 최대 60초, 업로드 최대 10 MB
- PDF 최대 10 MB/30페이지
- IP 또는 세션 기준의 완만한 rate limit
- Worker CPU/요청/Workers AI 사용량 알림
- DeepSeek 기능은 키 미설정 시 자동 비활성화
- 저장소를 추가하기 전까지 원본과 결과는 요청 종료 후 폐기

Cloudflare Worker의 플랫폼 최대 요청 본문은 계정 플랜에 따라 더 크지만, 128 MB 메모리와 데모 비용을 고려해 앱 제한을 10 MB로 둔다.

## 배포 후 확인 시나리오

1. 모바일에서 마이크 허용 후 10초 한국어 문장을 녹음한다.
2. 녹음을 종료한 뒤 로딩 표시와 textarea에 붙은 결과를 확인한다.
3. 마이크 권한을 거부하고 복구 안내를 확인한다.
4. 텍스트 PDF를 올려 로컬 Markdown과 유형을 확인한다.
5. 스캔 PDF를 올려 `pages_needing_ocr` 안내를 확인한다.
6. DeepSeek 키 유무에 따라 구조화 버튼의 활성/비활성을 확인한다.
7. Worker 로그에 음성/PDF 본문이 기록되지 않았는지 확인한다.

## 다음 구현 착수 시 결정할 항목

- 패키지 매니저: pnpm 권장
- UI 톤: 의료 서비스형 또는 개발자 데모형
- DeepSeek 키 실제 주입 여부
- 1차 데모에서 스캔 PDF OCR까지 포함할지 여부
- 합성 한글 의료 음성/PDF fixture 제공 방식
