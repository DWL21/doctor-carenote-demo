import init, { processPdf } from "@firecrawl/pdf-inspector-wasm";

let initialized = false;

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    if (!initialized) {
      await init();
      initialized = true;
    }
    const raw = processPdf(new Uint8Array(event.data)) as unknown as Record<string, unknown>;
    const pagesValue = raw.pagesNeedingOcr ?? raw.pages_needing_ocr;
    const result = {
      pdfType: String(raw.pdfType ?? raw.pdf_type ?? "Unknown"),
      confidence: typeof raw.confidence === "number" ? raw.confidence : null,
      pageCount:
        typeof raw.pageCount === "number"
          ? raw.pageCount
          : typeof raw.page_count === "number"
            ? raw.page_count
            : null,
      pagesNeedingOcr: Array.isArray(pagesValue)
        ? pagesValue.filter((value): value is number => typeof value === "number")
        : [],
      markdown: typeof raw.markdown === "string" ? raw.markdown : "",
    };
    self.postMessage({ ok: true, result });
  } catch (cause) {
    self.postMessage({ ok: false, error: cause instanceof Error ? cause.message : "PDF 분석 실패" });
  }
};
