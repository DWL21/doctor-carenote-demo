export type SourceType = "stt" | "pdf" | "image" | "text";
export type InterviewRole = "user" | "assistant";

export interface InterviewMessage {
  role: InterviewRole;
  content: string;
}

export interface InterviewTurn {
  reply: string;
  subjective: Record<string, unknown>;
  missingItems: string[];
  redFlags: string[];
  complete: boolean;
}

export interface SoapSummary {
  subjective: string;
  objective: string;
  unresolved: string[];
}

export interface MedicalAnalysis {
  documentType: string;
  medicalHistory: Array<{ category: string; value: string; evidence: string }>;
  symptoms: Array<{
    name: string;
    onset: string | null;
    duration: string | null;
    severity: string | null;
    bodySite: string | null;
    course: string | null;
    associatedSymptoms: string[];
    evidence: string;
  }>;
  medications: Array<{ name: string; dose: string | null; frequency: string | null; evidence: string }>;
  allergies: Array<{ substance: string; reaction: string | null; evidence: string }>;
  diagnosesMentioned: Array<{ name: string; status: string; evidence: string }>;
  measurements: Array<{ name: string; value: string; unit: string | null; referenceRange: string | null; evidence: string }>;
  recommendations: Array<{ value: string; evidence: string }>;
  redFlags: Array<{ value: string; evidence: string }>;
  summary: string;
  uncertainties: string[];
}

export interface PdfInspection {
  pdfType: string;
  confidence: number | null;
  pageCount: number | null;
  pagesNeedingOcr: number[];
  markdown: string;
}
