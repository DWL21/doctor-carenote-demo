# 비대면 의료 STT + PDF 파싱 데모 계획

기준일: 2026-08-16

## 1. 목표와 범위

한 화면에서 다음 두 흐름을 시연한다.

1. 마이크 버튼을 눌러 녹음을 시작하고, 다시 눌러 종료하면 한국어 텍스트를 표시한다.
2. PDF/JPG/PNG 검진 파일을 업로드하면 텍스트를 추출하고 문서 유형을 판별한다.
3. STT 또는 문서 원문을 DeepSeek로 분석해 Medical history, 환자 증상, 복약, 알레르기, 검사 수치 등 사전 정의 카테고리로 정리한다.

이 버전은 제품이 아니라 기술 데모다. 로그인, 환자 저장소, 실제 진료기록 연동, 전자의무기록 전송, 결제는 제외한다. 실제 환자정보가 아닌 합성 테스트 데이터만 사용한다.

## 2. 권장 기술 선택

| 영역 | 선택 | 이유 |
|---|---|---|
| 프론트 | React 19 + TypeScript + Vite | 1페이지 상태 관리에 충분하고 Cloudflare Pages 배포가 단순함 |
| 스타일 | CSS Modules 또는 단일 CSS | UI 프레임워크 없이도 데모 범위를 빠르게 완성 가능 |
| API | Hono + TypeScript | Cloudflare Worker에 잘 맞고 업로드 API가 간결함 |
| STT | Workers AI `@cf/openai/whisper-large-v3-turbo` | 녹음 종료 후 한국어를 변환하는 Cloudflare 네이티브 경로 |
| PDF 분류/직접 추출 | `@firecrawl/pdf-inspector-wasm`을 브라우저 Web Worker에서 실행 | 참고 글의 `TextBased / Mixed / Scanned` 라우팅과 `pages_needing_ocr` 활용 가능 |
| 서버 문서 추출 | Workers AI `env.AI.toMarkdown()` | PDF/JPG/PNG를 Markdown으로 변환하는 Cloudflare 네이티브 경로 |
| 의료정보 구조화 | DeepSeek API | 추출 텍스트를 사전 정의한 의료 카테고리 JSON으로 정리 |

### STT 결정

기본은 “마이크 버튼으로 녹음 시작 → 다시 눌러 종료 → 변환 → 입력란에 붙여넣기” 방식이다. 브라우저 `MediaRecorder`가 `audio/webm` 녹음을 만들고 Hono API가 Workers AI Whisper를 호출한다. 말하는 동안 중간 자막을 표시하는 실시간 STT는 범위에서 제외한다.

- 장점: 현재 배포 스택과 가장 잘 맞고 브라우저별 Web Speech API 차이에 의존하지 않는다.
- 무료 사용량: Workers AI는 하루 10,000 Neurons가 무료이고 Whisper는 분당 46.63 Neurons이므로 STT만 사용하면 약 214분/일이다.
- 모델 옵션: `language: "ko"`, `task: "transcribe"`, `vad_filter: true`를 기본으로 한다.
- 의료 용어: `initial_prompt`에 합성된 진료과별 용어 사전을 제한적으로 넣어 정확도를 비교한다.
- 한계: batch 모델이므로 녹음을 종료하고 서버 응답을 받은 뒤 텍스트가 나타난다.

Cloudflare의 실시간 후보 `@cf/deepgram/nova-3`는 WebSocket과 `interim_results`를 지원하지만, 2026-08-16 공식 지원 언어에 한국어가 없다. 따라서 한국어 데모의 기본 모델로 쓰지 않는다. 진짜 실시간 한국어가 필수로 바뀌면 별도 키를 발급해 OpenAI Realtime/Transcription 또는 한국어 지원 전문 STT를 비교 검증한다.

DeepSeek 공식 API는 현재 텍스트 chat/completions 중심이다. DeepSeek 키는 STT 호출에 사용할 수 없다. Whisper 변환 결과의 맞춤법·문장부호 제안과 PDF/STT 결과의 요약·필드 구조화에만 사용한다. 의료 내용이 바뀌는 위험 때문에 DeepSeek 결과로 원문을 자동 덮어쓰지 않고 “정리 제안”으로 별도 표시한다.

## 3. 권장 구조

```text
doctor/
  apps/
    web/                 # React + Vite, Cloudflare Pages
    api/                 # Hono, Cloudflare Worker
  packages/
    contracts/           # API 요청/응답 타입과 검증 스키마
  docs/
  .dev.vars.example      # 값 없는 로컬 시크릿 템플릿
```

```text
마이크 → MediaRecorder → 녹음 종료 → POST /v1/stt
                                   → Hono Worker → Workers AI Whisper
                                   → textarea에 결과 붙여넣기
변환 텍스트 → POST /v1/text/normalize → DeepSeek → 선택적 정리 제안

PDF → pdf-inspector WASM
      ├─ TextBased, 신뢰도 높음 → 브라우저 로컬 Markdown 추출
      └─ Mixed/Scanned          → 필요한 페이지만 OCR 폴백
                                  → 결과 병합 → 선택적 DeepSeek 구조화
JPG/PNG → Worker Markdown Conversion → 텍스트 추출 → DeepSeek 구조화
```

프론트와 API는 각각 Pages와 Worker에 배포한다. API URL은 프론트 빌드 변수 `VITE_API_BASE_URL`로 주입하고, Worker CORS는 로컬 주소와 실제 Pages 도메인만 허용한다.

## 4. PDF 단계별 범위

### 1차 데모

- PDF 크기 최대 10 MB, 최대 30페이지로 제한한다.
- 브라우저에서 `pdf-inspector-wasm`으로 분류와 Markdown 추출을 수행한다.
- `TextBased`는 원본 PDF를 서버로 보내지 않고 로컬 결과를 바로 표시한다.
- `Mixed/Scanned`는 `pages_needing_ocr`와 “OCR 필요” 상태를 표시한다.
- 서버의 `env.AI.toMarkdown()` 경로도 비교용으로 제공하되, 공식 동작상 PDF 텍스트/구조 추출이며 스캔 페이지 OCR을 보장하지 않는다고 UI에 표시한다.

### 2차 OCR 확장

- 브라우저에서 OCR 필요 페이지만 PDF.js로 이미지화한다.
- Hono Worker가 해당 이미지만 OCR/비전 모델 또는 별도 OCR 서비스에 전달한다.
- 페이지 번호를 기준으로 로컬 추출 결과와 OCR 결과를 병합한다.
- 한글 의료 PDF 20개 이상의 합성 평가셋으로 글자 오류율, 표 보존, 읽기 순서를 비교한 후 OCR 공급자를 확정한다.

이렇게 하면 참고 글의 핵심인 “모든 페이지를 유료 OCR로 보내지 않는 라우팅”을 유지하면서, Worker에서 Rust native 모듈을 직접 실행해야 하는 위험도 피할 수 있다. `pdf-inspector`는 브라우저용 WASM 패키지를 공식 제공한다.

## 5. API 초안

| 메서드 | 경로 | 입력 | 출력 |
|---|---|---|---|
| `GET` | `/health` | 없음 | 서비스 상태 |
| `POST` | `/v1/stt` | `multipart/form-data`의 짧은 오디오 | `text`, `durationMs`, `requestId` |
| `POST` | `/v1/text/normalize` | 확정된 텍스트 | 원문을 보존한 정리 제안 |
| `POST` | `/v1/documents/extract` | PDF/JPG/PNG 파일 | `text`, `sourceType`, `tokens` |
| `POST` | `/v1/documents/classify` | 추출 텍스트 | Medical history·증상 등 구조화 JSON |

오류 형식은 `{ code, message, requestId }`로 통일한다. 사용자에게는 원인을 이해할 수 있는 한국어 메시지를 보여 주고 서버 로그에는 원문 음성·문서 내용을 남기지 않는다.

## 6. 시크릿 현황과 규칙

현재 빈 저장소와 현재 프로세스의 환경 변수 이름을 확인한 결과 `DEEPSEEK_API_KEY`는 발견되지 않았다. 사용자가 별도로 보유한 키가 있다면 구현 시 아래 방식으로 주입한다.

- 로컬: `apps/api/.dev.vars`의 `DEEPSEEK_API_KEY` (Git 제외)
- 배포: `wrangler secret put DEEPSEEK_API_KEY`
- 프론트: DeepSeek 키를 절대 두지 않음

Workers AI Whisper와 Markdown Conversion은 `AI` 바인딩을 사용하므로 별도 OpenAI 키가 필요 없다.

## 7. 완료 기준

- Chrome/Safari 최신 버전에서 마이크 권한 허용·거부 상태가 정상 표시된다.
- 5~60초 한국어 발화를 종료하면 변환 결과가 textarea에 자동으로 붙는다.
- 기존 textarea 내용이 있으면 정해진 커서 위치 또는 끝에 한 번만 삽입된다.
- 같은 녹음을 반복 전송하지 못하도록 요청 중 버튼이 잠긴다.
- 텍스트 PDF는 원본 서버 업로드 없이 Markdown 결과를 보여 준다.
- 스캔/혼합 PDF는 OCR 필요 페이지를 명확히 보여 준다.
- 파일 형식·크기·페이지 제한과 네트워크 오류가 한국어로 안내된다.
- 음성/PDF 본문과 DeepSeek 키가 로그, Git, 브라우저 번들에 남지 않는다.

## 8. 구현 순서

1. monorepo와 공유 계약 구성
2. 1페이지 UI와 마이크 녹음 상태 구현
3. Hono `/v1/stt`와 Workers AI 연결
4. 브라우저 PDF 분류/직접 추출 구현
5. Worker Markdown Conversion 비교 경로 구현
6. 선택적 DeepSeek 구조화 기능 연결
7. 단위 테스트, 실제 브라우저 테스트, Pages/Worker 프리뷰 배포
8. 한글 STT 및 PDF 평가 결과를 보고 OCR 2차 범위 결정

## 9. 참고 자료

- [Cloudflare Workers의 Hono + React/Vite 구성](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
- [Cloudflare Whisper large v3 turbo 모델](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
- [Cloudflare Workers AI 가격](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Cloudflare Nova-3 언어와 실시간 지원](https://developers.cloudflare.com/workers-ai/models/nova-3/)
- [Cloudflare Markdown Conversion PDF 동작](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/)
- [Cloudflare Markdown Conversion Worker 바인딩](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/)
- [pdf-inspector 공식 README](https://github.com/firecrawl/pdf-inspector/blob/main/README.md)
- [요청한 pdf-inspector 분석 글](https://wikidocs.net/blog/@hyeong/24079/)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)
- [OpenAI 최신 Transcription API 비교 후보](https://platform.openai.com/docs/api-reference/audio/createTranscription)
