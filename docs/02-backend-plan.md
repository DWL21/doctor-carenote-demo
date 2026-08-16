# Hono 백엔드 계획

## 런타임과 바인딩

- Cloudflare Worker + Hono + TypeScript
- `AI`: Workers AI STT와 Markdown Conversion
- `DEEPSEEK_API_KEY`: 선택적 문서 구조화용 secret
- R2/D1/KV: 1차 데모에서는 사용하지 않음

업로드 파일은 요청 메모리 안에서만 처리하고 영구 저장하지 않는다. Worker 메모리 한도가 128 MB이므로 앱 자체 제한은 오디오 10 MB, PDF 10 MB로 더 작게 둔다.

## 프로젝트 구조

```text
apps/api/src/
  index.ts
  env.ts
  middleware/
    cors.ts
    request-id.ts
    security.ts
  routes/
    health.ts
    stt.ts
    pdf.ts
    documents.ts
  services/
    workers-ai-stt.ts
    markdown-conversion.ts
    deepseek.ts
  schemas/
  errors/
```

## `/v1/stt`

### 처리 순서

1. `multipart/form-data`와 `audio` 필드 확인
2. MIME allowlist와 10 MB 제한 확인
3. 바이트가 비었거나 지나치게 짧지 않은지 확인
4. `env.AI.run("@cf/openai/whisper-large-v3-turbo", ...)` 호출
5. 필요한 필드만 표준 응답으로 변환
6. 바이트 참조를 해제하고 본문을 로그에 남기지 않음

초기 모델 옵션:

```ts
{
  audio,
  task: 'transcribe',
  language: 'ko',
  vad_filter: true,
  condition_on_previous_text: true,
  initial_prompt: '진료 메모입니다. 의학 용어와 약품명을 문맥에 맞게 기록합니다.'
}
```

`initial_prompt`는 고정값으로 시작하고, 실제 정확도 평가 없이 긴 의료용어 목록을 넣지 않는다. 응답은 원본 모델 응답을 그대로 노출하지 않고 다음 형태로 정규화한다.

```json
{
  "text": "환자는 어제부터 ...",
  "segments": [],
  "requestId": "..."
}
```

## `/v1/documents/extract`

이 API는 Cloudflare `env.AI.toMarkdown()`을 이용한 PDF/JPG/PNG 추출 경로다.

1. PDF MIME, magic bytes, 크기 검사
2. `new Blob([buffer], { type: "application/pdf" })` 생성
3. `env.AI.toMarkdown({ name, blob }, { conversionOptions: { pdf: { metadata: false }}})` 호출
4. `format === "error"` 처리
5. `text`, `sourceType`, `tokens`, `requestId` 반환

Cloudflare 공식 설명상 PDF 변환은 `StructTree`가 있으면 의미 구조를 만들고, 없으면 페이지 텍스트를 추출한다. 스캔 PDF OCR을 보장하지 않으므로 빈 결과를 성공으로 간주하지 않고 `OCR_REQUIRED`를 반환한다.

## `/v1/documents/classify`

DeepSeek는 Whisper 변환이 완료된 텍스트와 문서 추출 텍스트를 공통 스키마로 분류한다. `/v1/text/normalize`는 원문과 제안을 함께 반환하고, `/v1/documents/classify`는 STT/PDF/JPG/PNG 원문을 Medical history, 증상, 복약, 알레르기, 언급 진단, 검사 수치, 권고, 주의 신호로 정리한다.

```json
{
  "documentType": "consultation_note | referral | lab_result | unknown",
  "summary": "",
  "symptoms": [],
  "medications": [],
  "warnings": []
}
```

- 공식 Chat Completions API와 `response_format: { "type": "json_object" }` 사용
- 원문에 없는 진단명·약품명·수치의 추가를 금지하는 프롬프트와 결과 비교 검증
- 응답은 `{ original, suggestion, changedSpans, warnings }` 형태로 반환하고 자동 적용하지 않음
- 기본 모델명은 환경 변수 `DEEPSEEK_MODEL`로 분리
- 현재 공식 문서 기준 모델명이 변경될 수 있으므로 코드에 과거의 `deepseek-chat`를 고정하지 않음
- 입력 길이 제한, 20초 타임아웃, JSON 스키마 재검증
- DeepSeek가 만든 내용은 의료적 확정이 아니라 데모용 구조화 결과라고 UI에 표시

현재 워크스페이스/프로세스에는 `DEEPSEEK_API_KEY`가 확인되지 않았으므로 키가 없을 때 이 API는 `501 FEATURE_NOT_CONFIGURED`를 반환하고 나머지 데모는 정상 동작하게 한다.

## 보안과 개인정보

- CORS allowlist: 로컬 프론트 URL과 배포 Pages URL만 허용
- 파일명은 로그에 남기기 전에 제거 또는 임의 ID로 대체
- 요청 본문, transcript, Markdown, DeepSeek payload는 로그 금지
- 보안 헤더와 요청 ID 추가
- 엔드포인트별 크기 제한과 기본 rate limit 적용
- 운영 전 Cloudflare/외부 AI의 데이터 처리 계약과 의료정보 규제 적합성을 별도 검토
- 실제 환자정보 입력 금지 배너와 서버 응답 헤더 추가

“외부 AI로 보내지 않는다”는 표현은 쓰지 않는다. Workers AI와 선택적 DeepSeek 모두 외부 처리자이므로 데모의 데이터 흐름을 정확히 고지한다.

## 오류 코드

- `INVALID_CONTENT_TYPE`
- `FILE_TOO_LARGE`
- `AUDIO_TOO_SHORT`
- `UNSUPPORTED_AUDIO`
- `INVALID_PDF`
- `ENCRYPTED_PDF`
- `OCR_REQUIRED`
- `RATE_LIMITED`
- `UPSTREAM_TIMEOUT`
- `FEATURE_NOT_CONFIGURED`
- `INTERNAL_ERROR`

## 테스트 계획

- Hono `app.request()`를 이용한 route 단위 테스트
- AI/DeepSeek 클라이언트는 인터페이스로 분리해 fixture 응답 주입
- 잘못된 MIME, magic bytes, 크기 제한, 타임아웃, 429/5xx 테스트
- 로그 캡처 후 원문과 secret 미포함 검증
- `wrangler dev`에서 실제 Workers AI smoke test
- 한국어 음성 fixture 10개로 정확도 기록: 일반 문장/의학 용어/숫자/약품명/소음

## 백엔드 완료 산출물

- 로컬과 Worker에서 동일하게 실행되는 `apps/api`
- OpenAPI 또는 API 계약 문서
- 값 없는 `.dev.vars.example`
- mock 단위 테스트와 opt-in 실제 AI smoke test
- 시크릿/환자정보를 남기지 않는 구조화 로그
