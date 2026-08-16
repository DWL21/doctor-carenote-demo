export interface Env {
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
    toMarkdown(
      input: { name: string; blob: Blob },
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  ALLOWED_ORIGINS?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

export type SourceType = "stt" | "pdf" | "image" | "text";
export type InterviewRole = "user" | "assistant";

export interface InterviewMessage {
  role: InterviewRole;
  content: string;
}

export interface SubjectiveSnapshot {
  chiefComplaint: string | null;
  historyOfPresentIllness: {
    onset: string | null;
    location: string | null;
    duration: string | null;
    character: string | null;
    aggravatingFactors: string[];
    relievingFactors: string[];
    timing: string | null;
    severity: string | null;
    associatedSymptoms: string[];
  };
  medicalHistory: string[];
  medications: string[];
  allergies: string[];
  familyHistory: string[];
  socialHistory: string[];
  reviewOfSystems: string[];
  patientGoals: string | null;
}

export interface InterviewTurn {
  reply: string;
  subjective: SubjectiveSnapshot;
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
  documentType:
    | "medical_history"
    | "symptom_note"
    | "health_screening"
    | "lab_result"
    | "imaging_report"
    | "prescription"
    | "referral"
    | "other";
  medicalHistory: Array<{
    category: "condition" | "surgery" | "hospitalization" | "family_history" | "social_history";
    value: string;
    evidence: string;
  }>;
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
  diagnosesMentioned: Array<{ name: string; status: "confirmed" | "suspected" | "history" | "unknown"; evidence: string }>;
  measurements: Array<{ name: string; value: string; unit: string | null; referenceRange: string | null; evidence: string }>;
  recommendations: Array<{ value: string; evidence: string }>;
  redFlags: Array<{ value: string; evidence: string }>;
  summary: string;
  uncertainties: string[];
}
