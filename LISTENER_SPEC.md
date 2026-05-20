# Listener — state machine + toolbar integration

A short reference for what the Compact Listener bar represents, how its
states flow, and how the new toolbar Mic button plugs in. The bar's
behaviour is identical across both the live overlay and the Components
gallery — only the rendering differs.

---

## Session states

The session is driven by a small state machine in `prototype.js`. There
are five states and a single linear flow:

```
   ┌──────────┐ start ┌──────────┐  warm  ┌──────────┐ pause ┌──────────┐
   │   idle   │──────►│ starting │───────►│listening │──────►│  paused  │
   └──────────┘       └──────────┘  ~200ms└──────────┘◄──────└──────────┘
        ▲                                       │   resume        │
        │                                       │ stop            │ stop
        │            ┌──────────┐               ▼                 ▼
        └────────────│ stopping │◄─────────────────────────────────
                     └──────────┘
                       ~200ms
```

| State        | Meaning                                                                  |
|--------------|--------------------------------------------------------------------------|
| `idle`       | No session. Listener shows the Listen + EN CTA.                          |
| `starting`   | Warm-up after the user clicks Listen (or patient auto-open). Mic active. |
| `listening`  | Live capture. STT running, transcript accumulating, risk detection on.   |
| `paused`     | Capture suspended. Transcript + counter preserved; mic stops.            |
| `stopping`   | End-of-session cleanup. Final timer briefly visible before reset.        |

**Source of truth:** the machine inside `prototype.js`. The current state
is mirrored to two places so CSS can target it consistently:

- `body.proto-<state>` (drives the live UI's visibility / styling rules)
- `listenerSurface.dataset.state` + `toolbarMicBtn.dataset.state` (drive
  the Compact variant + toolbar mic indicator)

---

## Listener bar (Compact)

Two layouts, switched by `data-state`:

| State                     | Layout         | Height | Notes                                                |
|---------------------------|----------------|--------|------------------------------------------------------|
| `idle`                    | Single row     | 44 px  | `[Listen + EN]  [mic ⚙]  [⋮ handle]`                 |
| `listening` / `paused` / `starting` / `stopping` | Two rows | 76 px  | Row 1 = bars + label + transcript; row 2 = controls |

Mic settings and drag handle live **outside** the row container as
siblings of the wrap, bottom-aligned. When the bar grows upward from
44 → 76 on a session start, the gear + handle stay anchored to the
viewport (the bar is also bottom-anchored to the viewport via JS-pinned
`right + bottom`), so they never move on screen.

The wrap is bottom-anchored in the viewport (`position: fixed; right + bottom`
set by `pinSurface()`), and the wrap height transitions smoothly — the
visual effect is "grows upward from the controls row".

### Voice bars (Listener row 1)

5 yellow bars (`#F9CB40`) at the left of the status row. Three modes:

- **Listening** — each bar runs its own asymmetric `@keyframes` so the
  pulse doesn't read as a metronome.
- **Paused** — bars freeze in the `--II--` pause-icon pattern (centre
  two at full height, outer three collapsed). Colour drops to **white**
  to read as "frozen / inactive".
- **Other states** — bars hidden (`height: 0`).

### Elapsed-time colour

The primary-pill timer reflects whether the mic is hot:

- `listening` / `starting` / `stopping` → red `#E42045`
- `paused` / `idle` → grey `#868E93`

Pure visual signal — no behaviour change.

### Floating risk counter

A rounded-square badge floats at the wrap's top-right corner:

- Hidden when count is 0 (`--empty` modifier)
- Amber `#F09238` for 1–2
- Red `#E42045` for ≥ 3 (`.is-high`)

Source: the count comes from the existing `tbBadge` element that
`app.js` maintains. A `MutationObserver` mirrors any change into the
Listener counter, which is the canonical surface.

---

## Toolbar Mic button

A new panel button on the toolbar (sits where Ask used to). It does
**not** start or stop a session — it only toggles the Listener bar's
**visibility**. The session keeps running while hidden (STT, transcript,
timer, counter, risk detection all carry on in the DOM).

### Visibility toggle

| User action      | Effect                                                  |
|------------------|---------------------------------------------------------|
| Click Mic button | Toggles `body.listener-hidden`                          |
| First load       | Listener hidden by default                              |
| Refresh          | Restores the last user choice (`localStorage`)          |

Storage key: `ambient-ui-listener-vis-v1` (`shown` | `hidden`).

CSS-side, `body.listener-hidden.view-listener .proto-listener` carries
`display: none !important` with enough specificity to outrank the later
`body.view-listener .proto-listener { display: inline-block !important }`
rule.

### Mic button visual states

Two stacked SVGs share the same 32 × 32 slot — opacity-faded between
them so the icon position never shifts:

- `#fic-mic-tb` — plain mic, has a short stem under the yoke.
- `#fic-mic-tb-active` — same head + yoke, **no stem**, so the amber
  voice-indicator bars slot into the exact space the stem occupied.

```
idle / Listener visible        listening (hidden)         paused (hidden)
───────────────────             ───────────────            ───────────────
       ▓                              ▓                          ▓
      ▓ ▓                            ▓ ▓                        ▓ ▓
      ▓ ▓                            ▓ ▓                        ▓ ▓
       ▓                              ▓                          ▓
       |       ←  stem               ▁▁                       II
                                  ▁▂▃▂▁                          ▁▁
                                  (yellow,                    (white,
                                   animated)                   "II---" pose)
```

Indicator suppression rule: the active mic + bars only render when
`[data-state]` is non-idle **AND** the Listener bar is hidden
(`:not(.is-on)`). Once the bar is on screen the equaliser there
carries the signal — duplicating it on the toolbar would be noisy.

### Risk-count badge on the Mic button

A small rounded-square badge at the top-right of the mic. Same colour
ramp as the Listener's floating counter. Mirrored by extending
`paintListenerCounter()` so any update to the Listener counter writes
the same value to the toolbar badge.

Hidden when:
- Count is 0 (`.proto-tb-mic-count--empty`), or
- Listener bar is visible (`.proto-tb-btn--mic.is-on`).

---

## Key implementation decisions

1. **Mic toggle is visibility-only, not start/stop.** Sessions are
   started from the Listen CTA or the patient-open auto-trigger and
   stopped from the bar's own Stop pill. The toolbar Mic is a
   peripheral / glance signal, not a control. This keeps the toolbar
   safe to tap accidentally — a misclick costs zero session state.

2. **Listener stays mounted in the DOM when hidden.** Hiding is a CSS
   class on `body`. STT, transcript, timer, risk pipeline all keep
   running unaffected. Showing the bar again restores the exact same
   in-flight state with no re-init.

3. **One state, three surfaces, one source.** The machine's `state`
   string is mirrored to `body.proto-<state>`, the Listener wrap's
   `data-state`, and the toolbar mic's `data-state`. Every visual
   transition in CSS keys off one of these — no duplicated state.

4. **Two mic SVGs, not one icon that animates.** A morphing stroke
   animation between stem-and-no-stem is fragile. Opacity-fading
   between two stacked symbols is cheap, predictable, and keeps the
   icon centre pinned across states.

5. **Indicator deduplication.** When the Listener bar is on screen the
   toolbar drops back to the plain mic with no badge — the bar carries
   the signal. This avoids two simultaneous equalisers / two counters
   competing for the user's eye.

6. **Bottom-anchored growth.** The wrap is pinned with `right + bottom`
   in the viewport, and the container + mic + handle are
   `align-self: flex-end` inside it. Result: the bar grows upward when
   a session starts, with the controls row pinned exactly where it sat
   in idle. Click targets don't move.

7. **Yellow = live signal, white = frozen.** Yellow bars only ever
   appear during active capture. The paused freeze drops to white so
   the colour change is itself the cue ("the mic is no longer hot").

---

## File map

| File             | Role                                                          |
|------------------|---------------------------------------------------------------|
| `prototype.js`   | State machine, Listener markup, toolbar markup, JS wiring     |
| `prototype.css`  | Listener + toolbar visuals, state-driven rules                |
| `index.html`     | SVG symbol library (mic, grip, sparkle, etc.) + modal shells  |
| `app.js`         | Backend — STT, factor detection, the canonical `tbBadge` count |

The backend (`app.js`, `factors.js`, `aliases.js`, `localLlm.js`,
`phoneConnect.js`, `poc-extras.js`) is untouched by the Listener /
toolbar work. All UI lives in `prototype.*`.
