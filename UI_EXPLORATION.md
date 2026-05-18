# UI Exploration — Ambient AI control surfaces

> **Status: rough draft prototype.**
> This is not a complete UX specification, XP write-up, or placement/behaviour
> contract. It's a working sketch to react to — surfaces, states, and visual
> direction. Use it as a starting point for discussion, not as a brief to
> implement verbatim.

## Goal

Solidify the basic **recording-state machine** for the Ambient AI feature and
explore how the controls live alongside the production toolbar — without
touching the underlying audio / STT / LLM / phone-connect logic in `app.js`.

The whole prototype is layered on top of the existing PoC as two side-loaded
files. Delete two lines in `index.html` and the original PoC is back verbatim.

## What was added

| File | Role |
|---|---|
| `prototype.css` | All new styling — view chip, Figma-accurate toolbar replica, Ambient AI surface (attached + separate), mesh-gradient backdrop, mobile-mic alignment. Scoped under `body.view-*` and per-state body classes. |
| `prototype.js` | View switcher + replica toolbar markup + Ambient AI surface markup + state machine + click proxying + Web Audio voice-meter visualiser + drag handlers. Self-contained, does not import from `app.js`. |
| `assets/figma-icons/` | Original Figma SVG asset downloads (reference copies — the live ones are inlined as `<symbol>` defs in `index.html`). |
| `index.html` | Two added `<link>` / `<script>` lines + one block of Figma-aligned `<symbol>` defs (also used by the phone-mic page). |

## What's there to look at

### Two layout variants

Switch via the chip top-right (`Attached` / `Separate`). Selection persists in
`localStorage`. URL parameters supported: `?view=attached`, `?view=separate`.

- **Attached** — AI surface docks flush under the toolbar when patient is open.
  Toolbar bottom corners square off to seal the seam.
- **Separate** — AI surface floats as an independent, draggable bar. Always
  visible, regardless of patient state.

### Replica toolbar

Figma-accurate, derived from file `OSG1s5qerpw8RyhdbrQmkY`, node
`13290:13976` (Toolbar Resources):

- 44×44 buttons, 8 px corner radius
- Exact brand tokens: `#1671BE` (brand), `#0E4777` (hover), `#034E8E`
  (wrapper / divider), `#F9CB40` (focus ribbon)
- Per-button inset shadows from Figma spec
- Floating drop shadow per Figma spec
- 8-dot drag handle on the right (sits on the wrapper colour — distinct from
  the brand-blue buttons)
- Five buttons: Patient → Dashboard → Inbox → Ask → Menu (CTS butterfly)

#### Button-state visuals

| State | Visual |
|---|---|
| Default | Brand-blue tile |
| Hover | Darker tile (`#0E4777`) |
| `:active` (pressed) | Darker tile + 4 px yellow ribbon + 1 px icon push. Lives only while mouse/key is held. |
| `:focus-visible` (keyboard) | Yellow ribbon + 2 px icon shift |
| `.is-surface-open` (sticky) | Darker tile only — no ribbon, no icon shift. Used on Patient while AI surface is open. |
| `[disabled]` | 40 % opacity |

### Ambient AI surface

Reference-aligned with Figma node `13297:25037` (Llstening / Idle drafts):

- Surface bg `#B1B4B6` (Palette/Grey)
- Inner pills `#F3F2F1` (Button/Secondary, not pure white)
- Record indicator `#E42045` (Context/Error)
- Voice-meter bars `#5CA246` (Context/Confirm)
- 12 px outer radius, 8 px inner radius
- Lato ExtraBold 14/16 type

Layout:

- **Row 1**: Pause button (visible while listening) + Primary pill (Start /
  Stop / Resume) + Drag handle (Separate variant only)
- **Row 2**: Microphone pill (mic icon + device name + 5-bar voice meter) +
  Phone-as-mic toggle

### Recording state machine

Single state holder in `prototype.js`. Five named states, body classes
derived per state.

| State | Indicator | Pill label | Timer | Pause btn | Meter |
|---|---|---|---|---|---|
| `idle` | Outlined ring (empty) | Start listening | — | — | — |
| `starting` (300 ms) | Ring + soft expanding halo | Starting… | — | — | — |
| `listening` | Filled square inside ring, **breathing** | Stop listening · mm:ss | live | visible | green, live |
| `paused` | Filled square inside ring, **static** | Resume listening · mm:ss | frozen | — | desaturated |
| `stopping` (300 ms) | Filled square fading out | Stopping… · mm:ss | final value | — | dimmed |

Transitions:

```
idle → starting → listening ↔ paused
                   ↓
               stopping → idle
```

`starting` and `stopping` are transient 300 ms states that smooth the visual
hand-off. The underlying app.js action (`#tbStart.click()` / `#tbStop.click()`)
fires immediately — only the UI is delayed. The state machine reconciles
itself against `#tbStart.is-active` and `#listenChip.is-paused` via
`MutationObserver` so external state changes still flow through.

### Triggers (Attached variant)

The AI surface is gated by `body.patient-open`. Two triggers flip it:

1. Click the **Patient button** (left-most icon on the replica toolbar) —
   toggle
2. Click **"New patient open"** in the existing status pill — set

Separate variant ignores the gate and is always visible.

### Drag

- The 8-dot toolbar handle (right edge) drags the whole `#toolbarWrap`. The
  attached AI panel follows it. Position persists in
  `localStorage['ambient-ui-tb-pos']`.
- The Separate AI panel has its own 6-dot drag grip. Position persists in
  `localStorage['ambient-ui-sep-pos']`.
- Both are viewport-clamped.

### Mesh-gradient backdrop

Replaces the muddy desktop wallpaper with a four-anchor mesh:

- Soft brand-blue `#c8def0` (top-left)
- Pale lavender `#e3dcef` (top-right)
- Pale sage `#d8e8d4` (bottom-right)
- Warm cream `#f4ebe0` (bottom-left)
- Base: cool off-white linear gradient

Static. Designed so the brand-blue toolbar reads as the focal element.

### Mobile mic page

Light alignment only — no layout redesign:

- CTS butterfly logo replaces the `#ic-clogo` chevron-C
- Fluent mic icon for the big mic button
- Brand-blue mic button when idle (was Tailwind green), brand-red when
  listening (`#E42045`)
- Status dots: `#5CA246` (listening / connected), `#E42045` (error)
- Background gradient shifted slightly darker for contrast

## Design directions explored

### Ambient school over trustworthy-recorder school

The recording UI surfaces compared across clinical tools (Abridge, Suki,
DAX Copilot, Granola, Fathom) fall into two schools:

- **Trustworthy recorder** (Abridge, Suki) — prominent reassurance UI, hard
  to miss the recording state. Optimised for clinician confidence.
- **Ambient assistant** (Granola, DAX Copilot) — low-key, fades into the
  workflow, single small pill. Optimised for not interrupting the
  consultation.

This prototype follows the **ambient school**. The trade-off is acknowledged:
confidence comes from a breathing record indicator and a single articulate
pill, not from multiple reinforcing signals.

### Conflated action + state pill

The primary pill carries the action verb AND the current state nuance in one
phrase (e.g. `Stop listening · 12:34`) — pattern from Granola and Fathom. A
separate "Listening" status label would restate what the button label
already implies, so it was cut.

In paused / stopping states, the timer slot doubles as a state-nuance slot
when something needs flagging (e.g. would carry `Reconnecting…` if that state
existed).

### Elapsed timer as a passenger, not a feature

For transcription-only contexts the timer is borderline-decorative — the
breathing indicator and meter already convey "alive". Kept for liveness
reassurance and session-anchoring, but never standalone: it only ever shows
*inside* the Stop / Resume pill. Counts seconds spent listening; freezes on
pause; resets when listening starts fresh from idle.

### Errors and edge-state info deferred to the Microphone tile

The primary pill is kept clean. Future surfaces for permission state,
connectivity drops, silence detection, low audio, source switching all live
in the Microphone tile (Row 2). The pattern: a priority stack —
`error > warning > status > device-label` — where higher-priority messages
replace the device label inline.

## What's deliberately NOT here

Marked out so it's clear what this prototype is *not* yet trying to solve:

- Source switching UI (laptop ↔ phone displayed in the Mic tile)
- Permission states (denied / pending / granted)
- Connectivity states (STT offline, LLM offline, network drop, reconnecting)
- Silence detection / auto-pause
- Session continuity across page reloads
- Patient-context shifts mid-session (auto-pause vs auto-stop vs allow + flag)
- Summary-card hand-off after Stop
- A formal state-machine library (xstate or similar)

The state machine in `prototype.js` is intentionally a small reducer rather
than a full library — it has named states, transitions, and a single source
of truth, so adding a sixth or seventh state later is a one-line addition.

## How to run

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

- Chip top-right → switch between Attached / Separate
- Patient button on the replica toolbar → reveal AI surface (Attached only)
- Start listening → grants mic permission once (Web Audio meter needs its
  own stream alongside the Web Speech API's)
- Drag the 8-dot toolbar handle to move the toolbar
- Drag the AI panel's 6-dot grip to move it (Separate variant)

## Reverting

Delete two lines in `index.html`:

```html
<link rel="stylesheet" href="prototype.css?v=9" />
<script defer src="prototype.js?v=9"></script>
```

The original PoC behaviour returns verbatim. The remaining files
(`prototype.css`, `prototype.js`, `assets/figma-icons/`, the Figma-aligned
`<symbol>` defs block in `index.html`) can be removed at leisure.

## Source references

- Figma file: `OSG1s5qerpw8RyhdbrQmkY` (🚀 C the Signs Toolbar)
- Toolbar Resources section: node `13290:13976`
- Ambient AI Llstening / Idle drafts: node `13297:25037`
- Fluent 2 icons (Pause, Mic, Phone, Play) — Microsoft Fluent UI System
  Icons, MIT
