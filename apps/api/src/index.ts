import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { classifyMedicalText, continueSubjectiveInterview, normalizeTranscript, summarizeSoap } from "./deepseek";
import type { Env, InterviewMessage, SourceType } from "./types";

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
const AUDIO_LIMIT = 5 * 1024 * 1024;
const DOCUMENT_LIMIT = 10 * 1024 * 1024;
const TEXT_LIMIT = 50_000;

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === "doctor.simplyimg.com") {
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return c.redirect(url.toString(), 308);
    }
    url.hostname = "doctor-simplyimg.pages.dev";
    url.protocol = "https:";
    return fetch(url.toString(), {
      method: c.req.method === "HEAD" ? "HEAD" : "GET",
      redirect: "follow",
    });
  }
  await next();
});
app.use("*", secureHeaders());
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-Id", requestId);
});
app.use("/v1/*", async (c, next) => {
  const origins = (c.env.ALLOWED_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((value) => value.trim());
  return cors({
    origin: (origin) => (origins.includes(origin) ? origin : origins[0] || ""),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  })(c, next);
});

function error(c: Parameters<typeof app.onError>[0] extends never ? never : any, status: number, code: string, message: string) {
  return c.json({ code, message, requestId: c.get("requestId") }, status);
}

function isFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    services: {
      workersAi: Boolean(c.env.AI),
      deepseek: Boolean(c.env.DEEPSEEK_API_KEY),
    },
  }),
);

app.post("/v1/stt", async (c) => {
  const body = await c.req.parseBody();
  const audio = body.audio;
  if (!isFile(audio)) return error(c, 400, "AUDIO_REQUIRED", "녹음 파일이 필요합니다.");
  if (!audio.type.startsWith("audio/")) return error(c, 415, "UNSUPPORTED_AUDIO", "지원하지 않는 오디오 형식입니다.");
  if (audio.size === 0) return error(c, 400, "AUDIO_EMPTY", "녹음 내용이 비어 있습니다.");
  if (audio.size > AUDIO_LIMIT) return error(c, 413, "FILE_TOO_LARGE", "녹음은 최대 5MB까지 가능합니다.");

  const durationMs = Number(body.durationMs || 0);
  const base64 = Buffer.from(await audio.arrayBuffer()).toString("base64");
  const result = (await c.env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: base64,
    task: "transcribe",
    language: "ko",
    vad_filter: true,
    condition_on_previous_text: true,
    initial_prompt: "한국어 진료 메모입니다. 증상, 병력, 약품명, 검사 수치와 단위를 정확히 기록합니다.",
  })) as { text?: string; transcription_info?: { text?: string }; segments?: unknown[] };
  const text = result.text || result.transcription_info?.text || "";
  if (!text.trim()) return error(c, 422, "NO_SPEECH", "음성을 인식하지 못했습니다. 다시 녹음해 주세요.");

  return c.json({ text: text.trim(), durationMs, segments: result.segments || [], requestId: c.get("requestId") });
});

app.post("/v1/documents/extract", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!isFile(file)) return error(c, 400, "FILE_REQUIRED", "PDF, JPG 또는 PNG 파일이 필요합니다.");
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png"]);
  if (!allowed.has(file.type)) return error(c, 415, "UNSUPPORTED_DOCUMENT", "PDF, JPG, PNG만 지원합니다.");
  if (file.size === 0) return error(c, 400, "FILE_EMPTY", "파일이 비어 있습니다.");
  if (file.size > DOCUMENT_LIMIT) return error(c, 413, "FILE_TOO_LARGE", "문서는 최대 10MB까지 가능합니다.");

  const sourceType: SourceType = file.type === "application/pdf" ? "pdf" : "image";
  const result = await c.env.AI.toMarkdown(
    { name: file.name || `upload.${sourceType === "pdf" ? "pdf" : "png"}`, blob: new Blob([await file.arrayBuffer()], { type: file.type }) },
    { conversionOptions: { pdf: { metadata: false }, output: { format: "markdown" } } },
  );
  const item = Array.isArray(result) ? result[0] : result;
  const parsed = item as { format?: string; data?: string; tokens?: number; error?: string } | undefined;
  if (!parsed || parsed.format === "error") {
    return error(c, 422, "EXTRACTION_FAILED", parsed?.error || "문서에서 텍스트를 추출하지 못했습니다.");
  }
  const text = (parsed.data || "").trim();
  if (!text) return error(c, 422, "OCR_REQUIRED", "텍스트가 없습니다. 스캔 문서는 별도 OCR 검증이 필요합니다.");

  return c.json({ text, sourceType, tokens: parsed.tokens || 0, requestId: c.get("requestId") });
});

app.post("/v1/documents/classify", async (c) => {
  const body = await c.req.json<{ text?: string; sourceType?: SourceType }>();
  const text = body.text?.trim() || "";
  if (!text) return error(c, 400, "TEXT_REQUIRED", "분류할 텍스트가 필요합니다.");
  if (text.length > TEXT_LIMIT) return error(c, 413, "TEXT_TOO_LONG", "텍스트는 최대 50,000자까지 가능합니다.");
  const sourceType = body.sourceType || "text";
  const analysis = await classifyMedicalText(c.env, text, sourceType);
  return c.json({ analysis, sourceType, requestId: c.get("requestId") });
});

app.post("/v1/text/normalize", async (c) => {
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim() || "";
  if (!text) return error(c, 400, "TEXT_REQUIRED", "정리할 텍스트가 필요합니다.");
  if (text.length > TEXT_LIMIT) return error(c, 413, "TEXT_TOO_LONG", "텍스트는 최대 50,000자까지 가능합니다.");
  return c.json({ ...(await normalizeTranscript(c.env, text)), requestId: c.get("requestId") });
});

app.post("/v1/interview/respond", async (c) => {
  const body = await c.req.json<{ messages?: InterviewMessage[] }>();
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return error(c, 400, "MESSAGES_REQUIRED", "문진 대화가 필요합니다.");
  }
  if (messages.length > 30) return error(c, 413, "INTERVIEW_TOO_LONG", "문진 대화는 최대 30개 메시지까지 가능합니다.");

  let totalLength = 0;
  for (const message of messages) {
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      return error(c, 400, "INVALID_MESSAGE", "올바르지 않은 문진 메시지입니다.");
    }
    totalLength += message.content.length;
  }
  if (totalLength > 30_000) return error(c, 413, "INTERVIEW_TOO_LONG", "문진 내용이 너무 깁니다.");

  const turn = await continueSubjectiveInterview(c.env, messages);
  return c.json({ ...turn, requestId: c.get("requestId") });
});

app.post("/v1/soap/summarize", async (c) => {
  const body = await c.req.json<{ voiceMemo?: string; documentText?: string; interviewRecords?: string[] }>();
  const voiceMemo = typeof body.voiceMemo === "string" ? body.voiceMemo.trim() : "";
  const documentText = typeof body.documentText === "string" ? body.documentText.trim() : "";
  const interviewRecords = Array.isArray(body.interviewRecords)
    ? body.interviewRecords.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
  if (!voiceMemo && !documentText && interviewRecords.length === 0) {
    return error(c, 400, "SOAP_SOURCE_REQUIRED", "정리할 기록이 필요합니다.");
  }
  const totalLength = voiceMemo.length + documentText.length + interviewRecords.reduce((sum, item) => sum + item.length, 0);
  if (totalLength > 80_000) return error(c, 413, "SOAP_SOURCE_TOO_LONG", "정리할 기록이 너무 깁니다.");
  const soap = await summarizeSoap(c.env, { voiceMemo, documentText, interviewRecords });
  return c.json({ soap, requestId: c.get("requestId") });
});

app.notFound((c) => error(c, 404, "NOT_FOUND", "요청한 API를 찾을 수 없습니다."));
app.onError((cause, c) => {
  const message = cause instanceof Error ? cause.message : "UNKNOWN";
  console.error("Unhandled worker error", message);
  if (cause instanceof DOMException && cause.name === "TimeoutError") return error(c, 504, "UPSTREAM_TIMEOUT", "외부 AI 응답 시간이 초과됐습니다.");
  if (message === "DEEPSEEK_NOT_CONFIGURED") return error(c, 501, "FEATURE_NOT_CONFIGURED", "DeepSeek API가 설정되지 않았습니다.");
  if (message.startsWith("DEEPSEEK_")) return error(c, 502, "DEEPSEEK_ERROR", "DeepSeek 처리 중 오류가 발생했습니다.");
  if (message.includes("limit") || message.includes("quota")) return error(c, 429, "AI_FREE_QUOTA_EXHAUSTED", "오늘의 Workers AI 무료 사용량을 모두 사용했습니다.");
  return error(c, 500, "INTERNAL_ERROR", "처리 중 오류가 발생했습니다.");
});

export default app;
