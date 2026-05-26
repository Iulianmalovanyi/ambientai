// =====================================================================
// AmbiantAI PoC — app logic
// - Web Speech API integration (with mock fallback)
// - Risk factor detection w/ aliases + negation
// - Toolbar / notification / details modal / risk-assessment modal wiring
// PoC ONLY — not production architecture.
// =====================================================================

import { FACTORS } from './factors.js';
import { ALIASES } from './aliases.js';
import { POC_EXTRA_FACTORS, POC_EXTRA_ALIASES } from './poc-extras.js';
import { probeOllama, initLocalLlm, localLlmDetect, isLocalLlmReady, translateToEnglish } from './localLlm.js';
import { startLaptopPeer, startPhonePeer, buildPhoneUrl } from './phoneConnect.js';

// =====================================================================
// Page-mode dispatch: if URL has ?mic=<peerid>, this page is in
// mobile-microphone mode. Desktop boot (mic, Ollama) is skipped; we add
// a body class to hide all desktop UI and run mobile mic logic instead.
// =====================================================================
const URL_MIC_PARAM = new URL(window.location.href).searchParams.get('mic');
const IS_MIC_MODE = !!URL_MIC_PARAM;
if (IS_MIC_MODE) document.body.classList.add('mobile-mic-mode');

// Combine canonical factors with PoC-only extras (breathlessness, night sweats, etc.
// — flagged because the source factors.json has gaps for these high-yield concepts)
const ALL_FACTORS = [...FACTORS, ...POC_EXTRA_FACTORS]
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
const ALL_ALIASES = { ...ALIASES, ...POC_EXTRA_ALIASES };

// =====================================================================
// State
// =====================================================================
const state = {
  listening: false,           // true while STT is actively capturing
  hasEverStarted: false,      // true once the user has started at least once (controls chip visibility)
  recognition: null,          // SpeechRecognition instance
  transcript: '',             // committed transcript (always in English after translation)
  transcriptOriginal: '',     // original-language transcript (for display in transcript panel)
  interim: '',                // interim transcript
  detected: new Map(),        // canonicalName -> { factor, utterance, ts }
  recentUtterances: [],       // sliding window of last N final deltas — passed to LLM as context
  transcriptVisible: false,
  fallbackMode: false,        // true if Web Speech API not available
  notifVisible: false,
  selectedFactorIds: new Set(), // for RA modal
  lang: 'en-GB'               // STT language code (en-GB, es-ES, uk-UA)
};
const CONTEXT_WINDOW_SIZE = 3;

// =====================================================================
// DOM refs
// =====================================================================
const $ = (id) => document.getElementById(id);
const toolbarWrap = $('toolbarWrap');
const tbDot = $('tbDot');
const tbBadge = $('tbBadge');
const tbStart = $('tbStart');
const tbPause = $('tbPause');
const tbStop = $('tbStop');
const listenChip = $('listenChip');
const listenChipLabel = $('listenChipLabel');
const sttStatus = $('sttStatus');
const btnTranscriptToggle = $('btnTranscriptToggle');
const btnNewPatient = $('btnNewPatient');
const transcriptPanel = $('transcriptPanel');
const transcriptBody = $('transcriptBody');
const transcriptClose = $('transcriptClose');
const transcriptFallback = $('transcriptFallback');
const mockInput = $('mockInput');
const notif = $('notif');
const notifBadge = $('notifBadge');
const notifTitle = $('notifTitle');
const notifSub = $('notifSub');
const notifRiskAssess = $('notifRiskAssess');
const notifDetails = $('notifDetails');
const notifHide = $('notifHide');
const toast = $('toast');
// Details modal
const detailsOverlay = $('detailsOverlay');
const detailsClose = $('detailsClose');
const summaryList = $('summaryList');
const summaryEmpty = $('summaryEmpty');
const summaryCount = $('summaryCount');
const summaryProceed = $('summaryProceed');
// RA modal
const raOverlay = $('raOverlay');
const raClose = $('raClose');
const raSelectedRow = $('raSelectedRow');
const raEmptyChips = $('raEmptyChips');
const raSearch = $('raSearch');
const raProceed = $('raProceed');
const raAzNav = $('raAzNav');
const raAzList = $('raAzList');

// =====================================================================
// Detection engine
// =====================================================================

// Build lookup phrases: every canonical name + every alias, mapped to factor id
// PoC: simple list of {phrase, regex, factorName, isAlias}
const PHRASE_INDEX = (() => {
  const idx = [];
  for (const f of ALL_FACTORS) {
    // Skip canonical names that are absurdly long compound strings (won't match speech)
    if (f.name.length > 80 && /;|<|>|≥|≤/.test(f.name)) continue;
    idx.push({ phrase: f.name, regex: buildPhraseRegex(f.name), factorName: f.name, isAlias: false });
  }
  for (const [canon, aliases] of Object.entries(ALL_ALIASES)) {
    for (const a of aliases) {
      idx.push({ phrase: a, regex: buildPhraseRegex(a), factorName: canon, isAlias: true });
    }
  }
  // Sort longest-first so multi-word phrases win over single-word
  idx.sort((a, b) => b.phrase.length - a.phrase.length);
  return idx;
})();

function buildPhraseRegex(phrase) {
  // Build a regex that tolerates a small number of "stuffer" words between the
  // alias tokens. This is what lets natural speech variants match the canonical
  // alias — e.g. alias "lump in my breast" matching "lump in my [right] breast",
  // or "pain in my stomach" matching "pain [low down] in my stomach".
  //
  // K = max number of stuffer words allowed in each gap between tokens.
  // K=2 is the sweet spot — covers most natural-speech inserts without
  // letting "lump … breast" match across whole paragraphs.
  const K = 2;
  // Split phrase into tokens (escaping regex special chars per token)
  const tokens = phrase.trim().split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const stuffer = `(?:\\s+\\w+){0,${K}}\\s+`;
  const body = tokens.join(stuffer);
  const startBoundary = /^\w/.test(phrase) ? '\\b' : '';
  const endBoundary   = /\w$/.test(phrase) ? '\\b' : '';
  return new RegExp(`${startBoundary}${body}${endBoundary}`, 'gi');
}

// Negation cues that suppress a match if they appear in the 3 tokens before
// (or in compound forms like "no history of"). Scanning stops at clause-boundary
// cues so e.g. "I don't smoke, BUT I drink" doesn't suppress matches in the
// second clause; and "I'm not happy SO I started to smoke" doesn't suppress
// "smoke" because the "not" is in a different clause.
const NEGATION_CUES = new Set([
  'not', 'no', "didn't", 'didnt', "don't", 'dont', 'never', "haven't", 'havent',
  "hasn't", 'hasnt', "isn't", 'isnt', "wasn't", 'wasnt', "weren't", 'werent',
  "doesn't", 'doesnt', "wouldn't", 'wouldnt',
  'without', 'denies', 'denied', 'nor'
]);
// Words that mark a clause/sentence boundary — once we hit one of these walking
// backwards from the match, we stop looking for negation cues. (Periods are
// already stripped during tokenisation, so an explicit list is needed.)
const CLAUSE_BOUNDARIES = new Set([
  'but', 'however', 'so', 'because', 'yet', 'although', 'though',
  'and', 'then', 'before', 'after', 'while', 'when', 'whilst'
]);

// "without trying", "without meaning to", "without wanting to" — these EMPHASISE
// the symptom rather than negate it ("I lost weight without trying" = real loss).
// When we find a negation cue that's followed by one of these intent words, we
// treat the cue as non-negating.
const PSEUDO_NEGATION_FOLLOWERS = new Set(['trying','meaning','wanting','intending','dieting','doing']);

function isNegated(text, matchIndex) {
  // Take a generous chunk before the match and split into tokens, stripping
  // sentence-ending punctuation (which IS a clause boundary).
  const slice = text.slice(Math.max(0, matchIndex - 80), matchIndex).toLowerCase();
  // Replace strong punctuation with explicit boundary, then split
  const normalised = slice.replace(/[.!?;]/g, ' __BOUNDARY__ ').replace(/,/g, ' ');
  const tokens = normalised.split(/\s+/).filter(Boolean);

  // Walk backwards up to 3 tokens, looking for either a negation cue or a
  // clause boundary. Multi-word cues ("no history of") are checked separately.
  const WINDOW = 3;
  for (let i = tokens.length - 1, n = 0; i >= 0 && n < WINDOW; i--, n++) {
    const t = tokens[i];
    if (t === '__BOUNDARY__') return false;
    if (CLAUSE_BOUNDARIES.has(t)) return false;
    if (NEGATION_CUES.has(t)) {
      // Pseudo-negation: "without trying", "without meaning to", etc.
      const next = tokens[i + 1];
      if (t === 'without' && next && PSEUDO_NEGATION_FOLLOWERS.has(next)) continue;
      return true;
    }
  }

  // Multi-word cues at the very tail of the pre-match text
  const tail = tokens.slice(-4).join(' ');
  if (/(^|\s)no history of$/.test(tail)) return true;
  if (/(^|\s)free (of|from)$/.test(tail)) return true;
  return false;
}

// Extract a short snippet around the match — ~5 words either side, with
// ellipses if we've trimmed. This is what's shown in the Details modal.
function sentenceContaining(text, matchIndex, matchLength = 0) {
  // First, clamp to the sentence the match lives in (so we don't span periods).
  let sentStart = text.lastIndexOf('.', Math.max(0, matchIndex - 1));
  sentStart = sentStart === -1 ? 0 : sentStart + 1;
  let sentEnd = text.indexOf('.', matchIndex + matchLength);
  if (sentEnd === -1) sentEnd = text.length;
  const sentence = text.slice(sentStart, sentEnd).trim();
  // If the whole sentence is short, just return it.
  if (sentence.length <= 80) return sentence;
  // Otherwise build a snippet: up to 5 words before and 5 after the match.
  const matchOffset = matchIndex - sentStart;
  const matchEndOffset = matchOffset + matchLength;
  const beforeWords = sentence.slice(0, matchOffset).trim().split(/\s+/).filter(Boolean);
  const afterWords  = sentence.slice(matchEndOffset).trim().split(/\s+/).filter(Boolean);
  const beforeTrim = beforeWords.slice(-5).join(' ');
  const afterTrim  = afterWords.slice(0, 5).join(' ');
  const leadEllipsis = beforeWords.length > 5 ? '… ' : '';
  const trailEllipsis = afterWords.length > 5 ? ' …' : '';
  const matchedText = sentence.slice(matchOffset, matchEndOffset);
  return `${leadEllipsis}${beforeTrim}${beforeTrim ? ' ' : ''}${matchedText}${afterTrim ? ' ' : ''}${afterTrim}${trailEllipsis}`.trim();
}

/**
 * Run detection on the committed transcript.
 * Returns array of new detection events (factor name + utterance) added this run.
 */
function detect(text) {
  const newDetections = [];
  for (const entry of PHRASE_INDEX) {
    if (state.detected.has(entry.factorName)) continue; // PoC: each factor only triggers once
    // Iterate over all matches; the regex carries the 'g' flag so exec() advances lastIndex
    entry.regex.lastIndex = 0;
    let m, goodMatch = null;
    while ((m = entry.regex.exec(text)) !== null) {
      if (!isNegated(text, m.index)) { goodMatch = m; break; }
      // Avoid infinite loops on zero-width matches (defensive)
      if (m.index === entry.regex.lastIndex) entry.regex.lastIndex++;
    }
    if (!goodMatch) continue;
    const utterance = sentenceContaining(text, goodMatch.index, goodMatch[0].length);
    state.detected.set(entry.factorName, {
      factor: findFactor(entry.factorName),
      utterance,
      phrase: entry.phrase,
      matchIndex: goodMatch.index,
      ts: Date.now()
    });
    newDetections.push(entry.factorName);
  }
  return newDetections;
}

function findFactor(canonicalName) {
  return ALL_FACTORS.find(f => f.name === canonicalName) || { name: canonicalName, categories: ['NON_SPECIFIC'], type: 'SYMPTOM' };
}

// =====================================================================
// Farewell detection — auto-stop the session when the consultation ends.
// Matches phrases typically said at the close of a clinical encounter.
// The phrase only counts if it falls at the END of the utterance, so
// mid-conversation mentions ("…you said bye to my neighbour…") don't fire.
// Checked on BOTH the original-language transcript AND the English
// translation, so it also catches non-English farewells once translated.
// =====================================================================
const FAREWELL_REGEX = new RegExp(
  '(' + [
    'goodbye',
    'good\\s+bye',
    'bye\\s+bye',
    'bye-bye',
    'bye',                                            // bare "bye" — caught only at end of utterance
    'thank\\s*you,?\\s*doctor',
    'thanks,?\\s*doctor',
    'thanks\\s+for\\s+your\\s+time',
    'thank\\s+you\\s+so\\s+much',
    'see\\s+you\\s+(later|at\\s+the\\s+next\\s+appointment)',
    'take\\s+care',
    'speak\\s+(?:to\\s+you\\s+)?soon',
    'have\\s+a\\s+good\\s+(?:day|one)'
  ].join('|') + ')\\s*[.!?]?\\s*$',
  'i'
);

function isFarewell(text) {
  return FAREWELL_REGEX.test((text || '').trim());
}

// =====================================================================
// Microphone device selection.
//
// Problem this solves: on Macs paired with an iPhone, macOS Continuity
// Camera auto-selects the iPhone as the default audio input. Chrome's
// SpeechRecognition uses the OS default, so if the user's default is
// the iPhone, transcription dies the moment the iPhone disconnects /
// goes out of range. The app then shows "iPhone microphone is not
// available" with no fallback.
//
// We can't programmatically set the OS default, but we CAN:
//   1. Enumerate available input devices once we have permission.
//   2. Pick the most local-looking one (built-in mic, not iPhone /
//      AirPods / virtual cable).
//   3. Open a `getUserMedia` stream with `{ deviceId: { exact: X } }`
//      briefly. Chrome remembers that device choice per-origin and
//      uses it as the implicit default for the next SpeechRecognition
//      start within the same session.
//   4. Re-run the lock whenever devices change (iPhone disconnect →
//      fall back to the Mac built-in immediately).
// =====================================================================
const BUILTIN_PATTERNS = /\b(macbook|mac\s*book|built[\s-]?in|imac|mac\s*mini)\b/i;
const EXTERNAL_PATTERNS = /\b(iphone|ipad|airpods|bluetooth|usb camera|continuity)\b/i;

function scoreMicDevice(label) {
  if (!label) return 0;
  let score = 50;
  if (BUILTIN_PATTERNS.test(label)) score += 100;
  if (EXTERNAL_PATTERNS.test(label)) score -= 200;
  if (/^default/i.test(label)) score += 5;
  return score;
}

async function findPreferredMic() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
    if (!inputs.length) return null;
    inputs.sort((a, b) => scoreMicDevice(b.label) - scoreMicDevice(a.label));
    return inputs[0];
  } catch (e) {
    console.warn('[mic] enumerateDevices failed', e);
    return null;
  }
}

async function lockToPreferredMic() {
  const preferred = await findPreferredMic();
  if (!preferred || !preferred.deviceId) return null;
  // Decline to lock if the labels are blank (no permission yet) — opening
  // and immediately closing a stream still triggers Chrome to grant the
  // permission, after which we get real labels.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: preferred.deviceId } }
    });
    // Hold for a couple of ticks so Chrome's audio backend latches the
    // chosen device for the page's origin, then release it so it doesn't
    // compete with SpeechRecognition's own stream.
    await new Promise(resolve => setTimeout(resolve, 100));
    stream.getTracks().forEach(t => t.stop());
    return preferred;
  } catch (e) {
    console.warn('[mic] could not lock to preferred device', preferred.label, e);
    return null;
  }
}

// (Earlier I added a devicechange listener that re-locked to a preferred mic
// when audio devices joined/left. It conflicted with explicit user actions —
// e.g. changing the default mic in System Settings fires devicechange, and
// the listener would race with the user clicking "Open patient" to start a
// new session, causing recognition.start() to throw "already started".
// Removed. macOS's own default-mic selection is the source of truth.)

// =====================================================================
// Speech recognition
// =====================================================================
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function initRecognition() {
  if (!SR) {
    state.fallbackMode = true;
    sttStatus.textContent = 'Web Speech API not available in this browser — using mock input fallback.';
    transcriptFallback.hidden = false;
    return;
  }
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = state.lang;
  // Diagnostic event handlers — surface every state change to the UI so the
  // user can see exactly what the recogniser is doing.
  r.onstart = () => { sttStatus.textContent = 'Listening… waiting for speech.'; };
  r.onspeechstart = () => { sttStatus.textContent = 'Hearing speech…'; };
  r.onspeechend = () => { sttStatus.textContent = 'Speech ended — processing…'; };
  r.onaudiostart = () => console.log('[STT] audio stream opened');
  r.onaudioend = () => console.log('[STT] audio stream closed');
  r.onresult = async (e) => {
    let interim = '';
    let finalDelta = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalDelta += res[0].transcript;
      else interim += res[0].transcript;
    }
    state.interim = interim;
    if (finalDelta) {
      const rawDelta = finalDelta.trim();
      // If patient speaks a non-English language, translate before detection
      // so the alias matcher and detection prompts work as expected.
      let englishDelta = rawDelta;
      if (state.lang !== 'en-GB' && isLocalLlmReady()) {
        sttStatus.textContent = `Translating from ${langName(state.lang)}…`;
        englishDelta = await translateToEnglish(rawDelta);
      }
      // Track both the original (for display) and the English version (for detection)
      state.transcriptOriginal += (state.transcriptOriginal ? ' ' : '') + rawDelta;
      const deltaStart = state.transcript.length + (state.transcript ? 1 : 0);
      state.transcript += (state.transcript ? ' ' : '') + englishDelta;
      const news = detect(state.transcript);
      if (news.length) onNewDetections(news);
      if (state.lang !== 'en-GB') {
        sttStatus.textContent = `✓ "${rawDelta.slice(0, 35)}…" → "${englishDelta.slice(0, 35)}…"`;
      } else {
        sttStatus.textContent = `✓ Captured: "${englishDelta.slice(0, 70)}${englishDelta.length > 70 ? '…' : ''}"`;
      }
      runLocalLlm(englishDelta, deltaStart);
      // Auto-stop on farewell phrases (e.g. "Thank you, doctor", "Bye", "See
      // you later"). Checks BOTH the original-language utterance and its
      // English translation so it works in any supported language.
      if (isFarewell(rawDelta) || isFarewell(englishDelta)) {
        sttStatus.textContent = '👋 Farewell detected — listening stopped.';
        showToast('Farewell detected — session ended');
        // Delay slightly so the latest transcript update is visible first
        setTimeout(() => { if (state.listening) pauseListening(); }, 400);
      }
    } else if (interim) {
      sttStatus.textContent = `Hearing… "${interim.trim().slice(0, 70)}${interim.trim().length > 70 ? '…' : ''}"`;
    }
    renderTranscript();
  };
  r.onerror = (e) => {
    console.warn('SpeechRecognition error', e);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      sttStatus.textContent = 'Microphone access denied. Check browser site permissions.';
      transcriptFallback.hidden = false;
      state.fallbackMode = true;
      setListening(false);
    } else if (e.error === 'no-speech') {
      sttStatus.textContent = 'No speech heard yet — try speaking louder or closer to the mic.';
    } else if (e.error === 'audio-capture') {
      sttStatus.textContent = 'No microphone available. Check your input device.';
    } else if (e.error === 'aborted') {
      // benign — happens when we stop/restart
    } else if (e.error === 'network') {
      sttStatus.textContent = 'Speech recognition network error — check your connection.';
    } else {
      sttStatus.textContent = `Speech recognition error: ${e.error}`;
    }
  };
  r.onend = () => {
    // Auto-restart if user hasn't paused (Chrome stops between utterances)
    if (state.listening) {
      try { r.start(); } catch (_) { /* ignore overlap */ }
    }
  };
  state.recognition = r;
}

// =====================================================================
// Local LLM detection wrapper — runs after each STT final delta.
// Sends the new utterance to the local Ollama server with the full factor
// list and merges matches into the same detection state used by the regex
// engine. The model is instructed to ignore negations, but we keep a
// sentence-level safety net here too.
// =====================================================================

// Sentence-level negation: safety net used as a secondary check on LLM output.
function sentenceIsNegated(sentence) {
  const tokens = sentence.toLowerCase()
    .replace(/[.!?,;:]/g, ' ')
    .split(/\s+/).filter(Boolean);
  for (let i = 0; i < Math.min(5, tokens.length); i++) {
    const t = tokens[i];
    if (NEGATION_CUES.has(t)) {
      const next = tokens[i + 1];
      if (t === 'without' && next && PSEUDO_NEGATION_FOLLOWERS.has(next)) continue;
      return true;
    }
  }
  return false;
}

async function runLocalLlm(deltaText, deltaStart) {
  if (!isLocalLlmReady()) return;
  // Snapshot the context window BEFORE we mutate it. The current delta is
  // appended after the call so it doesn't appear as both context and target.
  const context = state.recentUtterances.slice();
  // Append current delta so future calls see it as context.
  state.recentUtterances.push(deltaText);
  if (state.recentUtterances.length > CONTEXT_WINDOW_SIZE) {
    state.recentUtterances.shift();
  }
  try {
    const matches = await localLlmDetect(deltaText, context);
    if (!matches.length) return;
    const negated = sentenceIsNegated(deltaText);
    const news = [];
    for (const m of matches) {
      if (state.detected.has(m.name)) continue;
      if (negated) continue;
      state.detected.set(m.name, {
        factor: findFactor(m.name),
        utterance: deltaText,
        phrase: `${m.quote || m.name} (LLM ${m.confidence.toFixed(2)})`,
        matchIndex: deltaStart,
        score: m.confidence,
        ts: Date.now()
      });
      news.push(m.name);
    }
    if (news.length) {
      onNewDetections(news);
      renderTranscript();
    }
  } catch (err) {
    console.warn('LLM detection error', err);
  }
}

// =====================================================================
// Audio level meter — confirms the mic is physically hearing audio even
// when the speech recogniser isn't producing transcripts. Uses a parallel
// getUserMedia stream + Web Audio AnalyserNode. Renders into the listen chip.
// =====================================================================
let audioMeter = { stream: null, ctx: null, analyser: null, raf: 0, level: 0 };
async function startAudioMeter() {
  if (audioMeter.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    // Use DEFAULT audio constraints (AEC/NS/AGC all on). Chrome shares
    // device-level settings across getUserMedia streams, so any non-default
    // constraints here propagate to SpeechRecognition's internal stream and
    // degrade transcription quality. The trade-off is that during a call,
    // speaker audio gets cancelled and won't show in the meter — but normal
    // in-person transcription works correctly, which is the primary use case.
    audioMeter.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioMeter.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioMeter.ctx.createMediaStreamSource(audioMeter.stream);
    audioMeter.analyser = audioMeter.ctx.createAnalyser();
    audioMeter.analyser.fftSize = 256;
    src.connect(audioMeter.analyser);
    const buf = new Uint8Array(audioMeter.analyser.frequencyBinCount);
    const tick = () => {
      audioMeter.analyser.getByteTimeDomainData(buf);
      // Compute RMS deviation from 128 (silence centre line)
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const d = (buf[i] - 128) / 128;
        sum += d * d;
      }
      const rms = Math.sqrt(sum / buf.length);
      audioMeter.level = Math.min(1, rms * 4); // scale up — speech RMS is small
      renderAudioMeter();
      audioMeter.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    console.warn('Audio meter unavailable:', err);
  }
}
function stopAudioMeter() {
  cancelAnimationFrame(audioMeter.raf);
  audioMeter.raf = 0;
  audioMeter.level = 0;
  renderAudioMeter();
  if (audioMeter.stream) {
    audioMeter.stream.getTracks().forEach(t => t.stop());
    audioMeter.stream = null;
  }
  if (audioMeter.ctx) {
    audioMeter.ctx.close().catch(() => {});
    audioMeter.ctx = null;
  }
}
function renderAudioMeter() {
  const bars = document.getElementById('listenChipBars');
  if (!bars) return;
  const level = audioMeter.level; // 0..1
  // 5 bars, each lights up at progressively higher thresholds
  const thresholds = [0.04, 0.10, 0.20, 0.35, 0.55];
  for (let i = 0; i < 5; i++) {
    const bar = bars.children[i];
    if (!bar) continue;
    bar.classList.toggle('is-on', level >= thresholds[i]);
  }
}

function startListening() {
  state.hasEverStarted = true;
  // Auto-show the transcript panel on first start so the user can verify
  // capture is working. They can hide it again if it gets in the way.
  if (!state.transcriptVisible) {
    state.transcriptVisible = true;
    transcriptPanel.hidden = false;
    btnTranscriptToggle.textContent = 'Hide transcript';
    renderTranscript();
  }
  if (state.fallbackMode) {
    setListening(true);
    sttStatus.textContent = 'Mock input active — type sentences and press Enter.';
    mockInput.focus();
    return;
  }
  if (!state.recognition) return;
  try {
    state.recognition.start();
    setListening(true);
    sttStatus.textContent = 'Listening… speak into the microphone.';
  } catch (err) {
    console.warn(err);
    sttStatus.textContent = 'Could not start recognition: ' + err.message;
  }
}
function pauseListening() {
  setListening(false);
  if (state.recognition) {
    try { state.recognition.stop(); } catch (_) {}
  }
  sttStatus.textContent = 'Paused. Click Start listening to resume.';
}

function setListening(isOn) {
  state.listening = isOn;
  tbStart.disabled = isOn;
  tbPause.disabled = !isOn;
  // The Start button shows the "active" pulse when listening
  tbStart.classList.toggle('is-active', isOn);
  // Listen chip: shown when listening OR paused (after at least one start),
  // hidden when idle/never-started.
  listenChip.classList.remove('is-paused');
  if (isOn) {
    listenChip.hidden = false;
    listenChipLabel.textContent = 'Listening';
  } else if (state.detected.size || state.hasEverStarted) {
    listenChip.hidden = false;
    listenChip.classList.add('is-paused');
    listenChipLabel.textContent = 'Paused';
  } else {
    listenChip.hidden = true;
  }
}

// =====================================================================
// UI rendering
// =====================================================================

function renderTranscript() {
  if (!state.transcriptVisible) return;
  // English (translated) pane — always present, used for detection display
  const final = state.transcript;
  if (!final && !state.interim) {
    transcriptBody.innerHTML = '<span class="empty">Transcript will appear here as you speak…</span>';
  } else {
    const highlighted = highlight(final);
    // For non-English source, interim text is in original language — only show in the original pane
    const interimSuffix = (state.lang === 'en-GB' && state.interim)
      ? `<span class="interim"> ${escapeHtml(state.interim)}</span>`
      : '';
    transcriptBody.innerHTML = highlighted + interimSuffix;
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }
  // Original-language pane — only used when non-English is selected
  const originalBody = document.getElementById('transcriptBodyOriginal');
  if (originalBody) {
    if (state.lang === 'en-GB') {
      originalBody.innerHTML = '';
    } else {
      const orig = state.transcriptOriginal;
      if (!orig && !state.interim) {
        originalBody.innerHTML = '<span class="empty">Original transcript will appear here…</span>';
      } else {
        originalBody.innerHTML = escapeHtml(orig || '') +
          (state.interim ? `<span class="interim"> ${escapeHtml(state.interim)}</span>` : '');
        originalBody.scrollTop = originalBody.scrollHeight;
      }
    }
  }
}

function highlight(text) {
  const safe = escapeHtml(text);
  // Highlight using stored detections (phrase already captured)
  let out = safe;
  for (const det of state.detected.values()) {
    if (!det.phrase) continue;
    const escapedPhrase = det.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(${escapedPhrase})`, 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function onNewDetections(newNames) {
  // Update toolbar dot + badge + show notification
  tbDot.classList.add('is-on');
  tbBadge.textContent = String(state.detected.size);
  tbBadge.hidden = false;
  showNotification(newNames[newNames.length - 1]);
}

function showNotification(latestName) {
  const n = state.detected.size;
  notifBadge.textContent = String(n);
  notifTitle.textContent = n === 1 ? 'Risk factor detected' : `${n} risk factors detected`;
  notifSub.textContent = `Latest: ${latestName} · from the consultation`;
  notif.hidden = false;
  state.notifVisible = true;
}

function hideNotification() {
  notif.hidden = true;
  state.notifVisible = false;
}

// =====================================================================
// Details modal
// =====================================================================
function openDetails() {
  // Group by primary cancer category
  const groups = new Map();
  for (const det of state.detected.values()) {
    const cat = primaryCategory(det.factor.categories);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(det);
  }
  summaryCount.textContent = String(state.detected.size);
  summaryList.innerHTML = '';
  summaryEmpty.hidden = state.detected.size > 0;

  for (const [cat, dets] of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'summary-group';
    groupEl.innerHTML = `
      <div class="summary-group-head">
        <span class="cat-badge cat-${cat}">${categoryShortName(cat)}</span>
        <span class="cat-name">${categoryLongName(cat)}</span>
        <span class="cat-count">· ${dets.length} factor${dets.length > 1 ? 's' : ''}</span>
      </div>
    `;
    for (const d of dets) {
      const card = document.createElement('div');
      card.className = 'summary-card';
      card.innerHTML = `
        <div class="summary-card-name">${escapeHtml(d.factor.name)}</div>
        <div class="summary-card-evidence">
          <span class="label">Heard during consultation:</span>
          <q>${escapeHtml(d.utterance || d.phrase)}</q>
        </div>
        <div class="summary-card-evidence">
          <span class="label">Possible signal for:</span>
          <span>${d.factor.categories.map(c => categoryLongName(c)).join(' · ')}</span>
        </div>
      `;
      groupEl.appendChild(card);
    }
    summaryList.appendChild(groupEl);
  }
  detailsOverlay.hidden = false;
}
function closeDetails() { detailsOverlay.hidden = true; }

function primaryCategory(cats) {
  const order = ['CHEST','GASTROINTESTINAL','BREAST','GYNAECOLOGICAL','UROLOGICAL','HEAD_AND_NECK','NEURO_AND_EYE','SKIN','HAEMATOLOGICAL','BONES_AND_SOFT_TISSUES','NON_SPECIFIC'];
  for (const o of order) if (cats.includes(o)) return o;
  return cats[0] || 'NON_SPECIFIC';
}
const CAT_LONG = {
  CHEST:'Lung / Chest', GASTROINTESTINAL:'Gastrointestinal', BREAST:'Breast', GYNAECOLOGICAL:'Gynaecological',
  UROLOGICAL:'Urological', HEAD_AND_NECK:'Head & Neck', NEURO_AND_EYE:'Neuro & Eye', SKIN:'Skin',
  HAEMATOLOGICAL:'Haematological', BONES_AND_SOFT_TISSUES:'Bones & Soft Tissues', NON_SPECIFIC:'Non-specific'
};
const CAT_SHORT = {
  CHEST:'CH', GASTROINTESTINAL:'GI', BREAST:'BR', GYNAECOLOGICAL:'GY',
  UROLOGICAL:'UR', HEAD_AND_NECK:'HN', NEURO_AND_EYE:'NE', SKIN:'SK',
  HAEMATOLOGICAL:'HA', BONES_AND_SOFT_TISSUES:'BS', NON_SPECIFIC:'NS'
};
const categoryLongName = (c) => CAT_LONG[c] || c;
const categoryShortName = (c) => CAT_SHORT[c] || (c || '').slice(0,2);

// =====================================================================
// Risk Assessment modal
// =====================================================================
function openRiskAssessment() {
  // Pre-select detected factors
  state.selectedFactorIds = new Set();
  for (const det of state.detected.values()) {
    const f = ALL_FACTORS.find(x => x.name === det.factor.name);
    if (f) state.selectedFactorIds.add(f.id);
  }
  renderRaSelected();
  renderRaList(raSearch.value);
  raOverlay.hidden = false;
}
function closeRA() { raOverlay.hidden = true; }

function renderRaSelected() {
  // Remove existing chips except the "empty" marker
  const chips = raSelectedRow.querySelectorAll('.chip');
  chips.forEach(c => c.remove());
  if (state.selectedFactorIds.size === 0) {
    raEmptyChips.hidden = false;
    return;
  }
  raEmptyChips.hidden = true;
  for (const id of state.selectedFactorIds) {
    const f = ALL_FACTORS.find(x => x.id === id);
    if (!f) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `
      <svg class="ic chip-ic"><use href="#ic-sparkles"/></svg>
      <span>${escapeHtml(f.name)}</span>
      <button class="chip-remove" aria-label="Remove">×</button>
    `;
    chip.querySelector('.chip-remove').addEventListener('click', () => {
      state.selectedFactorIds.delete(id);
      renderRaSelected();
      renderRaList(raSearch.value);
    });
    raSelectedRow.insertBefore(chip, raEmptyChips);
  }
}

function renderRaList(query) {
  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? ALL_FACTORS.filter(f => f.name.toLowerCase().includes(q))
    : ALL_FACTORS;
  // Group by first letter
  const groups = new Map();
  for (const f of filtered) {
    const letter = (f.name[0] || '?').toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(f);
  }
  // Render list
  raAzList.innerHTML = '';
  for (const [letter, items] of [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
    const head = document.createElement('div');
    head.className = 'ra-letter-head';
    head.id = 'ra-letter-' + letter;
    head.textContent = letter;
    raAzList.appendChild(head);
    for (const f of items) {
      const row = document.createElement('div');
      row.className = 'ra-row' + (state.selectedFactorIds.has(f.id) ? ' is-selected' : '');
      row.dataset.id = f.id;
      row.innerHTML = `
        <span class="ra-row-name">${escapeHtml(f.name)}<span class="ra-row-type">${f.type.replace('_',' ')}</span></span>
        <span class="ra-row-tick">✓</span>
      `;
      row.addEventListener('click', () => {
        if (state.selectedFactorIds.has(f.id)) state.selectedFactorIds.delete(f.id);
        else state.selectedFactorIds.add(f.id);
        renderRaSelected();
        row.classList.toggle('is-selected');
      });
      raAzList.appendChild(row);
    }
  }
  // A-Z nav
  raAzNav.innerHTML = '';
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const L of letters) {
    const a = document.createElement('a');
    a.textContent = L;
    if (groups.has(L)) a.href = '#ra-letter-' + L;
    else a.classList.add('is-disabled');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById('ra-letter-' + L);
      if (target) target.scrollIntoView({ behavior:'smooth', block: 'start' });
    });
    raAzNav.appendChild(a);
  }
}

// =====================================================================
// Toast
// =====================================================================
let toastTimer;
function showToast(msg, ms = 2400) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
}

// =====================================================================
// Reset
// =====================================================================
function langName(code) {
  return { 'en-GB': 'English', 'es-ES': 'Spanish', 'uk-UA': 'Ukrainian' }[code] || code;
}

function resetAll() {
  state.transcript = '';
  state.transcriptOriginal = '';
  state.interim = '';
  state.detected.clear();
  state.recentUtterances = [];
  state.hasEverStarted = state.listening;  // hide chip after reset if not currently listening
  tbDot.classList.remove('is-on');
  tbBadge.hidden = true;
  hideNotification();
  renderTranscript();
  // Recompute chip visibility based on current listening state
  setListening(state.listening);
  sttStatus.textContent = state.listening
    ? 'Reset — still listening, transcript cleared.'
    : 'Reset complete. Click the mic button on the toolbar to begin.';
  showToast('Reset complete');
}

// =====================================================================
// Wire up event listeners
// =====================================================================
// Language picker — sets state.lang, updates the recogniser, and toggles
// the original-language transcript pane.
const langPicker = document.getElementById('langPicker');
function applyLangUi() {
  const nonEnglish = state.lang !== 'en-GB';
  const paneOriginal = document.getElementById('paneOriginal');
  const paneOriginalLangName = document.getElementById('paneOriginalLangName');
  const paneEnglishLabel = document.getElementById('paneEnglishLabel');
  if (paneOriginal) paneOriginal.hidden = !nonEnglish;
  if (paneEnglishLabel) paneEnglishLabel.hidden = !nonEnglish;
  if (paneOriginalLangName) paneOriginalLangName.textContent = langName(state.lang);
}
if (langPicker) {
  langPicker.addEventListener('change', () => {
    state.lang = langPicker.value;
    showToast(`Language: ${langName(state.lang)}`);
    applyLangUi();
    renderTranscript();
    if (state.recognition) {
      const wasListening = state.listening;
      try { state.recognition.stop(); } catch (_) {}
      state.recognition.lang = state.lang;
      if (wasListening) {
        // restart with new language
        setTimeout(() => { try { state.recognition.start(); } catch (_) {} }, 200);
      }
    }
  });
}

tbStart.addEventListener('click', startListening);
tbPause.addEventListener('click', pauseListening);

// Toolbar stop/reset — clears detections and transcript and stops listening
// if active. Same behaviour as the previous in-pill Reset button.
tbStop.addEventListener('click', () => {
  if (state.listening) pauseListening();
  resetAll();
});

// "New patient open" — simulates the production behaviour where listening
// auto-starts when a patient record is opened with an appointment for today.
// Always discards the current session and begins a fresh one.
btnNewPatient.addEventListener('click', () => {
  if (state.listening) pauseListening();
  resetAll();
  startListening();
  showToast('New patient session started');
});

btnTranscriptToggle.addEventListener('click', () => {
  state.transcriptVisible = !state.transcriptVisible;
  transcriptPanel.hidden = !state.transcriptVisible;
  btnTranscriptToggle.textContent = state.transcriptVisible ? 'Hide transcript' : 'Show transcript';
  renderTranscript();
});
transcriptClose.addEventListener('click', () => {
  state.transcriptVisible = false;
  transcriptPanel.hidden = true;
  btnTranscriptToggle.textContent = 'Show transcript';
});

mockInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = mockInput.value.trim();
    if (!text) return;
    state.transcript += (state.transcript ? ' ' : '') + text + '.';
    mockInput.value = '';
    const news = detect(state.transcript);
    if (news.length) onNewDetections(news);
    renderTranscript();
  }
});

notifDetails.addEventListener('click', openDetails);
notifRiskAssess.addEventListener('click', openRiskAssessment);
notifHide.addEventListener('click', hideNotification);

detailsClose.addEventListener('click', closeDetails);
summaryProceed.addEventListener('click', () => {
  closeDetails();
  openRiskAssessment();
});

raClose.addEventListener('click', closeRA);
raSearch.addEventListener('input', () => renderRaList(raSearch.value));
raProceed.addEventListener('click', () => {
  showToast(`Proceeded with ${state.selectedFactorIds.size} factor${state.selectedFactorIds.size === 1 ? '' : 's'} (PoC stub)`);
  closeRA();
});

// Close modals on overlay click + Escape
[detailsOverlay, raOverlay].forEach(o => {
  o.addEventListener('click', (e) => { if (e.target === o) o.hidden = true; });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!detailsOverlay.hidden) closeDetails();
    else if (!raOverlay.hidden) closeRA();
  }
});

// =====================================================================
// Draggable toolbar — drag the grip handle to reposition the whole
// toolbar (and its anchored notification + listen chip).
// =====================================================================
(() => {
  const grip = document.getElementById('tbGrip');
  if (!grip || !toolbarWrap) return;
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  // Convert the CSS-centred initial position to explicit pixel left/top
  // immediately on load, so the drag handler doesn't have to also undo the
  // transform during the first drag (which was a source of jitter / no-op).
  function pinPosition() {
    const rect = toolbarWrap.getBoundingClientRect();
    toolbarWrap.style.right = 'auto';
    toolbarWrap.style.transform = 'none';
    toolbarWrap.style.left = rect.left + 'px';
    toolbarWrap.style.top = rect.top + 'px';
  }
  // Pin once layout is settled. requestAnimationFrame ensures the browser has
  // computed the centred position before we read it.
  requestAnimationFrame(() => requestAnimationFrame(pinPosition));

  function onMouseDown(e) {
    if (e.button !== 0) return; // primary mouse button only
    dragging = true;
    const rect = toolbarWrap.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    toolbarWrap.style.left = startLeft + 'px';
    toolbarWrap.style.top = startTop + 'px';
    toolbarWrap.classList.add('is-dragging');
    console.log('[Drag] start at', startLeft, startTop);
    e.preventDefault();
  }
  function onMouseMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // Clamp inside viewport so the toolbar can't be dragged off-screen
    const rect = toolbarWrap.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width;
    const maxTop = window.innerHeight - rect.height;
    const newLeft = Math.max(0, Math.min(maxLeft, startLeft + dx));
    const newTop = Math.max(0, Math.min(maxTop, startTop + dy));
    toolbarWrap.style.left = newLeft + 'px';
    toolbarWrap.style.top = newTop + 'px';
  }
  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    toolbarWrap.classList.remove('is-dragging');
  }

  grip.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  // Touch support for trackpad / mobile
  grip.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    onMouseDown({ button: 0, clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, preventDefault: () => e.preventDefault() });
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!dragging || e.touches.length !== 1) return;
    onMouseMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
  }, { passive: true });
  document.addEventListener('touchend', onMouseUp);
})();

// =====================================================================
// Boot — desktop mode only. In mic mode (?mic= URL param) we skip this
// and instead bootstrap the phone-side capture loop below.
// =====================================================================
if (!IS_MIC_MODE) {
  initRecognition();
  renderRaList(''); // pre-render so the list is ready when modal opens
  sttStatus.textContent = state.fallbackMode
    ? 'Web Speech API unavailable in this browser. Mock input below.'
    : 'Web Speech API ready · Click "Start listening" to begin (browser will prompt for mic permission).';

  // Probe the local Ollama server.
  (async () => {
    const probe = await probeOllama();
    if (probe.ok) {
      const count = initLocalLlm({ factors: ALL_FACTORS });
      console.log(`[LLM] connected to Ollama (${probe.model}, ${probe.source}) · ${count} factors enrolled`);
      if (!state.listening) {
        sttStatus.textContent = `LLM connected (${probe.model}, ${probe.source}) · ${count} factors enrolled · Click Start.`;
      }
    } else {
      console.warn('[LLM] not connected:', probe.error);
      if (!state.listening) {
        sttStatus.textContent = `Local LLM offline — using keyword matching only. (${probe.error})`;
      }
    }
  })();

  initPhoneConnectButton();
} else {
  initMobileMicMode(URL_MIC_PARAM);
}

// =====================================================================
// Phone-as-mic: laptop side. Pressing the toolbar phone button opens the
// QR modal, starts a Peer, displays the connect URL, and on connection
// disables the local STT and routes incoming phone transcripts into the
// same detection pipeline.
// =====================================================================
function initPhoneConnectButton() {
  const tbPhone = document.getElementById('tbPhone');
  const phoneOverlay = document.getElementById('phoneOverlay');
  const phoneClose = document.getElementById('phoneClose');
  const phoneQrCanvas = document.getElementById('phoneQrCanvas');
  const phoneUrl = document.getElementById('phoneUrl');
  const phoneCopyUrl = document.getElementById('phoneCopyUrl');
  const phoneStatusDot = document.getElementById('phoneStatusDot');
  const phoneStatusLabel = document.getElementById('phoneStatusLabel');
  let peerSession = null;

  function setPhoneStatus(stateName, label) {
    phoneStatusDot.classList.remove('dot--idle', 'dot--listening', 'dot--connected', 'dot--error');
    phoneStatusDot.classList.add(`dot--${stateName}`);
    phoneStatusLabel.textContent = label;
  }

  tbPhone.addEventListener('click', () => {
    phoneOverlay.hidden = false;
    if (!peerSession) startPeer();
  });
  phoneClose.addEventListener('click', () => { phoneOverlay.hidden = true; });
  phoneOverlay.addEventListener('click', (e) => { if (e.target === phoneOverlay) phoneOverlay.hidden = true; });

  function startPeer() {
    setPhoneStatus('idle', 'Starting peer…');
    peerSession = startLaptopPeer({
      onPeerId(id) {
        const url = buildPhoneUrl(id);
        phoneUrl.textContent = url;
        // Render QR code via QRious
        if (window.QRious) {
          // eslint-disable-next-line no-new
          new window.QRious({ element: phoneQrCanvas, value: url, size: 200, padding: 4 });
        } else {
          console.warn('QRious library not loaded');
        }
        setPhoneStatus('idle', 'Waiting for phone to connect…');
      },
      onPhoneConnected() {
        setPhoneStatus('connected', 'Phone connected ✓');
        tbPhone.classList.add('is-connected');
        // Disable local mic — phone is the source now
        if (state.listening) pauseListening();
        sttStatus.textContent = '📱 Phone connected — transcription streaming from phone.';
        showToast('Phone connected');
      },
      onTranscript(text, isFinal) {
        ingestPhoneTranscript(text, isFinal);
      },
      onPhoneDisconnected() {
        setPhoneStatus('idle', 'Phone disconnected.');
        tbPhone.classList.remove('is-connected');
        sttStatus.textContent = 'Phone disconnected. Reopen the modal to reconnect.';
        showToast('Phone disconnected');
      },
      onError(msg) {
        setPhoneStatus('error', msg);
      }
    });
  }

  phoneCopyUrl.addEventListener('click', () => {
    if (!phoneUrl.textContent || phoneUrl.textContent === '—') return;
    navigator.clipboard.writeText(phoneUrl.textContent).then(() => {
      showToast('Link copied');
    }).catch(() => showToast('Copy failed — select the text manually'));
  });
}

/**
 * Treat an incoming phone transcript as if the local STT had produced it.
 * Triggers alias detection and LLM detection in the same way.
 */
function ingestPhoneTranscript(text, isFinal) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  if (!isFinal) {
    // Interim — surface in status but don't run detection yet
    sttStatus.textContent = `📱 Hearing: "${trimmed.slice(0, 70)}${trimmed.length > 70 ? '…' : ''}"`;
    state.interim = trimmed;
    renderTranscript();
    return;
  }
  const deltaStart = state.transcript.length + (state.transcript ? 1 : 0);
  state.transcript += (state.transcript ? ' ' : '') + trimmed;
  state.interim = '';
  const news = detect(state.transcript);
  if (news.length) onNewDetections(news);
  sttStatus.textContent = `📱 ✓ Captured: "${trimmed.slice(0, 70)}${trimmed.length > 70 ? '…' : ''}"`;
  renderTranscript();
  runLocalLlm(trimmed, deltaStart);
}

// =====================================================================
// Phone-as-mic: phone side. Runs only when ?mic=<peerid> is in the URL.
// Connects to the laptop's peer, requests mic permission, runs Web Speech
// API locally, and sends each final transcript over the data channel.
// =====================================================================
function initMobileMicMode(targetPeerId) {
  const mmStatusDot = document.getElementById('mmStatusDot');
  const mmStatusLabel = document.getElementById('mmStatusLabel');
  const mmMicBtn = document.getElementById('mmMicBtn');
  const mmMicLabel = document.getElementById('mmMicLabel');
  const mmTranscript = document.getElementById('mmTranscript');

  let recognition = null;
  let listening = false;
  let phonePeer = null;
  let connected = false;

  function setStatus(stateName, label) {
    mmStatusDot.classList.remove('dot--idle', 'dot--listening', 'dot--connected', 'dot--error');
    mmStatusDot.classList.add(`dot--${stateName}`);
    mmStatusLabel.textContent = label;
  }

  function setMicLabel(text) { mmMicLabel.textContent = text; }

  function buildRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setStatus('error', 'Speech recognition not supported on this browser.');
      return null;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-GB';
    r.onresult = (e) => {
      let interim = '';
      let finalDelta = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalDelta += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (finalDelta) {
        const trimmed = finalDelta.trim();
        appendTranscript(trimmed, true);
        phonePeer?.sendTranscript(trimmed, true);
      }
      if (interim) {
        renderInterim(interim);
        phonePeer?.sendTranscript(interim, false);
      }
    };
    r.onerror = (e) => {
      console.warn('SR error', e);
      if (e.error === 'not-allowed') {
        setStatus('error', 'Mic permission denied.');
        listening = false;
        setMicLabel('Permission denied');
        mmMicBtn.classList.remove('is-listening');
      }
    };
    r.onend = () => {
      if (listening) {
        try { r.start(); } catch (_) {}
      }
    };
    return r;
  }

  let committed = '';
  function appendTranscript(text, isFinal) {
    if (isFinal) {
      committed = (committed ? committed + ' ' : '') + text;
    }
    mmTranscript.innerHTML = escapeHtmlPhone(committed) + '<span class="interim"></span>';
  }
  function renderInterim(text) {
    mmTranscript.innerHTML = escapeHtmlPhone(committed)
      + (text ? ` <span class="interim">${escapeHtmlPhone(text)}</span>` : '');
  }
  function escapeHtmlPhone(s) {
    return s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  mmMicBtn.addEventListener('click', async () => {
    if (!connected) return;
    if (!listening) {
      // First click: request mic + start
      if (!recognition) recognition = buildRecognition();
      if (!recognition) return;
      try {
        // Explicitly request mic permission so we get a clear error path
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop()); // SpeechRecognition opens its own
      } catch (err) {
        setStatus('error', 'Mic permission denied.');
        return;
      }
      try {
        recognition.start();
        listening = true;
        mmMicBtn.classList.add('is-listening');
        setMicLabel('Tap to stop');
        setStatus('listening', 'Listening — speak normally');
        phonePeer?.sendStatus?.('listening');
      } catch (err) {
        console.warn(err);
      }
    } else {
      try { recognition.stop(); } catch (_) {}
      listening = false;
      mmMicBtn.classList.remove('is-listening');
      setMicLabel('Tap to start');
      setStatus('connected', 'Paused — tap mic to resume');
      phonePeer?.sendStatus?.('paused');
    }
  });

  setStatus('idle', 'Connecting to laptop…');
  setMicLabel('Connecting…');

  phonePeer = startPhonePeer(targetPeerId, {
    onConnected() {
      connected = true;
      setStatus('connected', 'Connected — tap the mic to start');
      setMicLabel('Tap to start');
      mmMicBtn.disabled = false;
    },
    onDisconnected() {
      connected = false;
      listening = false;
      setStatus('error', 'Disconnected from laptop. Reload to reconnect.');
      setMicLabel('Disconnected');
      mmMicBtn.disabled = true;
      mmMicBtn.classList.remove('is-listening');
      try { recognition?.stop(); } catch (_) {}
    },
    onError(msg) {
      setStatus('error', msg);
    }
  });
}
