# 프론트엔드 계획

## 선택

- React 19, TypeScript, Vite
- API 상태: TanStack Query 없이 작은 커스텀 훅으로 관리
- 폼 검증: 공유 계약이 필요해질 때 Zod 사용
- PDF: `@firecrawl/pdf-inspector-wasm`, 무거운 작업은 Web Worker로 격리
- 테스트: Vitest + React Testing Library + Playwright

한 페이지 데모에는 Next.js나 전역 상태 라이브러리가 필요하지 않다.

## 화면 구성

```text
┌────────────────────────────────────────────┐
│ 비대면 진료 기록 보조 데모                 │
│ 실제 환자정보를 입력하지 마세요            │
├────────────────────────────────────────────┤
│ 음성 메모                                  │
│ [ 마이크 ]  00:12  녹음 중                 │
│ 변환된 텍스트 textarea                     │
│ [복사] [지우기]                            │
├────────────────────────────────────────────┤
│ PDF/JPG/PNG 검진 문서                      │
│ [끌어놓기 / 파일 선택]                     │
│ 유형 · 신뢰도 · OCR 필요 페이지            │
│ Markdown 미리보기 / 원문 보기              │
└────────────────────────────────────────────┘
```

두 기능은 같은 페이지에 있지만 상태와 오류는 독립적으로 관리한다.

## STT 상태 모델

`idle → requesting-permission → recording → uploading → transcribing → success/error`

- 첫 클릭: `navigator.mediaDevices.getUserMedia({ audio: true })`
- 권장 녹음 설정: `MediaRecorder`, 브라우저가 지원하는 MIME을 런타임 선택
- 두 번째 클릭 또는 60초 도달: 녹음 종료 후 Blob 생성
- `FormData`로 `/v1/stt` 전송
- 성공: 현재 커서 위치 또는 textarea 끝에 결과를 한 번만 붙이고 사용자가 직접 수정 가능
- 종료/오류/컴포넌트 해제: 모든 `MediaStreamTrack.stop()` 호출

DeepSeek는 STT 요청의 필수 경로에 넣지 않는다. Whisper 결과가 붙은 뒤 사용자가 “문장 정리”를 누르면 `/v1/text/normalize`를 호출하고, 원문 아래에 적용/무시할 수 있는 제안으로 표시한다.

접근성을 위해 버튼에 텍스트 라벨, `aria-pressed`, 현재 상태의 `aria-live` 안내를 제공한다. 녹음 중에는 색상만이 아니라 아이콘, 문구, 타이머를 함께 바꾼다.

## 문서 상태 모델

`idle → validating → classifying → extracted | needs-ocr → structuring → success/error`

1. 확장자만 믿지 않고 MIME과 크기를 검사한다. PDF는 magic bytes도 확인한다.
2. PDF 바이트를 Web Worker로 보낸다.
3. `pdf-inspector-wasm` 초기화 후 `processPdf`를 실행한다.
4. `pdfType`, `confidence`, `pageCount`, `pagesNeedingOcr`, `markdown`을 UI에 표시한다.
5. 텍스트 PDF는 로컬 Markdown을 즉시 표시한다.
6. 혼합/스캔 PDF는 OCR 필요 페이지와 현재 지원 범위를 표시한다.
7. 추출이 끝나면 텍스트를 DeepSeek 의료 카테고리 분류 API로 보낸다.
8. JPG/PNG는 Worker Markdown Conversion으로 텍스트를 추출한 뒤 같은 분류 경로를 사용한다.

WASM은 최초 PDF 업로드 시 lazy import한다. 메인 스레드가 멈추지 않도록 반드시 Web Worker에서 실행하고, 처리 중 취소 버튼을 제공한다.

## 주요 컴포넌트

```text
App
├─ PrivacyBanner
├─ SttCard
│  ├─ MicrophoneButton
│  ├─ RecordingTimer
│  └─ TranscriptEditor
└─ PdfCard
   ├─ PdfDropzone
   ├─ PdfInspectionSummary
   └─ MarkdownResult
```

훅/서비스는 `useAudioRecorder`, `useTranscription`, `usePdfInspector`, `apiClient` 정도로 제한한다.

## 예외 처리

- 마이크 API 미지원
- 권한 거부 또는 장치 없음
- 빈 녹음, 너무 짧은 녹음, 60초 초과
- 지원하지 않는 오디오 MIME
- PDF가 아니거나 암호화됨
- 10 MB 또는 30페이지 초과
- WASM 초기화 실패
- STT/PDF API 타임아웃 및 429/5xx

사용자 메시지에는 복구 행동을 포함한다. 예: “마이크 권한이 꺼져 있습니다. 브라우저 주소창의 권한 설정에서 마이크를 허용해 주세요.”

## 테스트 계획

- 훅 단위 테스트: 권한 거부, 녹음 시작/종료, 타이머 제한, 요청 취소
- 컴포넌트 테스트: 상태별 버튼/안내, 결과 수정·복사·삭제
- PDF worker 테스트: text/scanned/mixed fixture 각각의 라우팅
- E2E: 가짜 MediaStream과 고정 오디오 fixture로 결과 표시까지 검증
- E2E: 변환 결과가 한 번만 붙는지, 기존 내용과 커서 위치가 보존되는지 검증
- 모바일 뷰포트, 키보드 탐색, 스크린리더 레이블 확인

## 프론트 완료 산출물

- Pages에서 빌드 가능한 `apps/web`
- 단일 반응형 페이지
- 실제 API와 교체 가능한 mock 모드
- 민감정보가 없는 테스트 fixture
- 오류/빈 상태/로딩 상태가 포함된 E2E 테스트
