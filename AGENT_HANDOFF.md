# CareNote Demo — Agent Handoff

이 문서는 다음 개발 에이전트가 현재 구현을 재구성하지 않고 바로 수정·검증·배포할 수 있도록 작성한 인수인계 문서다.

## 1. 현재 결과

- 운영 화면: https://doctor.simplyimg.com
- 운영 API: https://doctor-api.simplyimg.com
- Cloudflare Pages 프로젝트: `doctor-simplyimg`
- Cloudflare Worker: `doctor-demo-api`
- 프론트: React 19 + Vite
- 백엔드: Hono + Cloudflare Workers
- STT: Workers AI `@cf/openai/whisper-large-v3-turbo`
- 문서 파싱: 브라우저 PDF WASM + Workers AI Markdown Conversion
- 적응형 문진 및 S/O 요약: DeepSeek JSON output

실제 환자용 제품이 아니라 합성 데이터 기반의 단일 페이지 기술 데모다.

## 2. 사용자 워크플로우

화면은 아래 네 카드가 한 열로 배치된다.

1. `STT`
   - 녹음 시작 → 녹음 종료 → Whisper 변환
   - 녹음 한 건마다 `01`, `02` 순번의 편집 가능한 스택으로 누적
   - 선택적으로 DeepSeek 문장 정리 가능
2. `File Upload`
   - PDF, JPG, JPEG, PNG, 최대 10MB
   - 출력 순서는 파싱 텍스트가 먼저, 파일 미리보기가 다음
3. `Voice Interview`
   - 첫 질문은 환자가 증상과 경과를 자유롭게 말하도록 요청
   - 이후 DeepSeek가 이미 말한 내용을 반복하지 않고 가장 가치가 큰 꼬리 질문 하나만 생성
   - 답변 원문은 시간순 스택으로 누적
   - 고정 질문 수나 강제 체크리스트가 없어야 함
4. `Summary`
   - 1–3 중 하나라도 데이터가 있으면 실행 가능
   - 결과는 `Subjective`, `Objective` 두 항목만 출력
   - 두 결과는 사용자가 직접 편집 가능
   - `Assessment`, `Plan`, 진단, 감별진단, 처방, 권고는 생성하지 않음

## 3. 핵심 코드 위치

### 프론트

- `apps/web/src/App.tsx`
  - 모든 화면 상태와 녹음·파일·문진·요약 흐름
  - `DEMO_CASES`: 흉통, 두통, 복통 합성 데이터
  - `INITIAL_INTERVIEW_QUESTION`: 첫 자유 서술 질문
- `apps/web/src/api.ts`: Worker API 클라이언트
- `apps/web/src/types.ts`: 프론트 응답 타입
- `apps/web/src/styles.css`: 단일 페이지 스타일
- `apps/web/src/pdf.ts`: 브라우저 PDF 검사 래퍼
- `apps/web/src/pdf-inspector.worker.ts`: PDF Web Worker

### 백엔드

- `apps/api/src/index.ts`: Hono 라우트, 검증, CORS, 오류 처리, 프론트 프록시
- `apps/api/src/deepseek.ts`: 의료 분류, 문장 정리, 적응형 문진, S/O 요약 프롬프트
- `apps/api/src/types.ts`: Worker 바인딩과 응답 타입
- `apps/api/src/index.test.ts`: API 단위 테스트
- `apps/api/wrangler.jsonc`: Worker, AI 바인딩, 커스텀 도메인, 모델명

## 4. API 계약

### `POST /v1/stt`

`multipart/form-data`

- `audio`: 오디오 파일, 최대 5MB
- `durationMs`: 녹음 길이

Workers AI Whisper 결과를 한국어 텍스트로 반환한다.

### `POST /v1/documents/extract`

`multipart/form-data`

- `file`: PDF/JPG/PNG, 최대 10MB

Workers AI Markdown Conversion으로 텍스트를 반환한다. PDF는 프론트 WASM 추출이 먼저 성공하면 이 API를 생략할 수 있다.

### `POST /v1/interview/respond`

```json
{
  "messages": [
    { "role": "assistant", "content": "질문" },
    { "role": "user", "content": "환자 답변" }
  ]
}
```

DeepSeek가 SOAP의 S 수집에만 제한된 꼬리 질문 한 개를 반환한다. 시스템 프롬프트는 매 요청마다 전송한다. 모델 오류 시 프론트는 일반적인 개방형 후속 질문으로 대체하며 이미 변환된 환자 답변을 잃지 않는다.

### `POST /v1/soap/summarize`

```json
{
  "voiceMemo": "STT 누적 텍스트",
  "documentText": "PDF/이미지 파싱 텍스트",
  "interviewRecords": ["환자 답변 1", "환자 답변 2"]
}
```

반환 형태:

```json
{
  "soap": {
    "subjective": "환자 보고 정보",
    "objective": "측정·관찰·검사 정보",
    "unresolved": []
  }
}
```

`assessment`와 `plan` 키는 반환하지 않는다. S/O는 입력 스트림의 이름이 아니라 각 문장의 의미와 출처에 따라 분리한다.

### 기타 API

- `GET /health`
- `POST /v1/documents/classify`: DeepSeek 의료 구조화. 현재 프론트에서는 백그라운드로만 호출하며 결과를 노출하지 않는다.
- `POST /v1/text/normalize`: STT 띄어쓰기·문장부호 보정

## 5. 적응형 문진 전략

첫 질문:

> 지금 가장 불편한 증상을 중심으로, 언제 어떻게 시작되어 지금까지 어떻게 변했는지 편하게 말씀해 주세요.

후속 질문 원칙:

- 고정 OPQRST 설문을 순서대로 재생하지 않는다.
- 환자의 실제 답변에서 가장 중요한 모호점 하나만 묻는다.
- 우선순위는 긴급 안전 모호성 → 증상과 경과 → 관련 병력·복약·알레르기다.
- 이미 답한 내용을 다시 묻지 않는다.
- 한 번에 관련 없는 여러 질문을 합치지 않는다.
- 유도 질문, 진단, 처방, 치료 권고를 하지 않는다.
- 충분해도 사용자가 추가 정보를 자유롭게 남길 수 있어야 한다.

관련 설계 근거는 `docs/04-adaptive-soap-strategy.md`에 정리돼 있다.

## 6. 합성 데모 데이터

`Summary` 카드의 세 버튼이 전체 파이프라인 상태를 채운다.

- 흉통: 운동 중 압박감·호흡곤란·식은땀 / 활력징후·심전도 기술
- 두통: 편측 박동성 통증·광과민·메스꺼움 / 활력징후·의식·근력
- 복통: 배꼽 주변에서 우하복부로 이동한 통증·구토 / 활력징후·우하복부 압통

데이터는 모두 가상이며 진단명이 없다. 버튼을 누른 뒤 1–3 카드에 데이터가 들어갔는지 확인하고 `Summary > 요약`을 실행한다. 기대 결과는 환자 보고가 S, 활력징후·진찰·검사가 O에만 나타나는 것이다.

## 7. 로컬 실행

요구 버전: Node.js 22 이상.

```bash
npm install
npm run dev:api
```

다른 터미널:

```bash
npm run dev:web
```

- Web: http://localhost:5173
- Worker: http://localhost:8787
- Vite가 `/api`를 로컬 Worker로 프록시한다.

로컬 시크릿은 Git에서 제외된 `apps/api/.dev.vars`에 둔다.

```dotenv
DEEPSEEK_API_KEY=replace_me
DEEPSEEK_MODEL=deepseek-v4-flash
```

키를 `VITE_` 변수, 프론트 코드, 문서, 로그, 커밋에 넣지 않는다. 현재 로컬 `.dev.vars`와 배포 Worker에는 키가 설정돼 있지만 값은 인수인계 문서에 기록하지 않는다.

## 8. 검증

모든 변경 후 실행:

```bash
npm test
npm run typecheck
npm run build
```

현재 기준:

- API 테스트 6개
- S/O 응답에서 `assessment`, `plan`이 없는지 테스트
- DeepSeek 시스템 안전 지침이 매 요청에 포함되는지 테스트

수동 확인:

1. 모바일/데스크톱에서 마이크 권한 허용
2. 녹음 종료 후 STT 스택 누적
3. PDF/JPG/PNG 텍스트 및 미리보기 순서
4. 문진 답변 저장 후 스피너와 적응형 꼬리 질문
5. 세 예시 각각 S/O 요약
6. 출력에 새로운 진단·권고가 없는지 검토

## 9. 배포

Worker:

```bash
npm run deploy -w @doctor/api
```

DeepSeek 키 최초/교체 등록:

```bash
cd apps/api
wrangler secret put DEEPSEEK_API_KEY
```

Pages:

```bash
npm run build
wrangler pages deploy apps/web/dist --project-name doctor-simplyimg --branch main --commit-dirty=true
```

`doctor.simplyimg.com`은 Worker가 `doctor-simplyimg.pages.dev`를 프록시한다. `doctor-api.simplyimg.com`은 같은 Worker의 API 도메인이다. 이 구성을 바꿀 때 `apps/api/src/index.ts`의 호스트 프록시와 `apps/api/wrangler.jsonc`의 routes/CORS를 함께 수정한다.

## 10. 오류와 복원력

- DeepSeek 요청은 429 또는 5xx와 잘못된 JSON에 대해 최대 2회 시도한다.
- STT나 문서 처리 후 백그라운드 분류가 실패해도 사용자가 만든 텍스트는 유지한다.
- 문진의 DeepSeek 질문 생성이 실패해도 환자 답변을 먼저 스택에 저장하고 대체 질문을 표시한다.
- S/O 요약 실패는 사용자에게 오류로 표시하며 입력 데이터는 보존한다.
- API 오류 응답에는 `requestId`가 포함된다. 운영 원인 분석 시 Worker 로그와 연결한다.

## 11. 의료정보 안전 경계

- 합성 데이터로만 데모한다.
- 현재 실제 환자정보 저장소, 사용자 인증, 감사 로그, 접근통제가 없다.
- 음성·문서는 앱 DB에 영구 저장하지 않지만 Cloudflare Workers AI와 DeepSeek로 전송된다.
- 실제 의료정보를 처리하기 전에 동의, 개인정보 처리, 데이터 위치·보존, 공급자 계약, 암호화, 권한 관리, 감사, 국내 규제 검토가 필요하다.
- 생성 결과는 임상 의사결정이나 응급 분류를 대체하지 않는다.

## 12. 다음 에이전트의 작업 규칙

- UI에는 인프라·모델·요금제 설명을 노출하지 않는다.
- 카드 제목은 영어로 유지한다: `STT`, `File Upload`, `Voice Interview`, `Summary`.
- 문구와 조작은 최대한 짧고 한 화면 흐름을 유지한다.
- 분류 결과 패널을 다시 노출하지 않는다.
- 문진을 고정 문항 수로 바꾸지 않는다.
- S/O 외 임상 판단을 추가하려면 반드시 사용자 승인을 받고 별도 안전 설계를 한다.
- 시크릿 값을 출력하거나 Git에 추가하지 않는다.
