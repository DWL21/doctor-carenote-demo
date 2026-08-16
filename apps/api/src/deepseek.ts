import type { Env, InterviewMessage, InterviewTurn, MedicalAnalysis, SoapSummary, SourceType } from "./types";

const SYSTEM_PROMPT = `You extract structured facts from Korean medical text.
Return one JSON object only. Never add facts, diagnoses, medications, values, or dates that are not explicitly present.
Use short verbatim evidence from the source for every extracted item. If uncertain, omit the item and explain it in uncertainties.
This output is an information-organizing aid, not medical advice.

Required JSON shape:
{
  "documentType": "medical_history|symptom_note|health_screening|lab_result|imaging_report|prescription|referral|other",
  "medicalHistory": [{"category":"condition|surgery|hospitalization|family_history|social_history","value":"string","evidence":"string"}],
  "symptoms": [{"name":"string","onset":"string|null","duration":"string|null","severity":"string|null","bodySite":"string|null","course":"string|null","associatedSymptoms":["string"],"evidence":"string"}],
  "medications": [{"name":"string","dose":"string|null","frequency":"string|null","evidence":"string"}],
  "allergies": [{"substance":"string","reaction":"string|null","evidence":"string"}],
  "diagnosesMentioned": [{"name":"string","status":"confirmed|suspected|history|unknown","evidence":"string"}],
  "measurements": [{"name":"string","value":"string","unit":"string|null","referenceRange":"string|null","evidence":"string"}],
  "recommendations": [{"value":"string","evidence":"string"}],
  "redFlags": [{"value":"string","evidence":"string"}],
  "summary": "short Korean summary",
  "uncertainties": ["string"]
}`;

const NORMALIZE_PROMPT = `You edit Korean speech-to-text output conservatively.
Fix spacing and punctuation only. Never change medical terms, drug names, numbers, units, negation, dates, or meaning.
Return JSON only: {"suggestion":"string","warnings":["string"]}.`;

const SUBJECTIVE_INTERVIEW_PROMPT = `You are a Korean clinician conducting an adaptive pre-visit history focused on the Subjective (S) portion of a SOAP note.
The patient has already been invited to describe the problem freely. Continue like a careful clinician, not like a fixed questionnaire.

핵심 제한: 진단·처방은 하지 않고 주호소, 증상 경과, 과거력, 복약, 알레르기 등 환자의 주관적 정보만 수집한다.
This restriction applies independently on every request, including follow-up turns.

Rules:
- Ask exactly one short, natural Korean follow-up question at a time.
- Select the single highest-value question from the patient's actual words: first an urgent safety ambiguity, then an unclear symptom detail or course, then only context-relevant history, medication, or allergy information.
- Treat history domains as a flexible clinical map, never as a checklist. Skip irrelevant domains and allow unexpected concerns.
- Do not invent, infer, diagnose, recommend medication, or provide a treatment plan.
- Do not ask again for information already answered.
- Do not combine several unrelated questions into one sentence.
- Prefer open wording. Do not lead the patient toward a particular answer.
- If the patient's words suggest an emergency red flag, briefly tell them to seek immediate emergency help, record the red flag, and ask one essential safety question.
- Keep the reply under 80 Korean characters unless an emergency warning is necessary.
- Preserve negation, numbers, dates, medication names, and units exactly.
- Mark complete when another question is unlikely to materially improve the pre-visit history. When complete, reply "그 밖에 의료진에게 전하고 싶은 내용이 있나요?".

Return one JSON object only in this shape:
{
  "reply": "one Korean question or emergency notice plus one question",
  "subjective": {
    "chiefComplaint": "string|null",
    "historyOfPresentIllness": {
      "onset": "string|null", "location": "string|null", "duration": "string|null", "character": "string|null",
      "aggravatingFactors": ["string"], "relievingFactors": ["string"], "timing": "string|null",
      "severity": "string|null", "associatedSymptoms": ["string"]
    },
    "medicalHistory": ["string"], "medications": ["string"], "allergies": ["string"],
    "familyHistory": ["string"], "socialHistory": ["string"], "reviewOfSystems": ["string"],
    "patientGoals": "string|null"
  },
  "missingItems": ["string"],
  "redFlags": ["string"],
  "complete": false
}`;

const SOAP_PROMPT = `You classify and summarize clinical source text into only the Subjective and Objective sections of a Korean clinical note.
This is documentation assistance, not diagnosis, assessment, or treatment. Never invent or infer clinical facts.

Source rules:
- S: patient-reported symptoms, course, history, medications, allergies, concerns, and goals.
- O: only measurements, test findings, imaging/lab/document facts, or explicitly observed findings.
- Do not output diagnoses, differential diagnoses, assessments, recommendations, or plans.
- Classify each fact by what it represents, not merely by which source stream contains it.
- Detect blank forms, templates, field instructions, placeholders, and illustrative examples. Never convert them into patient facts or test findings.
- A document labeled SAMPLE may contain populated synthetic results; retain only values actually populated for the sample patient. If it only explains what fields would contain, write "자료에 기록된 내용 없음" and note that it is an unpopulated template in unresolved.
- Preserve negation, uncertainty, dates, numbers, units, and medication names.
- Reconcile duplicates conservatively. If sources conflict, retain the conflict in unresolved.
- Each section may be free-form and as short or detailed as its evidence supports.
- If O has no supported content, write "자료에 기록된 내용 없음".

Return JSON only:
{
  "subjective": "string",
  "objective": "string",
  "unresolved": ["string"]
}`;

type DeepSeekMessage = { role: "user" | "assistant"; content: string };

async function callDeepSeekMessages(
  env: Env,
  system: string,
  messages: DeepSeekMessage[],
): Promise<Record<string, unknown>> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_NOT_CONFIGURED");
  }

  let lastError = "DEEPSEEK_UNKNOWN";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        messages: [
          { role: "system", content: system },
          ...messages,
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      lastError = `DEEPSEEK_${response.status}:${detail.slice(0, 200)}`;
      if (response.status !== 429 && response.status < 500) throw new Error(lastError);
      continue;
    }

    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      lastError = "DEEPSEEK_EMPTY_RESPONSE";
      continue;
    }
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      lastError = "DEEPSEEK_INVALID_JSON";
    }
  }
  throw new Error(lastError);
}

async function callDeepSeek(env: Env, system: string, user: string): Promise<Record<string, unknown>> {
  return callDeepSeekMessages(env, system, [{ role: "user", content: user }]);
}

export async function classifyMedicalText(
  env: Env,
  text: string,
  sourceType: SourceType,
): Promise<MedicalAnalysis> {
  const result = await callDeepSeek(
    env,
    SYSTEM_PROMPT,
    `Source type: ${sourceType}\n\n<medical_source>\n${text}\n</medical_source>`,
  );
  return result as unknown as MedicalAnalysis;
}

export async function normalizeTranscript(env: Env, text: string) {
  const result = await callDeepSeek(env, NORMALIZE_PROMPT, `<transcript>\n${text}\n</transcript>`);
  return {
    original: text,
    suggestion: typeof result.suggestion === "string" ? result.suggestion : text,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === "string") : [],
  };
}

export async function continueSubjectiveInterview(
  env: Env,
  messages: InterviewMessage[],
): Promise<InterviewTurn> {
  const result = await callDeepSeekMessages(env, SUBJECTIVE_INTERVIEW_PROMPT, messages);
  if (typeof result.reply !== "string" || typeof result.subjective !== "object" || result.subjective === null) {
    throw new Error("DEEPSEEK_INVALID_INTERVIEW");
  }
  return result as unknown as InterviewTurn;
}

export async function summarizeSoap(
  env: Env,
  input: { voiceMemo: string; documentText: string; interviewRecords: string[] },
): Promise<SoapSummary> {
  const result = await callDeepSeek(
    env,
    SOAP_PROMPT,
    `<sources>\n${JSON.stringify(input)}\n</sources>`,
  );
  for (const key of ["subjective", "objective"] as const) {
    if (typeof result[key] !== "string") throw new Error("DEEPSEEK_INVALID_SOAP");
  }
  return {
    subjective: result.subjective as string,
    objective: result.objective as string,
    unresolved: Array.isArray(result.unresolved)
      ? result.unresolved.filter((item): item is string => typeof item === "string")
      : [],
  };
}
