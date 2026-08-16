import { useEffect, useRef, useState } from "react";
import { classifyText, continueInterview, extractDocument, normalizeText, summarizeSoap, transcribe } from "./api";
import { inspectPdf } from "./pdf";
import type { InterviewMessage, PdfInspection, SoapSummary, SourceType } from "./types";

type SttStatus = "idle" | "requesting" | "recording" | "transcribing" | "classifying" | "error";
type DocumentStatus = "idle" | "inspecting" | "extracting" | "classifying" | "done" | "error";
type InterviewStatus = "idle" | "requesting" | "recording" | "transcribing" | "responding" | "error";
type SoapStatus = "idle" | "summarizing" | "done" | "error";
type SoapSectionKey = "subjective" | "objective";

const INITIAL_INTERVIEW_QUESTION = "지금 가장 불편한 증상을 중심으로, 언제 어떻게 시작되어 지금까지 어떻게 변했는지 편하게 말씀해 주세요.";
const FALLBACK_INTERVIEW_QUESTION = "말씀하신 내용에서 증상의 변화나 함께 나타난 불편을 조금 더 자세히 말씀해 주세요.";

const DEMO_CASES = [
  {
    title: "흉통",
    sttRecords: ["58세 남성 환자는 오늘 오전 계단을 오르던 중 가슴 중앙이 조이는 증상이 시작됐고, 약 8분간 쉬자 호전됐다고 말함."],
    documentText: "활력징후: 혈압 152/94 mmHg, 맥박 96회/분, 호흡수 20회/분, 산소포화도 97%. 심전도: 동율동, 심박수 94회/분.",
    turns: [
      [INITIAL_INTERVIEW_QUESTION, "오늘 아침 계단을 오르는데 가슴 한가운데가 꽉 조이는 것처럼 아팠고 쉬니까 좋아졌어요."],
      ["통증이 있을 때 함께 나타난 다른 증상이 있었나요?", "숨이 조금 차고 식은땀이 났지만 어지럽거나 쓰러지지는 않았어요."],
      ["이전에도 비슷한 증상이 있었나요?", "지난주에 빨리 걸을 때 한 번 비슷했지만 오늘보다 약했어요."],
    ],
    nextQuestion: "현재도 가슴 통증이나 숨참이 남아 있나요?",
  },
  {
    title: "두통",
    sttRecords: ["32세 여성 환자는 6시간 전부터 오른쪽 관자놀이에 욱신거리는 두통이 있고 통증 강도는 10점 중 7점이라고 말함."],
    documentText: "활력징후: 혈압 118/74 mmHg, 맥박 78회/분, 체온 36.7°C. 의식 명료. 상하지 근력 좌우 각 5/5.",
    turns: [
      [INITIAL_INTERVIEW_QUESTION, "오후부터 오른쪽 관자놀이가 욱신거리고 빛을 보면 더 불편해요."],
      ["두통은 갑자기 심하게 시작됐나요, 서서히 심해졌나요?", "처음에는 약하게 시작해서 한두 시간 동안 점점 심해졌어요."],
      ["두통과 함께 나타나는 다른 증상이 있나요?", "메스꺼움은 있지만 열이나 팔다리 힘 빠짐은 없어요."],
    ],
    nextQuestion: "평소에도 비슷한 두통이 있었는지 말씀해 주세요.",
  },
  {
    title: "복통",
    sttRecords: ["24세 여성 환자는 어제 저녁 배꼽 주변에서 시작된 통증이 오늘 오른쪽 아랫배로 이동했고 식욕 저하와 메스꺼움이 있다고 말함."],
    documentText: "활력징후: 혈압 110/70 mmHg, 맥박 104회/분, 체온 38.1°C. 복부 진찰: 우하복부 압통 있음.",
    turns: [
      [INITIAL_INTERVIEW_QUESTION, "어제 저녁부터 배꼽 주변이 아프다가 오늘은 오른쪽 아랫배가 더 아파졌어요."],
      ["통증이 시작된 뒤 강도와 양상이 어떻게 변했나요?", "처음에는 묵직했는데 지금은 움직이거나 기침할 때 찌르듯 더 아파요."],
      ["통증과 함께 나타난 다른 증상이 있나요?", "입맛이 없고 메스꺼우며 한 번 토했지만 설사는 없어요."],
    ],
    nextQuestion: "마지막 월경 시기와 임신 가능성을 말씀해 주세요.",
  },
] as const;

function formatTimer(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function selectMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

export default function App() {
  const [sttStatus, setSttStatus] = useState<SttStatus>("idle");
  const [documentStatus, setDocumentStatus] = useState<DocumentStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [sttRecords, setSttRecords] = useState<string[]>([]);
  const [sttError, setSttError] = useState("");
  const [documentError, setDocumentError] = useState("");
  const [documentText, setDocumentText] = useState("");
  const [fileName, setFileName] = useState("");
  const [pdfInspection, setPdfInspection] = useState<PdfInspection | null>(null);
  const [suggestion, setSuggestion] = useState("");
  const [normalizing, setNormalizing] = useState(false);
  const [filePreviewUrl, setFilePreviewUrl] = useState("");
  const [fileType, setFileType] = useState("");
  const [interviewStatus, setInterviewStatus] = useState<InterviewStatus>("idle");
  const [interviewElapsed, setInterviewElapsed] = useState(0);
  const [interviewError, setInterviewError] = useState("");
  const [interviewMessages, setInterviewMessages] = useState<InterviewMessage[]>([
    { role: "assistant", content: INITIAL_INTERVIEW_QUESTION },
  ]);
  const [soapStatus, setSoapStatus] = useState<SoapStatus>("idle");
  const [soapError, setSoapError] = useState("");
  const [soapSummary, setSoapSummary] = useState<SoapSummary | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlRef = useRef("");
  const interviewRecorderRef = useRef<MediaRecorder | null>(null);
  const interviewStreamRef = useRef<MediaStream | null>(null);
  const interviewChunksRef = useRef<Blob[]>([]);
  const interviewStartedAtRef = useRef(0);
  const recordStackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (sttStatus !== "recording") return;
    const interval = window.setInterval(() => {
      const next = Date.now() - startedAtRef.current;
      setElapsed(next);
      if (next >= 60_000) recorderRef.current?.stop();
    }, 200);
    return () => window.clearInterval(interval);
  }, [sttStatus]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  useEffect(() => {
    if (interviewStatus !== "recording") return;
    const interval = window.setInterval(() => {
      const next = Date.now() - interviewStartedAtRef.current;
      setInterviewElapsed(next);
      if (next >= 60_000) interviewRecorderRef.current?.stop();
    }, 200);
    return () => window.clearInterval(interval);
  }, [interviewStatus]);

  useEffect(() => {
    recordStackRef.current?.scrollTo({ top: recordStackRef.current.scrollHeight, behavior: "smooth" });
  }, [interviewMessages, interviewStatus]);

  useEffect(() => () => {
    interviewStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  async function runClassification(text: string, sourceType: SourceType) {
    await classifyText(text, sourceType);
  }

  async function startRecording() {
    if (interviewStatus === "recording" || interviewBusy) return;
    setSttError("");
    setSuggestion("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setSttError("이 브라우저에서는 마이크 녹음을 지원하지 않습니다.");
      setSttStatus("error");
      return;
    }

    try {
      setSttStatus("requesting");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = selectMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      setElapsed(0);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setSttError("녹음 중 오류가 발생했습니다.");
        setSttStatus("error");
      };
      recorder.onstop = async () => {
        const durationMs = Date.now() - startedAtRef.current;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        try {
          setSttStatus("transcribing");
          const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          const text = await transcribe(audio, durationMs);
          const nextRecords = [...sttRecords, text];
          const combined = nextRecords.join("\n");
          setSttRecords(nextRecords);
          setTranscript(combined);
          setSttStatus("idle");
          void runClassification(combined, "stt").catch((classificationError) => {
            console.warn("Background classification failed", classificationError);
          });
        } catch (cause) {
          setSttError(cause instanceof Error ? cause.message : "음성 변환에 실패했습니다.");
          setSttStatus("error");
        }
      };
      recorder.start(500);
      setSttStatus("recording");
    } catch (cause) {
      setSttError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "마이크 권한이 거부됐습니다. 브라우저 권한 설정에서 마이크를 허용해 주세요."
        : "마이크를 시작할 수 없습니다.");
      setSttStatus("error");
    }
  }

  function toggleRecording() {
    if (sttStatus === "recording") recorderRef.current?.stop();
    else if (["idle", "error"].includes(sttStatus)) void startRecording();
  }

  async function requestNormalization() {
    if (!transcript.trim()) return;
    try {
      setNormalizing(true);
      const result = await normalizeText(transcript);
      setSuggestion(result.suggestion);
    } catch (cause) {
      setSttError(cause instanceof Error ? cause.message : "문장 정리에 실패했습니다.");
    } finally {
      setNormalizing(false);
    }
  }

  function updateSttRecord(index: number, value: string) {
    setSttRecords((current) => {
      const next = current.map((record, recordIndex) => recordIndex === index ? value : record);
      setTranscript(next.join("\n"));
      return next;
    });
  }

  async function processFile(file: File) {
    setDocumentError("");
    setDocumentText("");
    setSoapSummary(null);
    setSoapError("");
    setSoapStatus("idle");
    setPdfInspection(null);
    setFileName(file.name);
    const allowed = ["application/pdf", "image/jpeg", "image/png"];
    if (!allowed.includes(file.type)) {
      setDocumentError("PDF, JPG, PNG 파일만 지원합니다.");
      setDocumentStatus("error");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setDocumentError("파일은 최대 10MB까지 가능합니다.");
      setDocumentStatus("error");
      return;
    }

    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    previewUrlRef.current = previewUrl;
    setFilePreviewUrl(previewUrl);
    setFileType(file.type);

    try {
      let text = "";
      let sourceType: SourceType = file.type === "application/pdf" ? "pdf" : "image";
      if (file.type === "application/pdf") {
        setDocumentStatus("inspecting");
        try {
          const inspection = await inspectPdf(file);
          setPdfInspection(inspection);
          if (inspection.markdown.trim().length > 20) text = inspection.markdown.trim();
        } catch {
          // Server extraction below remains available when local WASM cannot parse the file.
        }
      }

      if (!text) {
        setDocumentStatus("extracting");
        const extracted = await extractDocument(file);
        text = extracted.text;
        sourceType = extracted.sourceType;
      }
      setDocumentText(text);
      setDocumentStatus("done");
      void runSoapSummary({
        voiceMemo: transcript,
        documentText: text,
        interviewRecords: interviewMessages.filter((message) => message.role === "user").map((message) => message.content),
      });
      void runClassification(text, sourceType).catch((classificationError) => {
        console.warn("Background classification failed", classificationError);
      });
    } catch (cause) {
      setDocumentError(cause instanceof Error ? cause.message : "문서를 처리하지 못했습니다.");
      setDocumentStatus("error");
    }
  }

  async function startInterviewRecording() {
    if (sttStatus === "recording" || sttBusy) return;
    setInterviewError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setInterviewError("이 브라우저에서는 마이크 녹음을 지원하지 않습니다.");
      setInterviewStatus("error");
      return;
    }

    try {
      setInterviewStatus("requesting");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = selectMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      interviewStreamRef.current = stream;
      interviewRecorderRef.current = recorder;
      interviewChunksRef.current = [];
      interviewStartedAtRef.current = Date.now();
      setInterviewElapsed(0);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) interviewChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setInterviewError("녹음 중 오류가 발생했습니다.");
        setInterviewStatus("error");
      };
      recorder.onstop = async () => {
        const durationMs = Date.now() - interviewStartedAtRef.current;
        stream.getTracks().forEach((track) => track.stop());
        interviewStreamRef.current = null;
        try {
          setInterviewStatus("transcribing");
          const audio = new Blob(interviewChunksRef.current, { type: recorder.mimeType || "audio/webm" });
          const text = await transcribe(audio, durationMs);
          const nextMessages: InterviewMessage[] = [...interviewMessages, { role: "user", content: text }];
          setInterviewMessages(nextMessages);
          setInterviewStatus("responding");
          let nextQuestion = FALLBACK_INTERVIEW_QUESTION;
          try {
            const turn = await continueInterview(nextMessages);
            if (turn.reply.trim()) nextQuestion = turn.reply.trim();
          } catch (deepSeekError) {
            console.warn("Background subjective analysis failed", deepSeekError);
          }
          setInterviewMessages([...nextMessages, { role: "assistant", content: nextQuestion }]);
          setInterviewStatus("idle");
        } catch (cause) {
          setInterviewError(cause instanceof Error ? cause.message : "문진을 계속할 수 없습니다.");
          setInterviewStatus("error");
        }
      };
      recorder.start(500);
      setInterviewStatus("recording");
    } catch (cause) {
      setInterviewError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "마이크 권한이 거부됐습니다."
        : "마이크를 시작할 수 없습니다.");
      setInterviewStatus("error");
    }
  }

  function toggleInterviewRecording() {
    if (interviewStatus === "recording") interviewRecorderRef.current?.stop();
    else if (["idle", "error"].includes(interviewStatus)) void startInterviewRecording();
  }

  function resetInterview() {
    setInterviewMessages([{ role: "assistant", content: INITIAL_INTERVIEW_QUESTION }]);
    setInterviewError("");
    setInterviewStatus("idle");
    setInterviewElapsed(0);
  }

  const sttBusy = ["requesting", "transcribing", "classifying"].includes(sttStatus);
  const documentBusy = ["inspecting", "extracting", "classifying"].includes(documentStatus);
  const interviewBusy = ["requesting", "transcribing", "responding"].includes(interviewStatus);
  const currentInterviewQuestion = [...interviewMessages].reverse().find((message) => message.role === "assistant")?.content
    ?? INITIAL_INTERVIEW_QUESTION;
  const patientInterviewRecords = interviewMessages.filter((message) => message.role === "user");
  const hasSoapSource = Boolean(transcript.trim() || documentText.trim() || patientInterviewRecords.length);

  async function requestSoapSummary() {
    if (!hasSoapSource) return;
    await runSoapSummary({
      voiceMemo: transcript,
      documentText,
      interviewRecords: patientInterviewRecords.map((message) => message.content),
    });
  }

  async function runSoapSummary(input: { voiceMemo: string; documentText: string; interviewRecords: string[] }) {
    setSoapError("");
    setSoapStatus("summarizing");
    try {
      const result = await summarizeSoap(input);
      setSoapSummary(result);
      setSoapStatus("done");
    } catch (cause) {
      setSoapError(cause instanceof Error ? cause.message : "SOAP 정리에 실패했습니다.");
      setSoapStatus("error");
    }
  }

  function updateSoapSection(key: SoapSectionKey, value: string) {
    setSoapSummary((current) => current ? { ...current, [key]: value } : current);
  }

  function loadDemo(demo: (typeof DEMO_CASES)[number]) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = "";
    setFilePreviewUrl("");
    setFileType("");
    setFileName(`${demo.title} 예시 기록`);
    setDocumentText(demo.documentText);
    setDocumentStatus("done");
    setDocumentError("");
    setPdfInspection(null);
    setSttRecords([...demo.sttRecords]);
    setTranscript(demo.sttRecords.join("\n"));
    setSttError("");
    setSuggestion("");
    const messages: InterviewMessage[] = [];
    for (const [question, answer] of demo.turns) {
      messages.push({ role: "assistant", content: question }, { role: "user", content: answer });
    }
    messages.push({ role: "assistant", content: demo.nextQuestion });
    setInterviewMessages(messages);
    setInterviewError("");
    setInterviewStatus("idle");
    setSoapSummary(null);
    setSoapError("");
    setSoapStatus("idle");
    void runSoapSummary({
      voiceMemo: demo.sttRecords.join("\n"),
      documentText: demo.documentText,
      interviewRecords: demo.turns.map(([, answer]) => answer),
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="CareNote 홈">
          <span className="brand-mark">C</span>
          <span>CareNote</span>
        </a>
      </header>

      <main id="top">
        <section className="workspace">
          <div className="input-column">
            <article className="card voice-card">
              <div className="card-heading">
                <div><span className="step">01</span><h2>STT</h2></div>
              </div>

              <div className={`recorder ${sttStatus === "recording" ? "is-recording" : ""}`}>
                <button className="mic-button" type="button" onClick={toggleRecording} disabled={sttBusy || interviewStatus === "recording" || interviewBusy} aria-pressed={sttStatus === "recording"}>
                  <span className="mic-symbol">{sttStatus === "recording" ? "■" : "●"}</span>
                  <span>{sttStatus === "recording" ? "녹음 종료" : sttBusy ? "처리 중" : "녹음 시작"}</span>
                </button>
                <div className="timer">
                  <strong>{formatTimer(elapsed)}</strong>
                  <span>{sttStatus === "recording" ? "녹음 중" : "대기"}</span>
                </div>
                {sttStatus === "recording" && <div className="pulse-bars" aria-hidden="true">{[1,2,3,4,5,6,7].map((bar) => <i key={bar} />)}</div>}
              </div>

              {sttBusy && <div className="progress-line"><span />{sttStatus === "transcribing" ? "음성을 텍스트로 변환하고 있습니다" : sttStatus === "classifying" ? "의료 카테고리로 정리하고 있습니다" : "마이크 권한을 확인하고 있습니다"}</div>}
              {sttError && <p className="error-message" role="alert">{sttError}</p>}

              <span className="field-label">텍스트</span>
              <div className="record-stack stt-stack" aria-live="polite">
                {sttRecords.length === 0 ? (
                  <p className="empty-record">녹음된 문장이 없습니다.</p>
                ) : sttRecords.map((record, index) => (
                  <div className="record-item stt-record" key={`stt-${index}`}>
                    <strong>{String(index + 1).padStart(2, "0")}</strong>
                    <textarea value={record} onChange={(event) => updateSttRecord(index, event.target.value)} rows={3} aria-label={`STT 기록 ${index + 1}`} />
                  </div>
                ))}
              </div>
              <div className="button-row">
                <button className="secondary-button" type="button" onClick={() => void requestNormalization()} disabled={!transcript.trim() || normalizing}>{normalizing ? "정리 중…" : "문장 정리"}</button>
                <button className="text-button" type="button" onClick={() => { setTranscript(""); setSttRecords([]); setSuggestion(""); }} disabled={!transcript}>지우기</button>
              </div>
              {suggestion && (
                <div className="suggestion-box">
                  <span>정리 제안</span>
                  <p>{suggestion}</p>
                  <div><button type="button" onClick={() => { setTranscript(suggestion); setSttRecords([suggestion]); setSuggestion(""); }}>제안 적용</button><button type="button" onClick={() => setSuggestion("")}>무시</button></div>
                </div>
              )}
            </article>

            <article className="card document-card">
              <div className="card-heading">
                <div><span className="step">02</span><h2>File Upload</h2></div>
              </div>
              <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png" onChange={(event) => { const file = event.target.files?.[0]; if (file) void processFile(file); event.currentTarget.value = ""; }} />
              <button className={`dropzone ${documentBusy ? "is-busy" : ""}`} type="button" onClick={() => fileInputRef.current?.click()} disabled={documentBusy} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void processFile(file); }}>
                <span className="upload-icon">↥</span>
                <strong>{documentBusy ? "처리 중" : "PDF 또는 이미지 선택"}</strong>
                <p>또는 끌어놓기</p>
              </button>
              {documentBusy && <div className="progress-line"><span />{documentStatus === "inspecting" ? "파일 확인 중" : documentStatus === "extracting" ? "텍스트 추출 중" : "분류 중"}</div>}
              {documentError && <p className="error-message" role="alert">{documentError}</p>}
              {fileName && documentStatus === "done" && (
                <div className="file-result">
                  <div><span className="file-icon">✓</span><div><strong>{fileName}</strong><small>완료</small></div></div>
                  <section className="document-output">
                    <h3>텍스트</h3>
                    <pre className="parsed-text">{documentText}</pre>
                  </section>
                  {filePreviewUrl && (
                    <section className="document-output">
                      <h3>미리보기</h3>
                      {fileType === "application/pdf" ? (
                        <iframe className="file-preview pdf-preview" src={filePreviewUrl} title={`${fileName} 미리보기`} />
                      ) : (
                        <img className="file-preview image-preview" src={filePreviewUrl} alt={`${fileName} 미리보기`} />
                      )}
                    </section>
                  )}
                </div>
              )}
            </article>

            <article className="card interview-card">
              <div className="card-heading">
                <div><span className="step">03</span><h2>Voice Interview</h2></div>
              </div>
              <section className="interview-question" aria-live="polite">
                <span>질문</span>
                {interviewStatus === "responding" ? (
                  <div className="question-spinner" role="status"><i /><span className="visually-hidden">다음 질문 준비 중</span></div>
                ) : <p>{currentInterviewQuestion}</p>}
              </section>
              <section className="record-section">
                <span className="record-label">환자 문진 기록</span>
                <div className="record-stack" ref={recordStackRef} aria-live="polite">
                  {patientInterviewRecords.length === 0 ? (
                    <p className="empty-record">녹음된 문장이 없습니다.</p>
                  ) : patientInterviewRecords.map((message, index) => (
                    <div className="record-item" key={`record-${index}`}>
                      <strong>{String(index + 1).padStart(2, "0")}</strong>
                      <p>{message.content}</p>
                    </div>
                  ))}
                </div>
              </section>
              <div className={`interview-controls ${interviewStatus === "recording" ? "is-recording" : ""}`}>
                <button type="button" className="interview-record-button" onClick={toggleInterviewRecording} disabled={interviewBusy || sttStatus === "recording" || sttBusy}>
                  {interviewStatus === "recording" ? "녹음 종료" : "답변 녹음"}
                </button>
                <strong>{formatTimer(interviewElapsed)}</strong>
                <button type="button" className="text-button" onClick={resetInterview} disabled={interviewStatus === "recording" || interviewBusy}>새 문진</button>
              </div>
              {interviewStatus === "transcribing" && <div className="progress-line"><span />음성 변환 중</div>}
              {interviewStatus === "responding" && <div className="progress-line"><span />다음 질문 준비 중</div>}
              {interviewError && <p className="error-message" role="alert">{interviewError}</p>}
            </article>

            <article className="card soap-card">
              <div className="card-heading">
                <div><span className="step">04</span><h2>Summary</h2></div>
              </div>
              <div className="demo-picker">
                <span>예시 데이터</span>
                <div>{DEMO_CASES.map((demo) => <button type="button" key={demo.title} onClick={() => loadDemo(demo)}>{demo.title}</button>)}</div>
              </div>
              <button className="soap-button" type="button" onClick={() => void requestSoapSummary()} disabled={!hasSoapSource || soapStatus === "summarizing"}>
                {soapStatus === "summarizing" ? "요약 중" : "요약"}
              </button>
              {soapStatus === "summarizing" && <div className="progress-line"><span />요약 중</div>}
              {soapError && <p className="error-message" role="alert">{soapError}</p>}
              {soapSummary && (
                <div className="soap-grid">
                  {([
                    ["subjective", "S", "Subjective"],
                    ["objective", "O", "Objective"],
                  ] as const).map(([key, letter, title]) => (
                    <label className="soap-section" key={key}>
                      <span><strong>{letter}</strong>{title}</span>
                      <textarea value={soapSummary[key]} onChange={(event) => updateSoapSection(key, event.target.value)} rows={5} />
                    </label>
                  ))}
                  {soapSummary.unresolved.length > 0 && (
                    <div className="unresolved-box">{soapSummary.unresolved.map((item) => <p key={item}>{item}</p>)}</div>
                  )}
                </div>
              )}
            </article>
          </div>

        </section>
      </main>

    </div>
  );
}
