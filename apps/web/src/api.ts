import type { InterviewMessage, InterviewTurn, MedicalAnalysis, SoapSummary, SourceType } from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");

interface ApiErrorPayload {
  code?: string;
  message?: string;
}

async function parse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload & T;
  if (!response.ok) throw new Error(payload.message || `요청에 실패했습니다 (${response.status})`);
  return payload;
}

export async function transcribe(audio: Blob, durationMs: number): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, `recording.${audio.type.includes("mp4") ? "m4a" : "webm"}`);
  form.append("durationMs", String(durationMs));
  const result = await parse<{ text: string }>(await fetch(`${API_BASE}/v1/stt`, { method: "POST", body: form }));
  return result.text;
}

export async function extractDocument(file: File): Promise<{ text: string; sourceType: SourceType }> {
  const form = new FormData();
  form.append("file", file);
  return parse(await fetch(`${API_BASE}/v1/documents/extract`, { method: "POST", body: form }));
}

export async function classifyText(text: string, sourceType: SourceType): Promise<MedicalAnalysis> {
  const result = await parse<{ analysis: MedicalAnalysis }>(
    await fetch(`${API_BASE}/v1/documents/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sourceType }),
    }),
  );
  return result.analysis;
}

export async function normalizeText(text: string): Promise<{ original: string; suggestion: string; warnings: string[] }> {
  return parse(
    await fetch(`${API_BASE}/v1/text/normalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
}

export async function continueInterview(messages: InterviewMessage[]): Promise<InterviewTurn> {
  return parse(
    await fetch(`${API_BASE}/v1/interview/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    }),
  );
}

export async function summarizeSoap(input: {
  voiceMemo: string;
  documentText: string;
  interviewRecords: string[];
}): Promise<SoapSummary> {
  const result = await parse<{ soap: SoapSummary }>(
    await fetch(`${API_BASE}/v1/soap/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return result.soap;
}
