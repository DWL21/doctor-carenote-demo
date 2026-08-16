import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import type { Env } from "./types";

function createEnv(overrides?: Partial<Env>): Env {
  return {
    AI: {
      run: async () => ({ text: "어제부터 머리가 아픕니다." }),
      toMarkdown: async () => [{ format: "markdown", data: "# 검사 결과\n혈압 120/80 mmHg", tokens: 12 }],
    },
    ALLOWED_ORIGINS: "http://localhost:5173",
    ...overrides,
  };
}

describe("doctor demo API", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reports configured service status", async () => {
    const response = await app.request("/health", {}, createEnv({ DEEPSEEK_API_KEY: "test-key" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      services: { workersAi: true, deepseek: true },
    });
  });

  it("transcribes a supported audio upload", async () => {
    const form = new FormData();
    form.append("audio", new File([new Uint8Array([1, 2, 3])], "recording.webm", { type: "audio/webm" }));
    form.append("durationMs", "2500");
    const response = await app.request("/v1/stt", { method: "POST", body: form }, createEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      text: "어제부터 머리가 아픕니다.",
      durationMs: 2500,
    });
  });

  it("extracts text from an allowed medical document", async () => {
    const form = new FormData();
    form.append("file", new File(["%PDF-test"], "checkup.pdf", { type: "application/pdf" }));
    const response = await app.request("/v1/documents/extract", { method: "POST", body: form }, createEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sourceType: "pdf",
      text: "# 검사 결과\n혈압 120/80 mmHg",
    });
  });

  it("rejects unsupported document types", async () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const response = await app.request("/v1/documents/extract", { method: "POST", body: form }, createEnv());
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({ code: "UNSUPPORTED_DOCUMENT" });
  });

  it("rejects an empty subjective interview history", async () => {
    const response = await app.request("/v1/interview/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    }, createEnv({ DEEPSEEK_API_KEY: "test-key" }));
    expect(response.status).toBe(400);
  });

  it("sends the SOAP safety rules on every summary request", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        subjective: "두통",
        objective: "자료에 기록된 내용 없음",
        unresolved: [],
      }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await app.request("/v1/soap/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interviewRecords: ["머리가 아파요"] }),
    }, createEnv({ DEEPSEEK_API_KEY: "test-key" }));

    expect(response.status).toBe(200);
    const result = await response.json() as { soap: Record<string, unknown> };
    expect(result).toMatchObject({ soap: { subjective: "두통", objective: "자료에 기록된 내용 없음" } });
    expect(result.soap).not.toHaveProperty("assessment");
    expect(result.soap).not.toHaveProperty("plan");
    const request = upstream.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body)) as { messages: Array<{ role: string; content: string }> };
    expect(payload.messages[0]).toMatchObject({ role: "system" });
    expect(payload.messages[0]?.content).toContain("Never invent or infer clinical facts");
  });
});
