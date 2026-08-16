import type { PdfInspection } from "./types";

export async function inspectPdf(file: File): Promise<PdfInspection> {
  const buffer = await file.arrayBuffer();
  const worker = new Worker(new URL("./pdf-inspector.worker.ts", import.meta.url), { type: "module" });

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("PDF 로컬 분석 시간이 초과됐습니다."));
    }, 20_000);

    worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: PdfInspection; error?: string }>) => {
      window.clearTimeout(timeout);
      worker.terminate();
      if (event.data.ok && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error || "PDF 로컬 분석에 실패했습니다."));
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(new Error("PDF 분석 모듈을 불러오지 못했습니다."));
    };
    worker.postMessage(buffer, [buffer]);
  });
}
