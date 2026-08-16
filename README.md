# CareNote demo

녹음이 끝난 음성을 한국어 텍스트로 변환하고, PDF/JPG/PNG 검진 문서에서 텍스트를 추출한 뒤 DeepSeek로 Medical history와 환자 증상을 카테고리화하는 1페이지 기술 데모입니다.

## 구성

- `apps/web`: React 19 + Vite, Cloudflare Pages 배포 대상
- `apps/api`: Hono + Cloudflare Worker
- STT: Workers AI `@cf/openai/whisper-large-v3-turbo`
- PDF 직접 추출/분류: 브라우저 `@firecrawl/pdf-inspector-wasm`
- PDF/JPG/PNG 서버 추출: Workers AI Markdown Conversion
- 의료 카테고리 분류: DeepSeek JSON output

## 로컬 실행

Node.js 22 이상이 필요합니다.

```bash
npm install
npm run dev:api
```

다른 터미널에서:

```bash
npm run dev:web
```

브라우저에서 `http://localhost:5173`을 엽니다. Vite가 `/api` 요청을 `http://localhost:8787`의 Hono Worker로 프록시합니다.

## 시크릿

로컬 DeepSeek 키는 Git에서 제외된 `apps/api/.dev.vars`에 둡니다. 배포 환경에서는 파일을 올리지 말고 다음 명령으로 등록합니다.

```bash
cd apps/api
wrangler secret put DEEPSEEK_API_KEY
```

키는 프론트 환경 변수나 `VITE_` 변수에 넣으면 안 됩니다.

## 검증

```bash
npm run typecheck
npm test
npm run build
```

## 배포

API Worker:

```bash
npm run deploy -w @doctor/api
```

Web은 Cloudflare Pages에서 루트 디렉터리를 `apps/web`, 빌드 명령을 `npm run build`, 출력 디렉터리를 `dist`로 설정합니다. `VITE_API_BASE_URL`에는 배포된 Worker 주소 또는 보유 도메인의 API 서브도메인을 지정합니다.

Worker의 `ALLOWED_ORIGINS`에는 실제 Pages/커스텀 도메인을 쉼표로 구분해 등록합니다.

## 의료정보 주의

현재 버전은 합성 데이터용 기술 데모입니다. 음성·파일을 애플리케이션 저장소에 영구 저장하지 않지만 Cloudflare Workers AI와 DeepSeek에서 처리됩니다. 실제 환자정보를 사용하기 전에 데이터 처리 계약, 보관 정책, 접근통제 및 관련 의료정보 규제를 별도로 검토해야 합니다.
