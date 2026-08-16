import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { initSync, processPdf } from "@firecrawl/pdf-inspector-wasm";

const root = new URL("..", import.meta.url).pathname;
const sampleDir = join(root, "samples/us-medical-pdfs");
const wasmPath = join(root, "node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm");
const expected = new Map([
  ["us-labcorp-chromosome-analysis-sample-report.pdf", /45,XX,der\(13;14\)|Chromosome Analysis/i],
  ["us-labcorp-m3-sample-report.pdf", /M3 (Score|CHECKLIST)|49/i],
  ["us-quest-vitamin-d-sample-report.pdf", /VITAMIN D|21 L|30-100 ng\/mL/i],
  ["us-roswell-park-pathology-sample.pdf", /SAMPLE PATHOLOGY REPORT/i],
]);

initSync({ module: readFileSync(wasmPath) });

const files = readdirSync(sampleDir).filter((file) => file.endsWith(".pdf")).sort();
if (files.length !== expected.size) throw new Error(`Expected ${expected.size} PDF samples, found ${files.length}`);

for (const file of files) {
  const bytes = readFileSync(join(sampleDir, file));
  if (bytes.length > 10 * 1024 * 1024) throw new Error(`${file}: exceeds 10MB upload limit`);
  if (bytes.subarray(0, 4).toString() !== "%PDF") throw new Error(`${file}: invalid PDF header`);

  const result = processPdf(new Uint8Array(bytes));
  const markdown = typeof result.markdown === "string" ? result.markdown : "";
  const pagesNeedingOcr = result.pagesNeedingOcr ?? result.pages_needing_ocr ?? [];
  if (markdown.length < 1000) throw new Error(`${file}: extracted Markdown is unexpectedly short (${markdown.length})`);
  if (!expected.get(file)?.test(markdown)) throw new Error(`${file}: expected sample marker/result was not extracted`);
  if (pagesNeedingOcr.length > 0) throw new Error(`${file}: unexpected OCR pages ${pagesNeedingOcr.join(",")}`);

  console.log(JSON.stringify({
    file: basename(file),
    bytes: bytes.length,
    pdfType: result.pdfType ?? result.pdf_type,
    pages: result.pageCount ?? result.page_count,
    markdownLength: markdown.length,
    pagesNeedingOcr,
  }));
}

console.log(`Validated ${files.length} US medical PDF samples.`);
