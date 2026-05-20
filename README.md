# AmbiantAI — Point-of-Care Ambient AI PoC

A web-based proof-of-concept that simulates an Ambient AI feature for the
C the Signs Point-of-Care toolbar. It listens to a consultation through
the browser microphone, transcribes the speech locally in the browser,
and detects cancer risk factors mentioned during the conversation. The
detections surface as a notification matching the existing toolbar's
visual style, and a details modal explains the reasoning.

**This is a PoC, not production.** No raw audio is stored or transmitted
off-device.

## Live demo

Deployed at GitHub Pages (URL added after the first deploy). Open it in
Chrome or Edge on a desktop, allow the microphone permission, and click
**Start listening** in the toolbar.

## Features

- Toolbar with Start / Pause / Stop controls, draggable, with a
  notification card and details modal matching the C the Signs visual
  language.
- Browser-based speech-to-text (Web Speech API) with negation handling.
- ~390 cancer risk factors (sourced from the C the Signs reference set)
  matched via two engines in parallel:
  1. **Alias matcher** — hand-authored synonym dictionary, runs instantly.
  2. **Local LLM** — sends each utterance to a small open-source model
     running on the clinician's own machine (Ollama), so the system can
     pick up natural-language phrasings the alias dictionary doesn't
     anticipate (e.g. *"annoying little cough"*, *"my urine looked
     pinkish"*).
- **"New patient open"** button simulates the production trigger that
  auto-starts listening when a today-appointment patient record opens.
- **Phone-as-microphone** (WebRTC + PeerJS) — scan a QR with your phone
  and use the phone as a remote microphone; transcription happens on the
  phone and only text travels to the laptop.

## To get the smarter detection: install Ollama (one-time, free)

The LLM detection layer requires a small model running on **your** machine.
Without it, the PoC falls back to alias matching only (still works, just
less robust to unusual phrasings).

```bash
# 1. Install Ollama (one-time)
brew install ollama        # macOS
# Windows / Linux: download from https://ollama.com

# 2. Pull the small model (~2 GB, one-time)
ollama pull qwen2.5:3b

# 3. Each time you want to use the PoC, start the server with browser
#    CORS enabled:
OLLAMA_ORIGINS="*" ollama serve
```

Leave that terminal window open while using the PoC. The page detects
the local server automatically and shows "Local LLM connected" in the
status pill.

## Running locally (developers)

```bash
git clone https://github.com/<user>/ambientai
cd ambientai
python3 -m http.server 8000
# open http://localhost:8000
```

## File map

```
index.html         Layout & SVG icon symbols
styles.css         Visual styling — matches the existing toolbar/notification
app.js             Detection engine, STT, UI wiring, phone-connect logic
factors.js         387 spoken-friendly factors (auto-extracted from the source DB)
aliases.js         Hand-authored speech aliases for 40+ high-yield factors
poc-extras.js      PoC-only factor entries that fill gaps in the source data
localLlm.js        Local Ollama LLM client (free, runs on the clinician's machine)
phoneConnect.js    WebRTC peer connection for phone-as-microphone
```

## Privacy

- All audio is processed in-browser. No raw audio file is ever stored or
  transmitted by this app.
- Transcription via the Web Speech API runs through Google's speech
  service (browser-level implementation detail), producing **text only**.
- LLM detection uses a model running entirely on the user's own machine
  (Ollama) — no clinical data leaves the device.
- All transcript and detection state lives in memory only — refresh the
  page or click **Reset** to discard it.
- This PoC is for UX validation only, not clinical use.

## Known limitations

- Mic capture during Slack / Google Meet / Zoom calls is unreliable
  because Chrome's audio pipeline applies echo cancellation that strips
  the call audio. Use the phone-as-mic mode as a workaround.
- Multiple browser tabs of the PoC fight over the mic — keep only one
  tab open at a time.
- The LLM is a small 3B-parameter model — it has the same limitations as
  any small LLM (occasional miss, occasional false positive). Tune the
  factor list and prompt in `localLlm.js` if needed.
