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
   - 파일 파싱 완료 직후에는 S/O를 자동 생성
   - `요약` 버튼은 현재 1–3 상태로 다시 생성하는 수동 재실행 버튼
   - 결과는 `Subjective`, `Objective` 두 항목만 출력
   - 두 결과는 사용자가 직접 편집 가능
   - `Assessment`, `Plan`, 진단, 감별진단, 처방, 권고는 생성하지 않음

## 3. 핵심 코드 위치

### 프론트

- `apps/web/src/App.tsx`
  - 모든 화면 상태와 녹음·파일·문진·요약 흐름
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

## 7. 미국 검사 PDF 샘플과 파이프라인 검증

원본은 `samples/us-medical-pdfs/`에 있으며 모두 공개된 미국 기관·검사사업자의 샘플 또는 설명용 문서다. 실제 환자 문서가 아니다. 로고와 저작권은 각 발행처에 있으므로 내부 테스트 외 용도로 재배포하지 않는다.

| 파일 | 출처 | 페이지 / 크기 | 검증 목적 |
|---|---|---:|---|
| `us-kinetic-cervical-xray-mvc-sample-report.pdf` | [Kinetic Radiology MVC sample](https://kineticradiology.com/wp-content/uploads/2024/08/MVC-Rad-Report.pdf) | 1 / 약 92KB | 교통사고 후 목 통증·두통(S)과 경추 X-ray 측정·소견(O)을 함께 검증 |
| `us-kinetic-lumbar-mri-sample-report.pdf` | [Kinetic Radiology lumbar MRI sample](https://kineticradiology.com/wp-content/uploads/2024/08/Lumbar-Spine-MR-without-contrast-Sample-Report.pdf) | 1 / 약 65KB | 손상 후 허리·좌측 다리 통증(S)과 L3-L4 MRI 소견(O)을 함께 검증 |
| `us-labcorp-chromosome-analysis-sample-report.pdf` | [LabCorp/Integrated Genetics sample](https://womenshealth.labcorp.com/sites/default/files/2021-11/Chrom-Analysis-Blood-rep-710-v1-1012_0.pdf) | 1 / 약 114KB | 암호화된 텍스트 PDF, 유전검사 결과·해석 |
| `us-labcorp-m3-sample-report.pdf` | [HealthIT.gov 게시 LabCorp sample](https://isp.healthit.gov/sites/default/files/webform/uscid_webform/1606/M3-Checklist-Sample-Report-04232017.pdf) | 4 / 약 402KB | 표가 많은 정신건강 선별검사, 환자 응답과 계산 점수 분리 |
| `us-quest-vitamin-d-sample-report.pdf` | [Quest Diagnostics sample](https://www.questdiagnostics.com/content/dam/corporate/restricted/documents/test-directory/vit-d-db066890v-out-of-range.pdf) | 1 / 약 114KB | 단일 정량검사, 단위·참고범위·low flag 보존 |
| `us-roswell-park-pathology-sample.pdf` | [Roswell Park sample pathology report](https://www.roswellpark.org/sites/default/files/sample_pathology_report1.pdf) | 1 / 약 270KB | 결과가 채워지지 않은 병리 템플릿과 placeholder 거부 |

### 업로드 제한

- 한 번에 파일 1개
- PDF/JPG/JPEG/PNG
- 파일당 최대 10MB
- 음성은 별도로 녹음 건당 최대 5MB, 브라우저에서 60초 자동 종료

### 2026-08-17 검증 결과

1. Poppler `pdfinfo` 검사: 6개 모두 정상 PDF, 총 9페이지, JavaScript 없음.
2. 전 페이지 PNG 렌더링 및 육안 검사: 글자 잘림·겹침·깨짐 없음. Kinetic 문서는 환자 식별 필드가 비어 있거나 가려진 공개 샘플임.
3. 로컬 `pdftotext`: 6개 모두 텍스트 추출 성공.
4. 프론트와 동일한 `@firecrawl/pdf-inspector-wasm` 1.14.2:
   - 6개 모두 `TextBased`
   - 페이지 수 1/1/1/4/1/1 정확
   - Kinetic 경추 X-ray / 요추 MRI Markdown 길이 약 2582/1846자
   - OCR 필요 페이지 없음
5. 운영 `/v1/documents/extract`:
   - LabCorp M3와 Quest는 충분한 텍스트 추출
   - 암호화된 LabCorp 염색체 문서와 Roswell 표 템플릿은 서버 Markdown Conversion 결과가 매우 짧음
   - 현재 프론트는 브라우저 WASM을 먼저 사용하므로 실제 사용자 경로에서는 여섯 문서 모두 충분한 텍스트를 얻음. 이 순서를 제거하면 안 됨.
6. 운영 `/v1/soap/summarize`:
   - Kinetic 경추 X-ray: 교통사고 후 목 통증·두통은 S, 경추 측정값·영상 소견은 O
   - Kinetic 요추 MRI: 손상 후 허리·좌측 다리 통증은 S, L3-L4 돌출·협착 측정은 O
   - LabCorp 염색체: S 없음, 핵형·검체·측정 정보는 O
   - LabCorp M3: 환자 자기보고 응답은 S, 계산된 점수·flag는 O
   - Quest Vitamin D: S 없음, `21 ng/mL`, `L`, 참고범위 `30-100 ng/mL`는 O
   - Roswell 병리: 채워지지 않은 템플릿이므로 S/O 모두 `자료에 기록된 내용 없음`, `unresolved`에 빈 템플릿임을 표시해야 함
   - 여섯 응답 모두 `assessment`, `plan` 키가 없어야 함
7. 인앱 브라우저 자동화는 검증 시점에 연결 가능한 브라우저 인스턴스가 없어 실행하지 못함. 프론트 동일 WASM + 운영 API 조합은 통과했으며, 실제 UI 업로드는 아래 수동 항목으로 최종 확인할 것.

검증 과정에서 빈 병리 템플릿의 필드 설명을 실제 O로 오인하는 문제가 발견되어 `apps/api/src/deepseek.ts`에 placeholder/예시 거부 규칙을 추가했다. 향후 샘플을 추가할 때도 `SAMPLE`이라는 단어만으로 전체를 버리지 말고, 실제로 채워진 합성 결과와 설명용 placeholder를 구분해야 한다.

Kinetic 문서 최초 검증에서는 모델이 `INDICATION(S)`의 증상을 S가 아닌 `unresolved`로 보내는 문제가 있었다. `Clinical History`, `Indication(s)`, `Reason for Exam`에 명시된 증상·경과는 직접 인용이 아니어도 S로 분류하되, 검사 요청·의심 진단·일반적 시술명만 있는 경우는 S에서 제외하도록 규칙을 보강했다. Worker 버전 `5db54993-cb21-4b6e-b03b-384a0f08643f`에서 두 Kinetic 샘플 모두 S/O 비어 있지 않고 `unresolved`가 비어 있는 것을 운영 API로 확인했다.

### 재검증 명령

프론트와 동일한 WASM 기반 6개 샘플 회귀검사:

```bash
npm run validate:samples
```

PDF 메타데이터와 렌더링:

```bash
pdfinfo samples/us-medical-pdfs/us-quest-vitamin-d-sample-report.pdf
mkdir -p tmp/pdfs/check
pdftoppm -png -r 120 samples/us-medical-pdfs/us-quest-vitamin-d-sample-report.pdf tmp/pdfs/check/quest
```

운영 서버 fallback 파싱:

```bash
curl -f -X POST https://doctor-api.simplyimg.com/v1/documents/extract \
  -H 'Origin: https://doctor.simplyimg.com' \
  -F 'file=@samples/us-medical-pdfs/us-quest-vitamin-d-sample-report.pdf;type=application/pdf'
```

브라우저에서 여섯 PDF를 각각 `File Upload`에 올리고 다음을 확인한다.

1. 파싱 텍스트가 미리보기보다 먼저 나타남
2. 원본 PDF가 아래 미리보기에 표시됨
3. `Summary > 요약` 결과가 S/O만 포함함
4. 숫자, 단위, reference range, negation, sample/template 상태가 보존됨

## 8. 로컬 실행

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

## 9. 검증

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
5. 대표 샘플 PDF의 S/O 요약
6. 출력에 새로운 진단·권고가 없는지 검토

## 10. 배포

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
Pages 루트 HTML이 이전 배포로 남지 않도록 프록시 fetch에는 `cf.cacheTtl: 0`을 적용한다. 2026-08-17 배포 Worker 버전은 `185bf3e9-3dc9-4519-8315-66668255ec8c`이다.

## 11. 오류와 복원력

- DeepSeek 요청은 429 또는 5xx와 잘못된 JSON에 대해 최대 2회 시도한다.
- STT나 문서 처리 후 백그라운드 분류가 실패해도 사용자가 만든 텍스트는 유지한다.
- 문진의 DeepSeek 질문 생성이 실패해도 환자 답변을 먼저 스택에 저장하고 대체 질문을 표시한다.
- S/O 요약 실패는 사용자에게 오류로 표시하며 입력 데이터는 보존한다.
- `unresolved`는 API 내부 검증 정보로만 유지하고 Summary 화면에는 노출하지 않는다.
- API 오류 응답에는 `requestId`가 포함된다. 운영 원인 분석 시 Worker 로그와 연결한다.

## 12. 의료정보 안전 경계

- 합성 데이터로만 데모한다.
- 현재 실제 환자정보 저장소, 사용자 인증, 감사 로그, 접근통제가 없다.
- 음성·문서는 앱 DB에 영구 저장하지 않지만 Cloudflare Workers AI와 DeepSeek로 전송된다.
- 실제 의료정보를 처리하기 전에 동의, 개인정보 처리, 데이터 위치·보존, 공급자 계약, 암호화, 권한 관리, 감사, 국내 규제 검토가 필요하다.
- 생성 결과는 임상 의사결정이나 응급 분류를 대체하지 않는다.

## 13. 다음 에이전트의 작업 규칙

- UI에는 인프라·모델·요금제 설명을 노출하지 않는다.
- 카드 제목은 영어로 유지한다: `STT`, `File Upload`, `Voice Interview`, `Summary`.
- 문구와 조작은 최대한 짧고 한 화면 흐름을 유지한다.
- 분류 결과 패널을 다시 노출하지 않는다.
- 문진을 고정 문항 수로 바꾸지 않는다.
- S/O 외 임상 판단을 추가하려면 반드시 사용자 승인을 받고 별도 안전 설계를 한다.
- 시크릿 값을 출력하거나 Git에 추가하지 않는다.
