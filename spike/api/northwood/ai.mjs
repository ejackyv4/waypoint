/**
 * The two calls that leave the building.
 *
 * Everything else in this system talks to its own database. This module talks
 * to somebody else's model, which makes it the one place where a recording of
 * a supervision conversation goes somewhere Northwood does not control. That
 * is worth keeping in a single small file with the boundary written on it,
 * rather than spread across the handlers that happen to need it.
 *
 * Both providers are addressed by URL, so "who hears the audio" is a config
 * value. The transcription client speaks the OpenAI audio API — which Groq and
 * the self-hosted whisper servers also implement — so pointing this at a
 * machine on the premises is a change of environment variable, not of code.
 * For this data that is not a hypothetical nicety; it is the likely ending.
 *
 * Neither call happens on its own. A recording is transcribed when an officer
 * asks, never on upload.
 */

import { STT_URL, STT_KEY, STT_MODEL, LLM_URL, LLM_KEY, LLM_MODEL, LLM_API,
         AI_TIMEOUT_MS } from "../config.mjs";

/** Errors a handler can show a person verbatim. */
class AIError extends Error {}
const fail = msg => { throw new AIError(msg); };

/* A request with no ceiling is a job stuck on "running" forever. */
const withTimeout = async (label, fn) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    return await fn(ctl.signal);
  } catch (e) {
    if (e.name === "AbortError")
      fail(`${label} took longer than ${Math.round(AI_TIMEOUT_MS / 60000)} minutes `
         + `and was abandoned.`);
    throw e;
  } finally { clearTimeout(timer); }
};

/* Providers return their complaints in several shapes. Dig out the sentence a
   person can act on rather than showing them a JSON blob. */
const messageFrom = (body, status) =>
  body?.error?.message || body?.error?.type || body?.message
  || `the service answered ${status}`;

/* ------------------------------------------------------------------ *
 * speech to text                                                      *
 * ------------------------------------------------------------------ */

/**
 * @param bytes     the audio, exactly as it was stored
 * @param filename  passed through so the service can see the container type;
 *                  ours are .m4a
 * @returns { text, language, engine }
 */
export async function transcribe(bytes, filename, mime_type) {
  if (!STT_KEY)
    fail("Transcription is not configured. Set WAYPOINT_STT_KEY (and "
       + "WAYPOINT_STT_URL, if the service is not OpenAI's).");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime_type }), filename);
  form.append("model", STT_MODEL);
  /* verbose_json so the detected language comes back too. A transcript that
     does not say what language it thought it was hearing is one nobody can
     sanity-check when it returns nonsense. */
  form.append("response_format", "verbose_json");

  const r = await withTimeout("Transcription", signal => fetch(STT_URL, {
    method: "POST", body: form, signal,
    headers: { Authorization: `Bearer ${STT_KEY}` }
  }));

  const body = await r.json().catch(() => ({}));
  if (!r.ok) fail(`Transcription failed — ${messageFrom(body, r.status)}`);
  if (typeof body.text !== "string")
    fail("Transcription returned no text. Check WAYPOINT_STT_MODEL is a "
       + "speech-to-text model.");

  return { text: body.text.trim(), language: body.language || null,
           engine: `${new URL(STT_URL).host}:${STT_MODEL}` };
}

/* ------------------------------------------------------------------ *
 * summary and action items                                            *
 * ------------------------------------------------------------------ */

/* Asked for through a tool schema rather than "reply in JSON", so the shape is
   enforced by the API instead of by a regex over prose that mostly works. */
const SUMMARY_TOOL = {
  name: "record_visit_summary",
  description: "File the summary of a supervision visit.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "One sentence, under 100 characters, that an officer "
                   + "scanning a list of visits would find useful."
      },
      body: {
        type: "string",
        description: "What was discussed, in plain prose — short paragraphs, no "
                   + "headings or bullet characters. This is CONTEXT, not a list "
                   + "of tasks: the commitments are captured separately as "
                   + "actions, so do not restate them here. Cover what was "
                   + "reported, anything disputed or unresolved, and anything an "
                   + "officer would want to know that is not an action."
      },
      actions: {
        type: "array",
        description: "Things somebody committed to or was told to do. Empty if "
                   + "nothing was actually agreed — do not invent follow-ups to "
                   + "fill the list.",
        items: {
          type: "object",
          properties: {
            body: { type: "string",
                    description: "The action, in the imperative, using ONLY words "
                               + "and facts that appear in the transcript. Do not "
                               + "add a qualifier nobody said: if the transcript "
                               + "says \"book the test\", write \"Book the test\" "
                               + "— not \"Book the written driving test\". A "
                               + "detail you supplied is a detail nobody agreed "
                               + "to. Leave the timing out; it goes in due_hint." },
            owner: { type: "string", enum: ["officer", "subject", "unclear"],
                     description: "Who is to do it. 'unclear' if the recording "
                                + "does not say." },
            due_hint: { type: "string",
                        description: "The timing, quoted as it was said: "
                                   + "\"by Friday\", \"today\", \"this week\", "
                                   + "\"before the shift\". Fill this in whenever "
                                   + "ANY timing was spoken, even loosely — it is "
                                   + "shown beside the action and is the first "
                                   + "thing an officer looks for. Omit only when "
                                   + "no timing was mentioned at all." },
            quote: { type: "string",
                     description: "The transcript's own words, quoted exactly, "
                                + "covering EVERY fact in the action. This may "
                                + "span more than one turn: if the instruction "
                                + "is in one line and what it refers to is in an "
                                + "earlier one, include both and join them with "
                                + "\u2009\u2026\u2009. Example: the officer says "
                                + "\"book the test anyway\" and the subject said "
                                + "\"I need to book the written test\" earlier — "
                                + "quote both, or the word \"written\" in the "
                                + "action has nothing behind it. Keep it as short "
                                + "as it can be while still complete." }
          },
          required: ["body", "owner"]
        }
      }
    },
    required: ["headline", "body", "actions"]
  }
};

/* Written at the model rather than at the reader, so it is worth being blunt:
   the failure that matters here is confident invention. A transcript of a
   doorstep conversation is half-audible by nature, and a summary that smooths
   over the inaudible parts is worse than no summary, because it reads exactly
   as well as an accurate one. */
const SYSTEM = `
You are summarising the transcript of a corrections supervision visit between
a parole/probation officer and the person they supervise.

This summary may end up in a case file and may be read by people making
decisions about someone's liberty. Accordingly:

- Record only what the transcript actually contains. Never infer, fill a gap,
  or smooth over a passage that is garbled or inaudible.
- This applies word by word inside an action item, not just to the summary. Do
  not name a thing the transcript did not name, and do not qualify a noun it
  left unqualified — "the test" stays "the test" unless somebody said which
  test.
- An officer reading the item must find every fact of it in the quote beside
  it. A conversation spreads the justification across turns: the instruction in
  one line, the thing it refers to in an earlier one. Quote both. A quote that
  omits where a word came from is worse than no quote, because it looks like
  the whole basis and is not.
- Where the transcript is unclear, say so in the summary in those words.
- Do not assess, diagnose, or characterise the subject. Report what was said,
  not what it suggests about them.
- Do not decide whether anything is a violation. That is the officer's call.
- An action item is something a person actually committed to or was instructed
  to do, in the recording. If nothing was agreed, return an empty list.
- Put any timing that was spoken into the action's due_hint, quoted as said,
  and keep it out of the action text itself.
- Where the two people disagree about a fact, record both accounts and do not
  settle it. Deciding which is true is the officer's job, not yours.
- The transcript is machine-generated and will contain errors, especially with
  names, numbers, dates and addresses. Treat those as unreliable and do not
  present them as certain.
`.trim();

/**
 * @param text     the transcript
 * @param context  { subject_name, officer, scheduled_at, location } — plain
 *                 facts the record already holds, so the model is not left
 *                 guessing them from the audio
 * @returns { headline, body, actions, model }
 */
export async function summarise(text, context = {}) {
  if (!LLM_KEY)
    fail("Summarising is not configured. Set WAYPOINT_LLM_KEY (or "
       + "ANTHROPIC_API_KEY).");
  if (!String(text || "").trim())
    fail("There is nothing to summarise — the transcript is empty.");

  const facts = [
    context.subject_name && `Subject: ${context.subject_name}`,
    context.officer && `Officer: ${context.officer}`,
    context.scheduled_at && `Visit date: ${context.scheduled_at.slice(0, 10)}`,
    context.location && `Location: ${context.location}`
  ].filter(Boolean).join("\n");

  const prompt = `${facts ? facts + "\n\n" : ""}`
               + `Transcript of the visit:\n\n${text}`;

  /* Two wire formats, one request. They differ in the auth header, the tool
     envelope and where the answer sits — nothing that changes what is being
     asked for, which is why the tool schema and the system prompt above are
     shared rather than written twice and left to drift. */
  const anthropic = LLM_API === "anthropic";
  const init = anthropic ? {
    headers: { "Content-Type": "application/json", "x-api-key": LLM_KEY,
               "anthropic-version": "2023-06-01" },
    body: {
      model: LLM_MODEL, max_tokens: 2000, system: SYSTEM,
      tools: [SUMMARY_TOOL],
      tool_choice: { type: "tool", name: SUMMARY_TOOL.name },
      messages: [{ role: "user", content: prompt }]
    }
  } : {
    headers: { "Content-Type": "application/json",
               Authorization: `Bearer ${LLM_KEY}` },
    body: {
      model: LLM_MODEL,
      tools: [{ type: "function", function: {
        name: SUMMARY_TOOL.name, description: SUMMARY_TOOL.description,
        parameters: SUMMARY_TOOL.input_schema } }],
      tool_choice: { type: "function", function: { name: SUMMARY_TOOL.name } },
      messages: [{ role: "system", content: SYSTEM },
                 { role: "user", content: prompt }]
    }
  };

  const r = await withTimeout("Summarising", signal => fetch(LLM_URL, {
    method: "POST", signal,
    headers: init.headers,
    body: JSON.stringify(init.body)
  }));

  const body = await r.json().catch(() => ({}));
  if (!r.ok) fail(`Summarising failed — ${messageFrom(body, r.status)}`);

  let out;
  if (anthropic) {
    out = (body.content || []).find(c => c.type === "tool_use")?.input;
  } else {
    /* OpenAI-compatible returns the arguments as a JSON STRING, so a model
       that answers with prose instead of calling the tool lands here as a
       parse error rather than as a summary of nothing. */
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    try { out = call && JSON.parse(call.function.arguments); } catch { out = null; }
  }
  if (!out) fail("The model did not return a summary in the expected shape.");

  const { headline, body: prose, actions } = out;
  return {
    headline: String(headline || "").trim() || null,
    body: String(prose || "").trim(),
    /* Anything with no text is dropped here rather than stored as an empty
       row an officer has to look at and wonder about. */
    actions: (Array.isArray(actions) ? actions : [])
      .filter(a => String(a?.body || "").trim())
      .map(a => ({
        body: String(a.body).trim(),
        owner: ["officer", "subject"].includes(a.owner) ? a.owner : "unclear",
        /* Models like to hand back the phrase already in quotes, and the
           screen adds its own — so "\"today\"" renders as ""today"". Strip
           one layer here rather than in the template, where every future
           consumer would have to remember to. */
        due_hint: String(a.due_hint || "").trim()
                    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "").trim() || null,
        quote: String(a.quote || "").trim() || null
      })),
    model: body.model || LLM_MODEL
  };
}

const PROGRAM_ANALYSIS_TOOL = {
  name: "program_completion_analysis",
  description: "Analyze a course response evidence bundle for an officer review draft.",
  input_schema: { type: "object", properties: {
    headline: { type: "string" },
    findings: { type: "array", items: { type: "object", properties: {
      text: { type: "string" }, section: { type: "string" }, lesson: { type: "string" },
      evidence: { type: "string" }, confidence: { type: "string", enum: ["low", "medium", "high"] },
      uncertainty: { type: "string" }
    }, required: ["text", "evidence", "confidence", "uncertainty"] } },
    response_quality_flags: { type: "array", items: { type: "object", properties: {
      category: { type: "string" }, evidence: { type: "string" }, response_index: { type: "integer" }
    }, required: ["category", "evidence", "response_index"] } },
    danger_signs: { type: "array", items: { type: "object", properties: {
      category: { type: "string" }, severity: { type: "string", enum: ["informational", "concern", "urgent review"] },
      evidence: { type: "string" }, section: { type: "string" }, lesson: { type: "string" },
      confidence: { type: "string", enum: ["low", "medium", "high"] }, uncertainty: { type: "string" }
    }, required: ["category", "severity", "evidence", "confidence", "uncertainty"] } },
    follow_up_questions: { type: "array", items: { type: "string" } }
  }, required: ["headline", "findings", "response_quality_flags", "danger_signs", "follow_up_questions"] }
};

/** Structured Phase 3 analysis. It shares the configured provider boundary but
    deliberately returns review evidence, never a definitive risk decision. */
export async function analyzeProgram(text, context = {}) {
  if (!LLM_KEY) fail("Program analysis is not configured. Set WAYPOINT_LLM_KEY.");
  const system = "Analyze only the supplied course evidence. Return the requested tool. "
    + "Use exact evidence excerpts and lesson context. Treat quality flags and danger signs as review prompts, not facts. "
    + "Never declare a subject high-risk, deceptive, safe, or suitable for release. "
    + "If evidence is insufficient, say so in uncertainty and use low confidence.";
  const prompt = `Subject: ${context.subject_name || "unknown"}\nProgram: ${context.program || "unknown"}\nStatus: ${context.status || "unknown"}\n\n${text}`;
  const anthropic = LLM_API === "anthropic";
  const body = anthropic ? {
    model: LLM_MODEL, max_tokens: 3000, system, tools: [PROGRAM_ANALYSIS_TOOL],
    tool_choice: { type: "tool", name: PROGRAM_ANALYSIS_TOOL.name }, messages: [{ role: "user", content: prompt }]
  } : {
    model: LLM_MODEL, tools: [{ type: "function", function: { name: PROGRAM_ANALYSIS_TOOL.name,
      description: PROGRAM_ANALYSIS_TOOL.description, parameters: PROGRAM_ANALYSIS_TOOL.input_schema } }],
    tool_choice: { type: "function", function: { name: PROGRAM_ANALYSIS_TOOL.name } },
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }]
  };
  const r = await withTimeout("Program analysis", signal => fetch(LLM_URL, {
    method: "POST", signal, headers: anthropic
      ? { "Content-Type": "application/json", "x-api-key": LLM_KEY, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify(body)
  }));
  const outBody = await r.json().catch(() => ({}));
  if (!r.ok) fail(`Program analysis failed — ${messageFrom(outBody, r.status)}`);
  let out;
  if (anthropic) out = (outBody.content || []).find(c => c.type === "tool_use")?.input;
  else { try { out = JSON.parse(outBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments || "null"); } catch {} }
  if (!out || !Array.isArray(out.findings) || !Array.isArray(out.danger_signs))
    fail("The model did not return structured program analysis.");
  return { ...out, model: outBody.model || LLM_MODEL, phase: "phase3" };
}

export { AIError };
