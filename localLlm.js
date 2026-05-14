// =====================================================================
// Local LLM detection (PoC) — talks to a local Ollama server running on
// the clinician's machine. Free, private, no API key, no data leaves
// the device.
//
// Expected setup on the clinician's machine:
//   brew install ollama
//   ollama pull qwen2.5:3b
//   OLLAMA_ORIGINS="*" ollama serve
//
// The PoC POSTs each new transcript utterance to /v1/chat/completions
// (Ollama exposes an OpenAI-compatible API). The model returns a JSON
// list of detected factor names which we map back to the canonical
// factor records.
// =====================================================================

const OLLAMA_URL = 'http://localhost:11434/v1/chat/completions';
const MODEL_NAME = 'qwen2.5:7b';
const REQUEST_TIMEOUT_MS = 20000;

let factorList = []; // [{ name, hint }] — passed to the model in the prompt
let ready = false;
let lastError = null;

/**
 * Check whether the local Ollama server is reachable and the model is
 * available. Should be called on boot.
 *
 * Returns { ok, model, error }
 */
export async function probeOllama() {
  try {
    const r = await fetch('http://localhost:11434/api/tags', { method: 'GET' });
    if (!r.ok) return { ok: false, error: `Ollama responded with HTTP ${r.status}` };
    const data = await r.json();
    const hasModel = data.models?.some(m => m.name?.startsWith(MODEL_NAME));
    if (!hasModel) {
      return { ok: false, error: `Model ${MODEL_NAME} not pulled. Run: ollama pull ${MODEL_NAME}` };
    }
    return { ok: true, model: MODEL_NAME };
  } catch (err) {
    // CORS errors look the same as network errors from the browser side
    return { ok: false, error: `Cannot reach Ollama: ${err.message}. Is "ollama serve" running with OLLAMA_ORIGINS="*"?` };
  }
}

/**
 * Initialise the detector with the list of factors the model should
 * recognise. `factors` is an array of factor objects with at least
 * { name, categories }. We build a compact factor list for the prompt.
 */
export function initLocalLlm({ factors }) {
  // Skip factors with absurdly long compound names (the endometrial /
  // back-pain red-flag entries that bundle multiple criteria).
  factorList = factors
    .filter(f => !(f.name.length > 80 && /;|<|>|≥|≤/.test(f.name)))
    .map(f => ({ name: f.name, categories: f.categories || [] }));
  ready = true;
  return factorList.length;
}

export function isLocalLlmReady() { return ready; }
export function getLastError() { return lastError; }

/**
 * Build the prompt for the model. We give it a list of factor names, a
 * short sliding window of recent utterances (for context — e.g. the
 * clinician's question that the current utterance is answering), and the
 * current utterance to classify. Few-shot examples are included to
 * teach the model the expected output shape and the tricky cases
 * (negations, doctor questions, paraphrases, family relatives).
 *
 * To keep the prompt manageable we pass canonical factor names only —
 * the model already knows medical synonyms.
 */
function buildPrompt(utterance, contextUtterances = []) {
  const names = factorList.map(f => `- ${f.name}`).join('\n');
  const contextBlock = contextUtterances.length
    ? `Recent prior utterances (context only — do NOT detect factors from these, only from the current utterance):\n${contextUtterances.map(u => `  • "${u}"`).join('\n')}\n\n`
    : '';
  return [
    {
      role: 'system',
      content: `You are a clinical assistant that listens to short utterances from a primary care consultation and detects which cancer risk factors from a fixed list the speaker is describing.

You will receive:
1. A canonical list of risk factors (symptoms, signs, family history items, or lifestyle factors).
2. Optionally, up to 3 recent prior utterances for context (use them to resolve pronouns / references, but do NOT output detections that exist only in the prior context).
3. A single current utterance to classify.

Your task:
- Decide which factors from the list the CURRENT utterance describes.
- Treat the utterance generously: medical jargon, lay terms, partial descriptions, hedged language, and mentions of close relatives (mum, dad, sister, brother, uncle, aunt, grandparent, etc.) all count.
- IGNORE negations: if the speaker is denying / never had / explicitly ruled out a factor, do not include it.
- IGNORE clinician questions: if the utterance is the doctor asking about a symptom (e.g. "Have you had a cough?", "Any blood in your urine?"), do not detect anything — only the patient's affirmative description counts.
- If nothing in the list applies, return an empty array.
- Output ONLY valid JSON in this exact shape, no prose, no markdown, no code fences:
  {"matches":[{"name":"<exact factor name from the list>","quote":"<short verbatim phrase from utterance>","confidence":0.0-1.0}]}
- "name" MUST be one of the listed factor names, character for character.

Few-shot examples:

Example 1:
Current utterance: "I've had this annoying little cough that's been hanging around for weeks now"
Output: {"matches":[{"name":"Cough","quote":"annoying little cough","confidence":0.9}]}

Example 2:
Current utterance: "I don't smoke and I never have"
Output: {"matches":[]}

Example 3 (clinician question — must return no matches):
Current utterance: "Have you noticed any blood in your urine recently?"
Output: {"matches":[]}

Example 4 (paraphrase — patient doesn't say "haematuria"):
Current utterance: "Yesterday morning my urine looked pinkish, almost like blood"
Output: {"matches":[{"name":"Haematuria - visible and recurrent or persistent despite UTI treatment","quote":"urine looked pinkish, almost like blood","confidence":0.85}]}

Example 5 (family history — relative is uncle):
Current utterance: "My uncle had bowel cancer when he was in his sixties"
Output: {"matches":[{"name":"Family history of colorectal cancer","quote":"uncle had bowel cancer","confidence":0.9}]}

Example 6 (context resolves a pronoun):
Recent prior utterances:
  • "Have you been losing weight lately?"
Current utterance: "Yes, about a stone over the last three months without trying"
Output: {"matches":[{"name":"Weight loss","quote":"about a stone over the last three months","confidence":0.9}]}`
    },
    {
      role: 'user',
      content: `Risk factors:
${names}

${contextBlock}Current utterance:
"${utterance}"

Respond with JSON only.`
    }
  ];
}

/**
 * Run detection on a single utterance.
 * @param {string} utterance — the current utterance to classify
 * @param {string[]} contextUtterances — up to 3 prior utterances for context
 *        (e.g. the clinician's question the patient is responding to)
 * @returns array of { name, quote, confidence }. Empty array on failure.
 */
export async function localLlmDetect(utterance, contextUtterances = []) {
  if (!ready) return [];
  const trimmed = (utterance || '').trim();
  if (!trimmed) return [];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: buildPrompt(trimmed, contextUtterances.slice(-3)),
        temperature: 0,        // deterministic for clinical use
        response_format: { type: 'json_object' },
        stream: false
      })
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      lastError = `HTTP ${r.status}`;
      console.warn('[LLM] error response', await r.text());
      return [];
    }
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || '';
    return parseLlmResponse(content);
  } catch (err) {
    clearTimeout(timeoutId);
    lastError = err.message;
    console.warn('[LLM] request failed', err);
    return [];
  }
}

/**
 * Parse the model's JSON response defensively. Some small models
 * occasionally wrap JSON in code fences or add stray prose; we strip
 * common variants before parsing.
 */
function parseLlmResponse(raw) {
  if (!raw) return [];
  // Strip ```json … ``` if the model wraps the output
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const validNames = new Set(factorList.map(f => f.name));
    return matches
      .filter(m => m && typeof m.name === 'string' && validNames.has(m.name))
      .map(m => ({
        name: m.name,
        quote: typeof m.quote === 'string' ? m.quote : '',
        confidence: typeof m.confidence === 'number' ? m.confidence : 0.7
      }));
  } catch (err) {
    console.warn('[LLM] could not parse response:', cleaned);
    return [];
  }
}
