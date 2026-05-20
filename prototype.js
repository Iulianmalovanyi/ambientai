/* =====================================================================
   AmbiantAI PoC — UI exploration overlay
   Self-contained, does not import from or modify app.js.
   Adds: replica toolbar (Figma-accurate, draggable), horizontal Ambient
   AI feed surface (draggable, right-anchored), Components gallery view.
   Reads from app.js state (mutations on #tbStart / #listenChip) but never
   mutates the underlying audio pipeline.
   ===================================================================== */
(function () {
  if (new URL(location.href).searchParams.get('mic')) return; // skip phone-mic page

  const STORAGE_VIEW = 'ambient-ui-view';
  const STORAGE_TB_POS = 'ambient-ui-tb-pos';
  // v2 — invalidates any stale `{x, y}` or off-screen positions from older
  // builds so the Listener doesn't appear "missing" because it was pinned
  // beyond the current viewport.
  const STORAGE_LISTENER_POS = 'ambient-ui-listener-pos-v2';
  // Visibility toggle (controlled by the toolbar Mic button). Default
  // first-load behaviour: the Listener is HIDDEN until the user opens it
  // from the toolbar. The state of the session itself keeps running while
  // hidden (STT, timer, counter, transcript) — toggling the toolbar mic
  // just shows/hides the bar.
  const STORAGE_LISTENER_VIS = 'ambient-ui-listener-vis-v1';

  // Drag + persistence is on. Listener uses right + bottom anchors so the
  // wrap expands UPWARD on listen — controls + handle stay still.
  const DRAG_ENABLED = true;

  const STORAGE_BG = 'ambient-ui-bg';
  const BG_OPTIONS = ['light', 'dark'];

  const STORAGE_VARIANT = 'ambient-ui-variant';
  // Wide = single-row horizontal layout (original).
  // Compact = two-row layered layout with voice equaliser + floating counter.
  const VARIANT_OPTIONS = ['wide', 'compact'];

  // Figma-extracted SVG symbols live in index.html (the static <defs> block
  // labelled "Figma-aligned symbols") so they're available on the
  // phone-mic page too — prototype.js short-circuits there.

  // -------- 1. Chip — Components toggle ---------------------------------
  // Single horizontal layout, no direction switching. The chip is now just
  // a hop to the Components gallery and back.
  const chip = document.createElement('div');
  chip.className = 'proto-chip';
  chip.setAttribute('role', 'group');
  chip.setAttribute('aria-label', 'Prototype view');
  // Wide variant is hidden from the chip for now — focus is on Compact.
  // Components gallery still shows both variants for design reference.
  chip.innerHTML = `
    <button class="proto-chip__btn" data-view-toggle="components">Components</button>
  `;
  document.body.appendChild(chip);

  function setVariant(variant) {
    if (!VARIANT_OPTIONS.includes(variant)) variant = 'wide';
    document.body.classList.remove('variant-wide', 'variant-compact');
    document.body.classList.add(`variant-${variant}`);
    // Mirror the variant onto the listener element so the same CSS
    // selectors work for live and for the gallery previews (which use
    // the modifier class without the body context).
    if (typeof listenerSurface !== 'undefined' && listenerSurface) {
      listenerSurface.classList.remove('proto-listener--variant-wide', 'proto-listener--variant-compact');
      listenerSurface.classList.add(`proto-listener--variant-${variant}`);
    }
    chip.querySelectorAll('[data-variant]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.variant === variant);
    });
    try { localStorage.setItem(STORAGE_VARIANT, variant); } catch (e) {}
  }

  function setView(view) {
    if (view !== 'components') view = 'listener';
    document.body.classList.remove('view-components', 'view-listener');
    document.body.classList.add(`view-${view}`);
    chip.querySelectorAll('[data-view-toggle]').forEach((b) => {
      b.classList.toggle('is-active', view === 'components');
      b.innerHTML = view === 'components'
        ? '<svg class="proto-chip__arrow" viewBox="0 0 12 12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m7 3-3 3 3 3"/></svg><span>Back</span>'
        : '<span>Components</span>';
    });
    try { localStorage.setItem(STORAGE_VIEW, view); } catch (e) {}
    if (typeof machine !== 'undefined' && machine.state === 'listening') startMeter();
    if (typeof reconcileListenerPatientGate === 'function') reconcileListenerPatientGate();
  }
  chip.addEventListener('click', (e) => {
    const variantBtn = e.target.closest('[data-variant]');
    if (variantBtn) { setVariant(variantBtn.dataset.variant); return; }
    const toggleBtn = e.target.closest('[data-view-toggle]');
    if (toggleBtn) {
      const onComponents = document.body.classList.contains('view-components');
      setView(onComponents ? 'listener' : 'components');
    }
  });

  // -------- 1b. Background switcher (bottom-centre) ---------------------
  // Two-state toggle between the default colourful mesh ("light") and a
  // dark mesh that uses the same anchor colours so the Listener can be
  // checked against both. Selection persists in localStorage.
  const bgSwitch = document.createElement('div');
  bgSwitch.className = 'proto-bg-switch';
  bgSwitch.setAttribute('role', 'radiogroup');
  bgSwitch.setAttribute('aria-label', 'Desktop background theme');
  bgSwitch.innerHTML = `
    <button class="proto-bg-switch__swatch proto-bg-switch__swatch--light" data-bg="light" aria-label="Light theme background"></button>
    <button class="proto-bg-switch__swatch proto-bg-switch__swatch--dark"  data-bg="dark"  aria-label="Dark theme background"></button>
  `;
  document.body.appendChild(bgSwitch);

  function setBg(name) {
    if (!BG_OPTIONS.includes(name)) name = 'light';
    document.body.classList.remove('bg-light', 'bg-dark');
    document.body.classList.add(`bg-${name}`);
    bgSwitch.querySelectorAll('[data-bg]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.bg === name);
    });
    try { localStorage.setItem(STORAGE_BG, name); } catch (e) {}
  }
  bgSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bg]');
    if (btn) setBg(btn.dataset.bg);
  });
  try {
    const savedBg = localStorage.getItem(STORAGE_BG);
    setBg(savedBg && BG_OPTIONS.includes(savedBg) ? savedBg : 'light');
  } catch (e) { setBg('light'); }

  // -------- 2. Replica toolbar (Figma Panel 2.0 + Ask) -------------------
  // Structure: a wrapper with the 4 buttons + 1 Menu, all 44×44 (Menu 52×44),
  // outer wrapper bg #034E8E, buttons bg #1671BE, 8px radius, inset shadows.
  const toolbarWrap = document.getElementById('toolbarWrap');
  if (!toolbarWrap) return;

  const replicaToolbar = document.createElement('div');
  replicaToolbar.className = 'proto-toolbar';
  replicaToolbar.setAttribute('role', 'toolbar');
  replicaToolbar.setAttribute('aria-label', 'C the Signs toolbar (replica)');
  replicaToolbar.innerHTML = `
    <div class="proto-tb-wrap">
      <div class="proto-tb-primary">
        <button class="proto-tb-btn" type="button" data-proto-btn="patient" aria-label="Patient" data-tooltip="Patient">
          <svg class="proto-tb-icon"><use href="#fic-patient"/></svg>
        </button>
        <button class="proto-tb-btn" type="button" data-proto-btn="dashboard" aria-label="Dashboard" data-tooltip="Dashboard">
          <svg class="proto-tb-icon"><use href="#fic-dashboard"/></svg>
        </button>
        <button class="proto-tb-btn" type="button" data-proto-btn="inbox" aria-label="Inbox" data-tooltip="Inbox">
          <svg class="proto-tb-icon"><use href="#fic-inbox"/></svg>
        </button>
        <button class="proto-tb-btn proto-tb-btn--mic" type="button" data-proto-btn="mic" data-listener-vis-toggle="1" aria-label="Toggle Listener" data-tooltip="Listener">
          <span class="proto-tb-icon proto-tb-mic" aria-hidden="true">
            <svg class="proto-tb-mic-ic proto-tb-mic-ic--plain"><use href="#fic-mic-tb"/></svg>
            <svg class="proto-tb-mic-ic proto-tb-mic-ic--active"><use href="#fic-mic-tb-active"/></svg>
            <span class="proto-tb-mic-bars"><span></span><span></span><span></span><span></span><span></span></span>
          </span>
          <span class="proto-tb-mic-count proto-tb-mic-count--empty" aria-hidden="true"></span>
        </button>
      </div>
      <button class="proto-tb-btn proto-tb-menu" type="button" data-proto-btn="menu" aria-label="Menu" data-tooltip="Menu">
        <svg class="proto-tb-icon proto-tb-icon--menu"><use href="#fic-menu-cts"/></svg>
      </button>
      <div class="proto-tb-handle" role="button" tabindex="0" aria-label="Drag toolbar" data-tooltip="Drag to move">
        <svg class="proto-tb-grip" aria-hidden="true"><use href="#fic-grip-v"/></svg>
      </div>
    </div>
  `;
  toolbarWrap.appendChild(replicaToolbar);

  // -------- 3. Feed surface (the only ambient surface) -------------------
  // Structured ambient surface — single horizontal row: logo + transcript
  // feed + risk counter + Pause + Stop pill + Mic settings + drag handle.
  // Drag handle is the anchor: state changes grow/shrink the bar leftward
  // while the handle stays put (see ensureListenerPositioned + listenerDrag*).
  function buildListenerSurface() {
    const root = document.createElement('div');
    root.className = 'proto-listener';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'C the Signs Listener');
    root.innerHTML = `
      <div class="proto-listener__wrap">
        <div class="proto-listener__container">
          <!-- IDLE: combined Listen + Lang CTA (per Figma 13459:39419)
               One purple-gradient capsule with two separate click areas:
                 • Left half  → Listen (start session)
                 • Right half → Language dropdown (EN/ES/UK)
               Divided by a 2 px white-25% line. The settings gear sits
               outside the CTA. Opening a patient still auto-starts the
               session straight from idle. -->
          <div class="proto-listener__idle">
            <div class="proto-listener__cta">
              <button class="proto-listener__cta-listen" type="button" data-proto-action="toggle" aria-label="Start listening" data-tooltip="Start listening">
                <span class="proto-listener__listen-ic" aria-hidden="true"></span>
                <span class="proto-listener__listen-label">Listen</span>
              </button>
              <span class="proto-listener__cta-divider" aria-hidden="true"></span>
              <div class="proto-listener__lang" data-listener-action="lang-toggle">
                <button class="proto-listener__cta-lang proto-listener__lang-btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Patient language" data-tooltip="Patient language">
                  <span class="proto-listener__lang-value">EN</span>
                  <svg class="proto-listener__lang-chev" aria-hidden="true" viewBox="0 0 12 12">
                    <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m3 5 3 3 3-3"/>
                  </svg>
                </button>
                <div class="proto-listener__lang-menu" hidden role="listbox">
                  <button class="proto-listener__lang-option" type="button" role="option" data-lang="en-GB">English</button>
                  <button class="proto-listener__lang-option" type="button" role="option" data-lang="es-ES">Spanish</button>
                  <button class="proto-listener__lang-option" type="button" role="option" data-lang="uk-UA">Ukrainian</button>
                </div>
              </div>
            </div>
          </div>
          <!-- ACTIVE: status button (transcript + counter) + controls (no mic settings here — see persistent button below) -->
          <div class="proto-listener__active">
            <button class="proto-listener__session" type="button" data-listener-action="open-summary" data-tooltip="AI transcript">
              <span class="proto-listener__logo proto-listener__logo--lg" aria-hidden="true">
                <svg viewBox="0 0 28 28"><use href="#fic-menu-cts"/></svg>
              </span>
              <!-- Voice equaliser — used in the Expanded variant. 5 bars
                   animate when listening; in Paused they freeze in a
                   "--II-" pattern that reads as a pause icon. -->
              <span class="proto-listener__bars" aria-hidden="true">
                <span></span><span></span><span></span><span></span><span></span>
              </span>
              <span class="proto-listener__transcript">
                <span class="proto-listener__transcript-text" aria-live="polite"></span>
                <span class="proto-listener__status-label proto-listener__status-label--listening">Listening…</span>
                <span class="proto-listener__status-label proto-listener__status-label--paused">Paused</span>
              </span>
              <span class="proto-listener__counter proto-listener__counter--empty" aria-label="Risk factors detected" data-tooltip="Cancer risk factors detected"></span>
            </button>
            <div class="proto-listener__controls">
              <!-- LISTENING: Pause icon. Hidden in paused. -->
              <button class="proto-listener__pause" type="button" data-proxy="tbPause" aria-label="Pause listening" data-tooltip="Pause">
                <svg class="proto-listener__ic"><use href="#fic-pause-sm"/></svg>
              </button>
              <!-- Primary pill — morphs between "Stop" (listening) and
                   "Resume" (paused). Same element so the transition is
                   smooth — only icon + label spans swap. -->
              <button class="proto-listener__primary" type="button" data-proto-action="toggle" aria-label="Stop listening" data-tooltip="End session">
                <svg class="proto-listener__primary-ic proto-listener__primary-ic--stop"><use href="#fic-stop-sm"/></svg>
                <span class="proto-listener__primary-rec" aria-hidden="true"></span>
                <span class="proto-listener__primary-label proto-listener__primary-label--stop">Stop</span>
                <span class="proto-listener__primary-label proto-listener__primary-label--resume">Resume</span>
                <span class="proto-listener__primary-time">0:00</span>
              </button>
              <!-- PAUSED: icon-only Stop (ends the session). Hidden in listening. -->
              <button class="proto-listener__stop-paused" type="button" data-listener-action="stop" aria-label="End session" data-tooltip="End session">
                <svg class="proto-listener__ic"><use href="#fic-stop-sm"/></svg>
              </button>
            </div>
          </div>
        </div>
        <!-- PERSISTENT mic settings — bottom-aligned, shared across idle/active.
             Sitting outside both row containers means the same DOM element
             stays in place as the bar morphs between states, so the gear
             icon never visually shifts relative to the drag handle.
             When a phone has been paired via the popover the gear icon
             swaps for a phone glyph (see body.phone-connected rule). -->
        <button class="proto-listener__settings" type="button" data-listener-action="mic-settings" aria-label="Microphone settings" data-tooltip="Microphone settings">
          <svg class="proto-listener__ic proto-listener__settings-ic proto-listener__settings-ic--gear"><use href="#fic-mic-settings-sm"/></svg>
          <svg class="proto-listener__ic proto-listener__settings-ic proto-listener__settings-ic--phone"><use href="#fic-phone-sm"/></svg>
        </button>
        <div class="proto-listener__handle" role="button" tabindex="0" aria-label="Drag" data-tooltip="Drag to move">
          <svg class="proto-listener__ic"><use href="#fic-grip-v"/></svg>
        </div>
      </div>

      <!-- Mic Settings popover — anchored below the gear button -->
      <div class="proto-listener__popover" hidden role="menu" aria-label="Microphone settings">
        <div class="proto-listener__pop-issue" hidden>
          <span>Microphone is blocked — open browser settings to enable</span>
        </div>
        <div class="proto-listener__pop-section">Microphone</div>
        <button class="proto-listener__pop-device proto-listener__pop-device--active" type="button" data-listener-device="device-1">
          <svg class="proto-listener__pop-check"><use href="#fic-check-sm"/></svg>
          <span class="proto-listener__pop-device-name">Chromebook Microphone</span>
          <span class="proto-listener__pop-meter" aria-hidden="true">
            <span data-listener-band="0"></span><span data-listener-band="1"></span><span data-listener-band="2"></span><span data-listener-band="3"></span><span data-listener-band="4"></span>
          </span>
        </button>
        <button class="proto-listener__pop-device" type="button" data-listener-device="device-2">
          <span class="proto-listener__pop-check proto-listener__pop-check--placeholder"></span>
          <span class="proto-listener__pop-device-name">Microsoft Teams Audio Device</span>
        </button>
        <div class="proto-listener__pop-section">Use your phone</div>
        <button class="proto-listener__pop-action" type="button" data-proxy="tbPhone">
          <svg class="proto-listener__pop-icon"><use href="#fic-phone-sm"/></svg>
          <span class="proto-listener__pop-device-name">Connect with QR code</span>
        </button>
      </div>
    `;
    return root;
  }

  const listenerSurface = buildListenerSurface();
  // Lives on body (not inside toolbarWrap) so it drags independently of the
  // replica toolbar. In Feed direction both elements are visible — Toolbar
  // and Ambient controls are two separate, individually-draggable surfaces.
  document.body.appendChild(listenerSurface);

  // Toolbar Mic button — shows the live session state via its bars, and
  // toggles the Listener's visibility on click. Looked up once here so
  // the closure-scoped `render()` in the state machine can update its
  // `data-state` without re-querying.
  const toolbarMicBtn = replicaToolbar.querySelector('[data-listener-vis-toggle]');

  // ---- Listener visibility (toolbar Mic button toggle) -------------------
  // The Listener bar is shown/hidden by adding `listener-hidden` on the
  // body — the session itself keeps running while hidden (STT, timer,
  // counter, transcript all unaffected). Default first load = HIDDEN; user
  // taps the toolbar Mic to reveal. Choice persists to localStorage.
  function loadListenerVisibility() {
    try {
      const v = localStorage.getItem(STORAGE_LISTENER_VIS);
      if (v === 'shown') return true;
      if (v === 'hidden') return false;
    } catch (e) {}
    return false;
  }
  function applyListenerVisibility(visible) {
    document.body.classList.toggle('listener-hidden', !visible);
    if (toolbarMicBtn) toolbarMicBtn.classList.toggle('is-on', visible);
    try { localStorage.setItem(STORAGE_LISTENER_VIS, visible ? 'shown' : 'hidden'); } catch (e) {}
  }
  if (toolbarMicBtn) {
    toolbarMicBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const hidden = document.body.classList.contains('listener-hidden');
      applyListenerVisibility(hidden);   // toggle
    });
  }
  // Apply saved (or default-hidden) state immediately so the bar doesn't
  // flash on first paint.
  applyListenerVisibility(loadListenerVisibility());

  // -------- 3b. Components gallery (view = components) ------------------
  // Non-interactive showcase of the main building blocks. Each card holds a
  // freshly-built static representation — IDs stripped so they don't clash
  // with the live UI above. Buttons inside the cards are not wired up.
  function buildToolbarPreview() {
    return `
      <div class="proto-toolbar proto-toolbar--preview">
        <div class="proto-tb-wrap">
          <div class="proto-tb-primary">
            <button class="proto-tb-btn"><svg class="proto-tb-icon"><use href="#fic-patient"/></svg></button>
            <button class="proto-tb-btn"><svg class="proto-tb-icon"><use href="#fic-dashboard"/></svg></button>
            <button class="proto-tb-btn"><svg class="proto-tb-icon"><use href="#fic-inbox"/></svg></button>
            <button class="proto-tb-btn proto-tb-btn--mic">
              <span class="proto-tb-icon proto-tb-mic" aria-hidden="true">
                <svg class="proto-tb-mic-ic proto-tb-mic-ic--plain"><use href="#fic-mic-tb"/></svg>
                <svg class="proto-tb-mic-ic proto-tb-mic-ic--active"><use href="#fic-mic-tb-active"/></svg>
                <span class="proto-tb-mic-bars"><span></span><span></span><span></span><span></span><span></span></span>
              </span>
            </button>
          </div>
          <button class="proto-tb-btn proto-tb-menu">
            <svg class="proto-tb-icon proto-tb-icon--menu"><use href="#fic-menu-cts"/></svg>
          </button>
          <div class="proto-tb-handle">
            <svg class="proto-tb-grip" aria-hidden="true"><use href="#fic-grip-v"/></svg>
          </div>
        </div>
      </div>
    `;
  }

  function buildListenerPreview(state, opts = {}) {
    const variant = opts.variant || 'wide';
    // Static rendering of the Feed surface in a given state — no event
    // handlers, no observers. The `--state-*` modifier classes opt into
    // the per-state CSS variants without relying on the body's state class.
    const transcript = opts.transcript || '';
    const count = opts.count != null ? opts.count : 0;
    const time = opts.time || '0:00';
    const isHigh = count >= 3;
    const counterClass = count <= 0 ? 'proto-listener__counter--empty' : (isHigh ? 'is-high' : '');
    const counterText = count <= 0 ? '0' : (count >= 100 ? '99+' : String(count));

    const idleBody = `
      <div class="proto-listener__idle" style="display: flex;">
        <div class="proto-listener__cta">
          <button class="proto-listener__cta-listen" type="button" tabindex="-1">
            <span class="proto-listener__listen-ic" aria-hidden="true"></span>
            <span class="proto-listener__listen-label">Listen</span>
          </button>
          <span class="proto-listener__cta-divider" aria-hidden="true"></span>
          <div class="proto-listener__lang">
            <button class="proto-listener__cta-lang proto-listener__lang-btn" type="button" aria-expanded="false" tabindex="-1">
              <span class="proto-listener__lang-value">EN</span>
              <svg class="proto-listener__lang-chev" aria-hidden="true" viewBox="0 0 12 12">
                <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m3 5 3 3 3-3"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;

    const activeBody = (s) => {
      const isPaused = s === 'paused';
      const statusLabel = !isPaused
        ? '<span class="proto-listener__status-label proto-listener__status-label--listening" style="display:flex">Listening…</span>'
        : '<span class="proto-listener__status-label proto-listener__status-label--paused" style="display:flex; background:transparent; padding-right:0;">Paused</span>';
      const transcriptDisplay = isPaused ? 'none' : 'flex';
      // Listening: Pause icon visible, Stop pill primary, stop-paused hidden.
      // Paused: Pause icon hidden, Resume pill primary (record-outline + "Resume"), stop-paused (icon) visible.
      const pauseDisplay = isPaused ? 'none' : 'inline-flex';
      const stopPausedDisplay = isPaused ? 'inline-flex' : 'none';
      const stopIcDisplay = isPaused ? 'none' : 'inline-flex';
      const recDisplay = isPaused ? 'inline-block' : 'none';
      const stopLabelDisplay = isPaused ? 'none' : 'inline-flex';
      const resumeLabelDisplay = isPaused ? 'inline-flex' : 'none';

      return `
        <div class="proto-listener__active" style="display: flex; flex-direction: row; align-items: center; gap: 4px;">
          <button class="proto-listener__session" type="button" tabindex="-1">
            <span class="proto-listener__logo proto-listener__logo--lg" aria-hidden="true">
              <svg viewBox="0 0 28 28"><use href="#fic-menu-cts"/></svg>
            </span>
            <span class="proto-listener__bars" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
            <span class="proto-listener__transcript">
              <span class="proto-listener__transcript-text" style="display:${transcriptDisplay}">${transcript}</span>
              ${statusLabel}
            </span>
            <span class="proto-listener__counter ${counterClass}">${counterText}</span>
          </button>
          <div class="proto-listener__controls">
            <button class="proto-listener__pause" type="button" tabindex="-1" style="display:${pauseDisplay}">
              <svg class="proto-listener__ic"><use href="#fic-pause-sm"/></svg>
            </button>
            <button class="proto-listener__primary" type="button" tabindex="-1">
              <svg class="proto-listener__primary-ic proto-listener__primary-ic--stop" style="display:${stopIcDisplay}"><use href="#fic-stop-sm"/></svg>
              <span class="proto-listener__primary-rec" style="display:${recDisplay}"></span>
              <span class="proto-listener__primary-label proto-listener__primary-label--stop" style="display:${stopLabelDisplay}">Stop</span>
              <span class="proto-listener__primary-label proto-listener__primary-label--resume" style="display:${resumeLabelDisplay}">Resume</span>
              <span class="proto-listener__primary-time">${time}</span>
            </button>
            <button class="proto-listener__stop-paused" type="button" tabindex="-1" style="display:${stopPausedDisplay}">
              <svg class="proto-listener__ic"><use href="#fic-stop-sm"/></svg>
            </button>
          </div>
        </div>
      `;
    };

    let body;
    if (state === 'idle') body = idleBody;
    else body = activeBody(state);

    return `
      <div class="proto-listener proto-listener--preview proto-listener--variant-${variant} proto-listener--state-${state}" data-state="${state}">
        <div class="proto-listener__wrap">
          <div class="proto-listener__container">
            ${body}
          </div>
          <button class="proto-listener__settings" type="button" tabindex="-1">
            <svg class="proto-listener__ic"><use href="#fic-mic-settings-sm"/></svg>
          </button>
          <div class="proto-listener__handle">
            <svg class="proto-listener__ic"><use href="#fic-grip-v"/></svg>
          </div>
        </div>
      </div>
    `;
  }

  function buildComponentsGallery() {
    const root = document.createElement('div');
    root.className = 'proto-components';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Components gallery');
    root.innerHTML = `
      <header class="proto-components__head">
        <h1>Components</h1>
        <p>Non-interactive previews of the main UI building blocks in this prototype. For reviewing surface inventory — not a behaviour spec.</p>
      </header>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Toolbar</h2>
          <p>Figma-aligned replica. Patient · Dashboard · Inbox · Ask · Menu, plus the 8-dot drag handle.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--toolbar">
          ${buildToolbarPreview()}
        </div>
        <footer class="proto-comp__foot">
          <p><strong>States:</strong> default · hover · pressed (yellow ribbon + 1 px push) · keyboard focus · opened (darker tile, no ribbon) · disabled.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Listener — Wide</h2>
          <p>Single-row horizontal layout. Status, controls and counter all sit in one line: <strong>Logo · Listening/Paused · Transcript · Counter · Pause · Stop · Mic settings</strong>. Idle uses the combined purple Listen + Lang CTA.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--feed">
          <div class="proto-comp__feed-row">
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Idle</span>
              ${buildListenerPreview('idle', { variant: 'wide' })}
            </div>
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Listening</span>
              ${buildListenerPreview('listening', { variant: 'wide', transcript: 'abdominal uh like in the stomach', count: 3, time: '4:18' })}
            </div>
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Paused</span>
              ${buildListenerPreview('paused', { variant: 'wide', count: 3, time: '4:18' })}
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Wide is the default; the right edge stays pinned across state morphs so the drag handle and Mic Settings don't move.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Listener — Compact</h2>
          <p>Two-row layered build. Status row (voice equaliser + label + transcript with edge-mask) sits transparent on the dark wrap; control row below holds the Pause / Resume + Stop + Mic settings. <strong>Risk counter floats outside the wrap</strong> as a notification badge — the status row never resizes. On Paused the equaliser freezes into a "--II-" pause-icon pattern.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--feed">
          <div class="proto-comp__feed-row">
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Idle</span>
              ${buildListenerPreview('idle', { variant: 'compact' })}
            </div>
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Listening</span>
              ${buildListenerPreview('listening', { variant: 'compact', transcript: 'and some text that listen', count: 3, time: '4:18' })}
            </div>
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Paused</span>
              ${buildListenerPreview('paused', { variant: 'compact', transcript: 'and some text that listen', count: 1, time: '1:21' })}
            </div>
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Mic Settings menu</span>
              <div class="proto-listener proto-listener--preview proto-listener--menu-preview">
                <div class="proto-listener__popover proto-listener__popover--inline" role="menu" aria-label="Microphone settings">
                  <div class="proto-listener__pop-section">Microphone</div>
                  <button class="proto-listener__pop-device proto-listener__pop-device--active" type="button">
                    <svg class="proto-listener__pop-check"><use href="#fic-check-sm"/></svg>
                    <span class="proto-listener__pop-device-name">Chromebook Microphone</span>
                    <span class="proto-listener__pop-meter" aria-hidden="true">
                      <span data-listener-band="0"></span><span data-listener-band="1"></span><span data-listener-band="2"></span><span data-listener-band="3"></span><span data-listener-band="4"></span>
                    </span>
                  </button>
                  <button class="proto-listener__pop-device" type="button">
                    <span class="proto-listener__pop-check proto-listener__pop-check--placeholder"></span>
                    <span class="proto-listener__pop-device-name">Microsoft Teams Audio Device</span>
                  </button>
                  <div class="proto-listener__pop-section">Use your phone</div>
                  <button class="proto-listener__pop-action" type="button">
                    <svg class="proto-listener__pop-icon"><use href="#fic-phone-sm"/></svg>
                    <span class="proto-listener__pop-device-name">Connect with QR code</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Drag handle on the right side anchors the bar — state changes resize the bar leftward so the handle stays in place. Mic Settings menu opens from the gear icon and lets the clinician switch microphone or connect their phone as the source.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Phone-as-microphone</h2>
          <p>Opens from the Listener's mic-settings popover via "Connect with QR code". Steps, a QR, a copyable link, and a status row that flips to <em>Phone connected ✓</em> when the handshake completes. After connection the Listener's gear icon swaps to a phone glyph so the bar surfaces the source at a glance.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--modal">
          <div class="proto-comp__modal-preview proto-comp__modal-preview--phone">
            <header class="patient-bar patient-bar--simple">
              <svg class="ic ic--lg"><use href="#ic-phone"/></svg>
              <strong>Use your phone as microphone</strong>
              <span class="spacer"></span>
              <button class="icon-btn icon-btn--light" tabindex="-1"><svg class="ic"><use href="#ic-close"/></svg></button>
            </header>
            <div class="modal-body phone-body">
              <ol class="phone-steps">
                <li>Open the camera on your phone and scan the QR code below.</li>
                <li>Tap the link that appears. The phone opens a small microphone page.</li>
                <li>Tap <em>Start listening</em> on the phone. Place the phone where you want to capture audio.</li>
                <li>Your phone's transcription streams to this laptop — detections appear here.</li>
              </ol>
              <div class="phone-qr-wrap">
                <div class="phone-qr-mock" role="img" aria-label="QR code preview"></div>
                <div class="phone-status">
                  <div class="phone-status-row">
                    <span class="dot dot--idle"></span>
                    <span class="phone-status-label">Waiting for phone to connect…</span>
                  </div>
                  <div class="phone-url">
                    <span class="muted">Link:</span>
                    <code>cthesigns.example/?mic=peer-id</code>
                    <button class="btn btn--ghost btn--xs" tabindex="-1">Copy</button>
                  </div>
                  <p class="muted phone-tip">Phone needs to be on Chrome (Android) or Safari (iOS) and have internet access. The link works on the same Wi-Fi <em>or</em> over the internet.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Lives at <code>#phoneOverlay</code>. On handshake, <code>app.js</code> flips <code>#tbPhone.is-connected</code>; <code>prototype.js</code> mirrors that onto <code>body.phone-connected</code> so the Listener gear ↔ phone glyph swap persists after the modal closes.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Risk Assessment modal</h2>
          <p>Multi-factor selection with search + A–Z navigation. Reached from the Summary modal via "Start risk assessment".</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--modal">
          <div class="proto-comp__modal-preview proto-comp__modal-preview--ra">
            <header class="patient-bar">
              <svg class="ic ic--lg"><use href="#ic-butterfly"/></svg>
              <span class="patient-name"><span class="muted">Mrs.</span> <strong>Stone, Emma</strong></span>
              <span class="patient-meta">69yrs · 18 Jun 1955</span>
              <span class="spacer"></span>
              <span class="nhs-tag">NHS</span>
              <span class="patient-id">271 212 7328</span>
              <button class="icon-btn icon-btn--light"><svg class="ic"><use href="#ic-close"/></svg></button>
            </header>
            <div class="ra-body">
              <div class="ra-selected-row">
                <span class="proto-comp__chip">Persistent cough ✕</span>
                <span class="proto-comp__chip">Weight loss ✕</span>
              </div>
              <div class="ra-toolbar">
                <div class="ra-search">
                  <svg class="ic"><use href="#ic-search"/></svg>
                  <input type="search" placeholder="Type factors, symptoms, sign, or investigations" disabled />
                </div>
                <button class="btn btn--primary btn--large">Proceed <svg class="ic ic--sm"><use href="#ic-chevron"/></svg></button>
              </div>
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Currently lives at <code>#raOverlay</code>. Reached from the Summary's "Start risk assessment" CTA.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Session Summary</h2>
          <p>Feed-direction variant of the Risk Summary. Two-column body: full transcript on the left with detected phrases highlighted, factors sidebar on the right. CTA proceeds to the Risk Assessment flow.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--modal">
          <div class="proto-comp__modal-preview proto-comp__modal-preview--session">
            <header class="patient-bar">
              <span class="nhs-tag">NHS</span>
              <span class="patient-id">123 456 7890</span>
              <span class="patient-name"><span class="muted">Mr.</span> <strong>Willington, Albert</strong></span>
              <span class="patient-meta-badge">M</span>
              <span class="patient-meta">59yrs</span>
              <span class="patient-meta">12 Nov 1967</span>
              <button class="icon-btn icon-btn--light"><svg class="ic"><use href="#ic-close"/></svg></button>
            </header>
            <div class="session-body">
              <div class="session-main">
                <div class="session-head">
                  <div class="summary-title-row">
                    <svg class="ic ic--sparkles"><use href="#ic-sparkles"/></svg>
                    <span class="eyebrow">Ambient AI</span>
                  </div>
                  <h2>Transcript</h2>
                  <p class="session-lede">Everything captured during the consultation so far. Phrases that match a known risk factor are highlighted in line — review the flagged moments in context, then take any factor forward to assessment.</p>
                </div>
                <div class="session-transcript">
                  <p>Right, so what brings you in today, Albert?</p>
                  <p>Well, doctor, I've been having this <mark class="kw kw--red">annoying little cough</mark> that just won't go away. It's been about three weeks now and it's getting worse. Sometimes I bring up a bit of phlegm with it, and once or twice it had a streak of blood in it which gave me a fright.</p>
                  <p>I see. And how have you been feeling otherwise?</p>
                  <p>To be honest I've been losing weight. I haven't been trying to, but my trousers are all loose and I reckon I've <mark class="kw kw--amber">lost about a stone</mark> in the last month or so. My wife noticed it before I did.</p>
                  <p>Any changes in your appetite?</p>
                  <p>Not really. I just feel a bit off food. And I'm <mark class="kw kw--purple">tired all the time</mark>, even after a full night's sleep. By the afternoon I'm done in.</p>
                  <p>Have you noticed anything else? Any pain, lumps, changes in your bowel habit?</p>
                  <p>No lumps. The other day I did notice that my <mark class="kw kw--blue">urine looked a bit pinkish</mark> but I thought maybe it was the beetroot we had. It hasn't happened again.</p>
                  <p>Okay, that's helpful. I'd like to ask you a few more questions and then examine you, if that's alright.</p>
                </div>
              </div>
              <aside class="session-side">
                <div class="session-side-head">
                  <span class="eyebrow">RISK FACTORS</span>
                  <span class="session-side-count">4</span>
                </div>
                <ul class="session-side-list">
                  <li>
                    <div>Persistent cough &gt; 3 weeks</div>
                    <span class="kw-pill">"annoying little cough"</span>
                  </li>
                  <li>
                    <div>Haemoptysis</div>
                    <span class="kw-pill">"a streak of blood"</span>
                  </li>
                  <li>
                    <div>Unintentional weight loss</div>
                    <span class="kw-pill">"lost about a stone"</span>
                  </li>
                  <li>
                    <div>Fatigue</div>
                    <span class="kw-pill">"tired all the time"</span>
                  </li>
                  <li>
                    <div>Haematuria</div>
                    <span class="kw-pill">"urine looked a bit pinkish"</span>
                  </li>
                </ul>
                <footer class="session-side-foot">
                  <button class="btn btn--primary btn--large">Risk assess <svg class="ic ic--sm"><use href="#ic-chevron"/></svg></button>
                </footer>
              </aside>
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Currently lives at <code>#sessionSummaryOverlay</code>. Trigger: clicking the Session row on the Feed surface (auto-pauses the session). Risk assess → proceeds into the existing <code>#raOverlay</code>.</p>
        </footer>
      </article>

    `;
    return root;
  }
  document.body.appendChild(buildComponentsGallery());

  // -------- 4. State machine ---------------------------------------------
  // Single source of truth for the recording lifecycle:
  //   idle → starting → listening ↔ paused
  //                          ↓
  //                       stopping → idle
  //
  // `starting` and `stopping` are short transitional states (300 ms each)
  // that give the indicator time to morph between idle and listening.
  // The underlying app.js action (#tbStart.click / #tbStop.click) fires
  // immediately on user input — the transition state only smooths the UI.
  //
  // Inputs that feed the machine:
  //   - User events on the proto pills (Start, Stop, Pause, Resume)
  //   - DOM mutations on #tbStart and #listenChip (so the machine still
  //     reconciles when app.js changes state for other reasons —
  //     "New patient open" sim, STT errors, etc.)
  const tbStart = document.getElementById('tbStart');
  const tbPause = document.getElementById('tbPause');
  const tbStop  = document.getElementById('tbStop');
  const tbPhone = document.getElementById('tbPhone');
  const listenChip = document.getElementById('listenChip');

  // Phone-as-microphone connection state — `app.js` flips `is-connected`
  // on `#tbPhone` when the popover's "Connect with QR" handshake
  // succeeds (and removes it on disconnect). Mirror that onto a body
  // class so the Listener's settings button can swap its gear glyph for
  // a phone glyph (see `body.phone-connected .proto-listener__settings-ic--*`).
  // Mirroring this way means the visual feedback persists on the bar
  // even after the popover is closed.
  function syncPhoneConnectedFlag() {
    const on = !!(tbPhone && tbPhone.classList.contains('is-connected'));
    document.body.classList.toggle('phone-connected', on);
    const settingsBtn = listenerSurface.querySelector('.proto-listener__settings');
    if (settingsBtn) {
      settingsBtn.setAttribute('data-tooltip', on ? 'Phone microphone connected' : 'Microphone settings');
      settingsBtn.setAttribute('aria-label', on ? 'Phone microphone connected — open settings' : 'Microphone settings');
    }
  }
  if (tbPhone) {
    new MutationObserver(syncPhoneConnectedFlag).observe(tbPhone, {
      attributes: true,
      attributeFilter: ['class'],
    });
    syncPhoneConnectedFlag();
  }

  const RECORDING_STATES = ['idle', 'starting', 'listening', 'paused', 'stopping'];
  const TRANSITION_MS = 180;
  const LABELS = {
    idle:      'Start listening',
    starting:  'Starting…',
    listening: 'Stop listening',
    paused:    'Resume listening',
    stopping:  'Stopping…',
  };

  function fmtTimer(secs) {
    secs = Math.max(0, Math.floor(secs));
    const s = secs % 60;
    const m = Math.floor(secs / 60) % 60;
    const h = Math.floor(secs / 3600);
    const ss = String(s).padStart(2, '0');
    if (h) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
  }

  // Timer accumulator — counts only seconds spent in 'listening'
  let elapsedAccum = 0;
  let segmentStart = 0;
  let tickId = null;
  function paintTimer() {
    const now = performance.now();
    const live = (machine.state === 'listening' && segmentStart) ? (now - segmentStart) : 0;
    const text = fmtTimer((elapsedAccum + live) / 1000);
    document.querySelectorAll('.proto-ai__primary-meta').forEach((el) => {
      el.textContent = text;
    });
  }
  function startTick() {
    if (tickId) return;
    tickId = setInterval(paintTimer, 250);
  }
  function stopTick() {
    if (!tickId) return;
    clearInterval(tickId);
    tickId = null;
  }

  const machine = (() => {
    let state = 'idle';
    let transitionTimer = null;

    function clearTransitionTimer() {
      if (transitionTimer) {
        clearTimeout(transitionTimer);
        transitionTimer = null;
      }
    }

    function isTransitional() {
      return state === 'starting' || state === 'stopping';
    }

    function set(next) {
      if (!RECORDING_STATES.includes(next) || next === state) return;
      clearTransitionTimer();
      const prev = state;
      state = next;
      render(prev, next);
      // Auto-advance from transient states
      if (next === 'starting') {
        transitionTimer = setTimeout(() => set('listening'), TRANSITION_MS);
      } else if (next === 'stopping') {
        transitionTimer = setTimeout(() => set('idle'), TRANSITION_MS);
      }
    }

    function render(prev, next) {
      RECORDING_STATES.forEach((s) => {
        document.body.classList.toggle(`proto-${s}`, s === next);
      });
      // Mirror machine state onto the listener element via data-state so
      // variant CSS rules can target a single source for both live and
      // gallery preview (previews set data-state directly in markup).
      if (typeof listenerSurface !== 'undefined' && listenerSurface) {
        listenerSurface.dataset.state = next;
      }
      // Same data-state on the toolbar Mic button so its bars track the
      // session state (animate while listening, freeze in pause pattern,
      // disappear in idle). Same source-of-truth, no extra wiring.
      if (toolbarMicBtn) {
        toolbarMicBtn.dataset.state = next;
      }

      // Primary pill label + aria
      const label = LABELS[next];
      document.querySelectorAll('.proto-ai__primary-label').forEach((el) => {
        el.textContent = label;
      });
      document.querySelectorAll('.proto-ai__primary').forEach((b) => {
        b.setAttribute('aria-label', label);
      });

      // Timer meta visibility — shown for any state where the timer reading
      // is meaningful: listening (live), paused (frozen), stopping (final
      // value briefly visible). Hidden in idle and starting (no value yet).
      const showMeta = next === 'listening' || next === 'paused' || next === 'stopping';
      document.querySelectorAll('.proto-ai__primary-meta').forEach((el) => {
        el.hidden = !showMeta;
      });

      // Timer accounting
      const wasListening = prev === 'listening';
      const isListening = next === 'listening';
      if (isListening && !wasListening) {
        // Fresh start = reset accumulator; resume from pause = keep it
        if (prev !== 'paused' && prev !== 'starting') elapsedAccum = 0;
        if (prev === 'starting' && elapsedAccum === 0 && prev !== 'paused') {
          // Coming from starting, but the starting may itself have followed
          // either idle or paused. Use a marker we set on entering starting.
        }
        segmentStart = performance.now();
        startTick();
      } else if (!isListening && wasListening) {
        // Leaving listening — bank the segment
        elapsedAccum += performance.now() - segmentStart;
        segmentStart = 0;
        stopTick();
      }
      if (next === 'idle' || next === 'starting') {
        // Reset accumulator at the start of a fresh session. We do it on
        // the way INTO starting from idle, so the timer renders 0:00 when
        // listening kicks in. Resume from paused keeps accum.
        if (prev === 'idle' && next === 'starting') elapsedAccum = 0;
      }
      paintTimer();

      // Web Audio meter
      if (isListening) startMeter();
      else if (next !== 'paused') stopMeter();
    }

    function reconcileFromDOM() {
      // Skip reconciliation while in a transient state — the timer resolves it.
      if (isTransitional()) return;
      const isActive = !!(tbStart && tbStart.classList.contains('is-active'));
      const isPaused = !isActive &&
                       !!(listenChip && listenChip.classList.contains('is-paused')) &&
                       !!(listenChip && !listenChip.hidden);
      const want = isActive ? 'listening' : isPaused ? 'paused' : 'idle';
      if (want !== state) set(want);
    }

    // Apply the initial state's body class so derived selectors (e.g.
    // body.proto-idle.view-listener) work on first paint — set() itself short-
    // circuits when next === state, so we paint the baseline manually here.
    document.body.classList.add(`proto-${state}`);
    if (typeof listenerSurface !== 'undefined' && listenerSurface) {
      listenerSurface.dataset.state = state;
    }
    if (typeof toolbarMicBtn !== 'undefined' && toolbarMicBtn) {
      toolbarMicBtn.dataset.state = state;
    }

    return { get state() { return state; }, set, reconcileFromDOM };
  })();

  if (tbStart) {
    new MutationObserver(() => machine.reconcileFromDOM()).observe(tbStart, {
      attributes: true,
      attributeFilter: ['class', 'disabled'],
    });
  }
  if (listenChip) {
    new MutationObserver(() => machine.reconcileFromDOM()).observe(listenChip, {
      attributes: true,
      attributeFilter: ['class', 'hidden'],
    });
  }
  if (tbPhone) {
    new MutationObserver(() => {
      const isConn = tbPhone.classList.contains('is-connected');
      document.querySelectorAll('.proto-ai__phone').forEach((b) => {
        b.classList.toggle('is-connected', isConn);
      });
    }).observe(tbPhone, { attributes: true, attributeFilter: ['class'] });
  }

  // -------- 5. Click proxying — routes through the state machine --------
  // The proto pills set machine state intentionally; the underlying
  // tbStart/tbPause/tbStop actions fire alongside so app.js still owns
  // the audio pipeline.
  document.querySelectorAll('[data-proxy="tbPause"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (tbPause && !tbPause.disabled) tbPause.click();
      machine.set('paused');
    });
  });
  document.querySelectorAll('[data-proxy="tbPhone"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (tbPhone && !tbPhone.disabled) tbPhone.click();
    });
  });
  document.querySelectorAll('[data-proto-action="toggle"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Listening          → Stop (300ms 'stopping' transition then reset)
      // Idle / Paused      → Start (begin a session)
      // Starting / Stopping → ignore (already transitioning)
      const s = machine.state;
      if (s === 'listening') {
        machine.set('stopping');
        if (tbStop && !tbStop.disabled) tbStop.click();
      } else if (s === 'paused' || s === 'idle') {
        machine.set('starting');
        if (tbStart && !tbStart.disabled) tbStart.click();
      }
    });
  });

  // Replica toolbar buttons — visual only for now. No sticky "open" class:
  // press/release feedback comes purely from CSS :active. Production menus
  // can re-introduce a sticky state when the corresponding surface opens.

  // -------- Patient-context gate ----------------------------------------
  // Attached variant: AI surface only appears once a patient is opened.
  // Separate variant: AI surface is always visible (CSS handles that
  // override) and ignores this gate entirely.
  //
  // Triggers that flip the gate:
  //   1. Clicking the Patient button on the replica toolbar (toggle)
  //   2. Clicking "New patient open" in the existing status pill (set)
  //
  // While the gate is true, the Patient button shows a sticky "opened"
  // state — same darker bg as :active but WITHOUT the yellow underline
  // or icon shift (those are reserved for the pressed/keyboard-focus
  // states only).
  const PATIENT_KEY = 'ambient-ui-patient-open';
  const patientBtn = replicaToolbar.querySelector('[data-proto-btn="patient"]');
  // The Patient button is enabled only while a patient record is open
  // in the EHR — it represents the patient context, not an action that
  // opens a patient. Start disabled; flips to enabled as soon as the
  // simulated "Open patient" trigger fires.
  if (patientBtn) patientBtn.disabled = true;
  function setPatientOpen(open) {
    document.body.classList.toggle('patient-open', open);
    if (patientBtn) patientBtn.disabled = !open;
    try { sessionStorage.setItem(PATIENT_KEY, open ? '1' : '0'); } catch (e) {}
    reconcileListenerPatientGate();
  }
  // Opening a patient auto-starts the session straight from idle (no
  // primer step). If a session is already running we leave it alone.
  // Closing the patient stops any active session.
  //
  // `autoToggleInFlight` debounces back-to-back triggers (e.g. setPatientOpen
  // firing during a state transition) — without it, two fast open→close→open
  // toggles can call recognition.start() while the previous instance is
  // still tearing down, producing the "recognition has already started"
  // error in app.js.
  let autoToggleInFlight = false;
  function reconcileListenerPatientGate() {
    if (typeof machine === 'undefined') return;
    if (!document.body.classList.contains('view-listener')) return;
    if (autoToggleInFlight) return;
    const open = document.body.classList.contains('patient-open');
    const s = machine.state;
    const sessionActive = s === 'starting' || s === 'listening' || s === 'stopping';
    let fired = false;
    if (open && !sessionActive && s !== 'paused') {
      machine.set('starting');
      if (tbStart && !tbStart.disabled) { tbStart.click(); fired = true; }
    } else if (!open && sessionActive) {
      machine.set('stopping');
      if (tbStop && !tbStop.disabled) { tbStop.click(); fired = true; }
    } else if (!open && s === 'paused') {
      machine.set('idle');
    }
    if (fired) {
      autoToggleInFlight = true;
      setTimeout(() => { autoToggleInFlight = false; }, 500);
    }
    if (typeof ensureListenerPositioned === 'function') {
      requestAnimationFrame(ensureListenerPositioned);
    }
  }
  // The toolbar Patient button represents the EHR's (EMIS / S1) patient
  // context by proxy — it does NOT itself open a patient. Opening a
  // patient is simulated by the "Open patient" button on the technical
  // control panel (#btnNewPatient). The toolbar Patient button is
  // disabled when no patient is open and enabled (at rest) once one
  // is — see `setPatientOpen`.
  const newPatientBtn = document.getElementById('btnNewPatient');
  if (newPatientBtn) {
    newPatientBtn.addEventListener('click', () => setPatientOpen(true));
  }
  // Always start with no patient open. Previously we restored from
  // sessionStorage, but that meant every page load auto-fired the
  // listening flow (because patient-open → auto-start), which surprised
  // the user and could collide with app.js's fresh recognition init.
  // Patient context must be re-opened explicitly each session.
  try { sessionStorage.removeItem(PATIENT_KEY); } catch (e) {}

  // -------- Language dropdown — custom UI synced to #langPicker ---------
  // Custom dropdown (button + popover) for visual consistency with the
  // other Listener controls. The legacy #langPicker stays in the DOM and
  // is the source of truth for app.js's STT language — our dropdown
  // writes to it (+ dispatches `change`) so the underlying STT switches.
  const langPicker = document.getElementById('langPicker');
  const langWrap = listenerSurface.querySelector('.proto-listener__lang');
  const langBtn = listenerSurface.querySelector('.proto-listener__lang-btn');
  const langValue = listenerSurface.querySelector('.proto-listener__lang-value');
  const langMenu = listenerSurface.querySelector('.proto-listener__lang-menu');
  const langOptions = listenerSurface.querySelectorAll('.proto-listener__lang-option');

  function closeLangMenu() {
    if (!langMenu || langMenu.hidden) return;
    langMenu.hidden = true;
    if (langBtn) langBtn.setAttribute('aria-expanded', 'false');
  }
  function openLangMenu() {
    if (!langMenu) return;
    langMenu.hidden = false;
    if (langBtn) langBtn.setAttribute('aria-expanded', 'true');
  }
  // Two-letter ISO display codes for the combined CTA's lang half. The
  // dropdown options keep their full names for accessibility.
  const LANG_SHORT_CODES = { 'en-GB': 'EN', 'es-ES': 'ES', 'uk-UA': 'UK' };
  function syncLangFromPicker() {
    if (!langPicker || !langValue) return;
    const val = langPicker.value;
    langValue.textContent = LANG_SHORT_CODES[val] || (val || '').slice(0, 2).toUpperCase();
    langOptions.forEach((o) => {
      o.classList.toggle('is-selected', o.dataset.lang === val);
    });
  }

  if (langBtn) {
    langBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (langMenu.hidden) openLangMenu(); else closeLangMenu();
    });
  }
  langOptions.forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = opt.dataset.lang;
      if (langPicker && langPicker.value !== val) {
        langPicker.value = val;
        langPicker.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncLangFromPicker();
      closeLangMenu();
    });
  });
  document.addEventListener('click', (e) => {
    if (langWrap && !langWrap.contains(e.target)) closeLangMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLangMenu();
  });
  if (langPicker) {
    langPicker.addEventListener('change', syncLangFromPicker);
    syncLangFromPicker();
  }

  // -------- Status pill — service + patient state machine --------------
  // The pill has two distinct sections:
  //   • Service: API status (dot + text) + error banner when relevant.
  //   • Patient: "No patient open" → "Patient opened" with state-driven
  //     buttons (Open patient / Open another + Close).
  // Visibility per state is driven by `body.patient-open` (CSS) — the JS
  // just renders the markup once and wires the new actions.
  const statusPillEl = document.getElementById('statusPill');
  const sttStatusEl = document.getElementById('sttStatus');
  const newPatientPrimaryBtn = document.getElementById('btnNewPatient');
  if (statusPillEl && sttStatusEl) {
    // Rename the existing primary "New patient open" to "Open patient".
    if (newPatientPrimaryBtn) {
      const labelNode = Array.from(newPatientPrimaryBtn.childNodes).find(
        (n) => n.nodeType === 3 && n.textContent.trim()
      );
      if (labelNode) labelNode.textContent = ' Open patient';
    }

    // ----- Patient block FIRST (EHR Connection) -----
    let patientBlock = statusPillEl.querySelector('.status-pill__patient');
    if (!patientBlock) {
      patientBlock = document.createElement('div');
      patientBlock.className = 'status-pill__patient';
      patientBlock.innerHTML = `
        <div class="status-pill__patient-section">
          <span class="status-pill__eyebrow">EHR Connection</span>
          <div class="status-pill__patient-status">
            <span class="status-pill__patient-dot" aria-hidden="true"></span>
            <span class="status-pill__patient-label status-pill__patient-label--closed">No patient open</span>
            <span class="status-pill__patient-label status-pill__patient-label--opened">Patient opened</span>
          </div>
        </div>
      `;
      statusPillEl.appendChild(patientBlock);
      const actionsRow = statusPillEl.querySelector('.status-pill-actions');
      if (actionsRow) patientBlock.appendChild(actionsRow);
      const secondaryActions = document.createElement('div');
      secondaryActions.className = 'status-pill__patient-actions';
      secondaryActions.innerHTML = `
        <button class="status-pill__btn status-pill__btn--secondary" type="button" data-pill-action="open-another">Open another</button>
        <button class="status-pill__btn status-pill__btn--ghost"     type="button" data-pill-action="close-patient">Close</button>
      `;
      patientBlock.appendChild(secondaryActions);
      secondaryActions.querySelector('[data-pill-action="close-patient"]').addEventListener('click', () => {
        if (typeof setPatientOpen === 'function') setPatientOpen(false);
      });
      secondaryActions.querySelector('[data-pill-action="open-another"]').addEventListener('click', () => {
        if (typeof setPatientOpen === 'function') {
          setPatientOpen(false);
          setTimeout(() => setPatientOpen(true), 600);
        }
      });
    }

    // ----- Service block SECOND (Voice API) -----
    // The status text + banner are MOVED into this wrapper so any
    // voice-API error sits under its own section, not floating between
    // unrelated rows. Banner goes AFTER the status line so the error
    // reads as "this row failed because…".
    let serviceBlock = statusPillEl.querySelector('.status-pill__service');
    let banner;
    if (!serviceBlock) {
      serviceBlock = document.createElement('div');
      serviceBlock.className = 'status-pill__service';
      serviceBlock.innerHTML = `<span class="status-pill__eyebrow">Voice API</span>`;
      serviceBlock.appendChild(sttStatusEl);
      banner = document.createElement('div');
      banner.className = 'status-pill__banner';
      banner.innerHTML = `
        <svg class="status-pill__banner-ic" viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 3.25a.75.75 0 0 0-.75.75v3.5a.75.75 0 1 0 1.5 0V5.5A.75.75 0 0 0 8 4.75Zm0 5.75a.85.85 0 1 0 0 1.7.85.85 0 0 0 0-1.7Z"/>
        </svg>
        <span class="status-pill__banner-text"></span>
      `;
      serviceBlock.appendChild(banner);
      statusPillEl.appendChild(serviceBlock);
    } else {
      banner = serviceBlock.querySelector('.status-pill__banner');
    }
    const bannerText = banner.querySelector('.status-pill__banner-text');

    // ----- Status copy rewriting ---------------------------------------
    // app.js writes verbose, instruction-heavy strings into #sttStatus
    // ("Click Start...", "Click the mic..."). We re-render them into
    // calm, status-only copy. A short tip is appended to the error
    // banner when the issue is microphone permission.
    function classifyStatus(text) {
      const t = (text || '').toLowerCase();
      if (!t) return 'ready';
      if (/(error|denied|blocked|no microphone|unsupported|not available|network|could not)/.test(t)) return 'error';
      if (/(connect|loading|starting|warm|wait|translating|processing)/.test(t)) return 'loading';
      return 'ready';
    }
    function friendlyStatus(raw, state) {
      const t = (raw || '').trim();
      if (state === 'error') {
        if (/denied|blocked|permission/i.test(t))    return 'Microphone access blocked';
        if (/no microphone|input device/i.test(t))   return 'No microphone detected';
        if (/network/i.test(t))                       return 'Network error';
        if (/not available|unsupported/i.test(t))    return 'Speech recognition unavailable';
        if (/no speech/i.test(t))                     return 'No speech detected yet';
        if (/could not start/i.test(t))               return 'Could not start recognition';
        return 'Speech recognition error';
      }
      if (state === 'loading') {
        if (/translating/i.test(t)) return 'Translating speech';
        if (/processing/i.test(t))  return 'Processing';
        if (/hearing/i.test(t))     return 'Hearing speech';
        return 'Connecting';
      }
      // Ready states — strip "Click X" instructions.
      if (/listening/i.test(t))   return 'Listening for speech';
      if (/paused/i.test(t))      return 'Session paused';
      if (/captured/i.test(t))    return 'Captured';
      if (/mock/i.test(t))        return 'Mock input active';
      if (/llm connected/i.test(t)) return 'Local LLM connected';
      // Strip everything after a " · " separator (app.js's instruction tail)
      return t.replace(/\s*·.*$/, '').replace(/\.$/, '') || 'Speech recognition ready';
    }
    function tipForError(raw) {
      if (/denied|blocked|permission/i.test(raw)) {
        return 'Open this site in your browser and allow microphone access (click the lock icon in the address bar → Site settings → Microphone → Allow).';
      }
      if (/no microphone|input device/i.test(raw)) {
        return 'Check that a microphone is connected and selected as the input device.';
      }
      if (/network/i.test(raw)) {
        return 'Check your internet connection — speech recognition needs a working connection.';
      }
      if (/not available|unsupported/i.test(raw)) {
        return 'Try a Chromium-based browser (Chrome, Arc, Edge). Safari/Firefox don\'t support the Web Speech API.';
      }
      return '';
    }

    let lastWritten = '';
    function paintStatus() {
      const raw = sttStatusEl.textContent || '';
      // Ignore re-fires triggered by our own write.
      if (raw === lastWritten) return;
      const state = classifyStatus(raw);
      statusPillEl.dataset.state = state;
      const friendly = friendlyStatus(raw, state);
      if (bannerText) {
        if (state === 'error') {
          const tip = tipForError(raw);
          bannerText.innerHTML = `<strong class="status-pill__banner-headline">${friendly}</strong>` +
                                  (tip ? `<span class="status-pill__banner-tip">${tip}</span>` : '');
        } else {
          bannerText.textContent = '';
        }
      }
      lastWritten = friendly;
      if (sttStatusEl.textContent !== friendly) sttStatusEl.textContent = friendly;
    }
    new MutationObserver(paintStatus).observe(sttStatusEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    paintStatus();
  }

  // -------- Feed surface — observers + handlers --------------------------
  // Transcript feed: mirror text from #transcriptBody (already maintained by
  // app.js). Counter chip: mirror count from #tbBadge.
  const transcriptBody = document.getElementById('transcriptBody');
  const tbBadge = document.getElementById('tbBadge');
  const listenerTranscript = listenerSurface.querySelector('.proto-listener__transcript-text');
  const listenerCounter = listenerSurface.querySelector('.proto-listener__counter');
  const listenerTimer = listenerSurface.querySelector('.proto-listener__primary-time');

  function paintListenerTranscript() {
    if (!transcriptBody || !listenerTranscript) return;
    // app.js writes a placeholder "<span class='empty'>Transcript will
    // appear here as you speak…</span>" into #transcriptBody before any
    // speech lands. Treat that as empty so the placeholder never leaks
    // into the Feed surface.
    if (transcriptBody.querySelector('.empty')) {
      listenerTranscript.textContent = '';
      return;
    }
    const txt = (transcriptBody.textContent || '').replace(/\s+/g, ' ').trim();
    listenerTranscript.textContent = txt.slice(-120);
  }
  if (transcriptBody) {
    new MutationObserver(paintListenerTranscript).observe(transcriptBody, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    paintListenerTranscript();
  }

  const toolbarMicCount = toolbarMicBtn && toolbarMicBtn.querySelector('.proto-tb-mic-count');
  function paintListenerCounter() {
    if (!listenerCounter) return;
    let n = 0;
    if (tbBadge) {
      const txt = (tbBadge.textContent || '').trim();
      const parsed = parseInt(txt, 10);
      if (!Number.isNaN(parsed)) n = parsed;
      if (tbBadge.hidden) n = 0;
    }
    // Counter is always rendered with a numeric value while a session is
    // running — at 0 it sits as a soft grey neutral chip; 1–2 use the subtle
    // pink fill; ≥3 flips to the highlighted red.
    listenerCounter.textContent = n >= 100 ? '99+' : String(n);
    listenerCounter.classList.toggle('proto-listener__counter--empty', n <= 0);
    listenerCounter.classList.toggle('is-high', n >= 3);
    // Mirror onto the toolbar Mic button so the clinician sees a risk-count
    // badge there too when the Listener bar is hidden. CSS suppresses it
    // automatically while `.is-on` (Listener visible) — no need to gate here.
    if (toolbarMicCount) {
      toolbarMicCount.textContent = n >= 100 ? '99+' : String(n);
      toolbarMicCount.classList.toggle('proto-tb-mic-count--empty', n <= 0);
      toolbarMicCount.classList.toggle('is-high', n >= 3);
    }
  }
  if (tbBadge) {
    new MutationObserver(paintListenerCounter).observe(tbBadge, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
    paintListenerCounter();
  }

  // Mirror the timer text from the existing primary meta into the Feed's
  // own time slot — keeps both surfaces showing the same elapsed value.
  const existingMeta = document.querySelector('.proto-ai__primary-meta');
  function paintFeedTimer() {
    if (!listenerTimer || !existingMeta) return;
    listenerTimer.textContent = existingMeta.textContent || '0:00';
  }
  if (existingMeta) {
    new MutationObserver(paintFeedTimer).observe(existingMeta, {
      childList: true, characterData: true, subtree: true,
    });
    paintFeedTimer();
  }

  // Primary pill label per state — "Stop" while listening, "Resume" while paused.
  // Reads body classes directly so it stays in sync regardless of which path
  // updated the state (machine.set vs. external mutations).
  function paintFeedPrimaryLabel() {
    const label = listenerSurface.querySelector('.proto-listener__primary-label');
    const btn = listenerSurface.querySelector('.proto-listener__primary');
    if (!label || !btn) return;
    if (document.body.classList.contains('proto-paused')) {
      label.textContent = 'Listen';
      btn.setAttribute('aria-label', 'Resume listening');
    } else if (document.body.classList.contains('proto-stopping')) {
      label.textContent = 'Stopping…';
      btn.setAttribute('aria-label', 'Stopping');
    } else {
      label.textContent = 'Stop';
      btn.setAttribute('aria-label', 'Stop listening');
    }
  }
  // Watch state transitions via body class changes
  new MutationObserver(paintFeedPrimaryLabel).observe(document.body, {
    attributes: true, attributeFilter: ['class'],
  });
  paintFeedPrimaryLabel();

  // Session-row click → open Session Summary modal AND pause the session.
  // The Feed direction uses its own bespoke summary (transcript on the left,
  // detected factors on the right) instead of the existing Risk Summary modal.
  const detailsOverlay = document.getElementById('detailsOverlay');
  const sessionSummaryOverlay = document.getElementById('sessionSummaryOverlay');
  const sessionTranscript = document.getElementById('sessionTranscript');
  const sessionSideList = document.getElementById('sessionSideList');
  const sessionSideEmpty = document.getElementById('sessionSideEmpty');
  const sessionSideCount = document.getElementById('sessionSideCount');
  const sessionSummaryClose = document.getElementById('sessionSummaryClose');
  const sessionRiskAssess = document.getElementById('sessionRiskAssess');
  const raOverlay = document.getElementById('raOverlay');
  const summaryList = document.getElementById('summaryList');

  // Keyword highlight palette — cycles for visual variety even without
  // category data from app.js. When detection categories are available
  // later, map them to specific colours here.
  const KW_COLOURS = ['kw--red', 'kw--amber', 'kw--purple', 'kw--blue', 'kw--green'];

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Build the transcript HTML with detected factor phrases highlighted.
  // factors: array of { name, phrase, colourClass }
  function renderSessionTranscript(transcriptText, factors) {
    if (!sessionTranscript) return;
    if (!transcriptText || !transcriptText.trim()) {
      sessionTranscript.innerHTML = '<p class="muted" style="color:#6b7280;">No transcript captured yet for this session.</p>';
      return;
    }
    let html = escapeHtml(transcriptText);
    // Apply highlights by replacing phrase occurrences. Sort phrases by
    // length descending so longer matches win over shorter ones.
    const sorted = [...factors].sort((a, b) => (b.phrase || '').length - (a.phrase || '').length);
    for (const f of sorted) {
      if (!f.phrase) continue;
      const re = new RegExp('(' + f.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      html = html.replace(re, `<mark class="kw ${f.colourClass}">$1</mark>`);
    }
    // Split into paragraphs by double newline / sentence-ish boundaries
    const paragraphs = html.split(/\n\n+/).filter(Boolean);
    sessionTranscript.innerHTML = paragraphs.map((p) => `<p>${p}</p>`).join('');
  }

  function renderSessionFactors(factors) {
    if (!sessionSideList) return;
    sessionSideList.innerHTML = factors.map((f) => `
      <li>
        <span class="session-factor-chip">${escapeHtml(f.name)}</span>
        ${f.phrase ? `<span class="session-factor-quote">"${escapeHtml(f.phrase)}"</span>` : ''}
      </li>
    `).join('');
    if (sessionSideEmpty) sessionSideEmpty.hidden = factors.length > 0;
    if (sessionSideCount) {
      sessionSideCount.textContent = factors.length;
      sessionSideCount.classList.toggle('is-zero', factors.length === 0);
    }
  }

  // Pull detected factors from the existing Risk Summary list. Each card in
  // #summaryList carries the factor name + source phrase that app.js wrote.
  function harvestFactorsFromSummary() {
    if (!summaryList) return [];
    const items = summaryList.querySelectorAll('.summary-card, [data-factor]');
    const out = [];
    items.forEach((node, i) => {
      const nameEl = node.querySelector('strong, [data-factor-name], .factor-name');
      const phraseEl = node.querySelector('.muted, [data-factor-phrase], .factor-phrase');
      const name = (nameEl ? nameEl.textContent : node.textContent).trim();
      const phraseRaw = phraseEl ? phraseEl.textContent.trim() : '';
      // Clean leading/trailing quotes and ellipses
      const phrase = phraseRaw.replace(/^["“'\s.…]+|["”'\s.…]+$/g, '');
      out.push({ name, phrase, colourClass: KW_COLOURS[i % KW_COLOURS.length] });
    });
    return out;
  }

  function openSessionSummary() {
    if (!sessionSummaryOverlay) return;
    const factors = harvestFactorsFromSummary();
    const txt = (transcriptBody && transcriptBody.textContent) || '';
    renderSessionTranscript(txt, factors);
    renderSessionFactors(factors);
    sessionSummaryOverlay.hidden = false;
  }
  function closeSessionSummary() {
    if (!sessionSummaryOverlay) return;
    sessionSummaryOverlay.hidden = true;
  }
  if (sessionSummaryClose) sessionSummaryClose.addEventListener('click', closeSessionSummary);
  // Click on overlay backdrop (outside the modal) also closes
  if (sessionSummaryOverlay) {
    sessionSummaryOverlay.addEventListener('click', (e) => {
      if (e.target === sessionSummaryOverlay) closeSessionSummary();
    });
  }
  // Risk Assess → close the summary and open the existing Risk Assessment modal
  if (sessionRiskAssess) {
    sessionRiskAssess.addEventListener('click', () => {
      closeSessionSummary();
      if (raOverlay) raOverlay.hidden = false;
    });
  }

  listenerSurface.querySelector('[data-listener-action="open-summary"]').addEventListener('click', () => {
    if (machine.state === 'listening') {
      if (tbPause && !tbPause.disabled) tbPause.click();
      machine.set('paused');
    }
    openSessionSummary();
  });

  // Icon-only Stop in paused state — ends the session entirely.
  const stopPausedBtn = listenerSurface.querySelector('[data-listener-action="stop"]');
  if (stopPausedBtn) {
    stopPausedBtn.addEventListener('click', () => {
      machine.set('stopping');
      if (tbStop && !tbStop.disabled) tbStop.click();
    });
  }

  // Mic Settings popover toggle
  const listenerPopover = listenerSurface.querySelector('.proto-listener__popover');
  function positionPopover(triggerEl) {
    if (!listenerPopover || !triggerEl) return;
    // Align the popover to the Listener bar's footprint: same width,
    // right edge flush with the bar, sitting just below it. Anchoring
    // to the bar (not the gear) keeps the popover stable as the bar
    // morphs between states / variants.
    const wrapRect = listenerSurface.getBoundingClientRect();
    listenerPopover.style.top = (wrapRect.height + 6) + 'px';
    listenerPopover.style.right = '0px';
    listenerPopover.style.left = 'auto';
    listenerPopover.style.width = wrapRect.width + 'px';
  }
  listenerSurface.querySelectorAll('[data-listener-action="mic-settings"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !listenerPopover.hidden;
      if (isOpen) {
        listenerPopover.hidden = true;
      } else {
        positionPopover(btn);
        listenerPopover.hidden = false;
      }
    });
  });
  // Close popover on outside click or Escape
  document.addEventListener('click', (e) => {
    if (listenerPopover.hidden) return;
    if (listenerPopover.contains(e.target)) return;
    if (e.target.closest('[data-listener-action="mic-settings"]')) return;
    listenerPopover.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !listenerPopover.hidden) listenerPopover.hidden = true;
  });

  // Device picker — visual only; toggle the checkmark active state
  listenerPopover.querySelectorAll('[data-listener-device]').forEach((btn) => {
    btn.addEventListener('click', () => {
      listenerPopover.querySelectorAll('[data-listener-device]').forEach((b) => {
        b.classList.toggle('proto-listener__pop-device--active', b === btn);
        const chk = b.querySelector('.proto-listener__pop-check');
        if (chk) chk.classList.toggle('proto-listener__pop-check--placeholder', b !== btn);
      });
    });
  });

  // The wrap needs position: relative for the popover anchor to work
  listenerSurface.style.position = 'relative';

  // -------- 6. Voice meter (synthetic, no parallel mic stream) -----------
  // Originally this opened a parallel getUserMedia stream to drive the bars
  // from real audio levels. That competes with the SpeechRecognition stream
  // owned by app.js — Chrome shares device-level audio settings across
  // getUserMedia streams and the resulting audio pipeline silently breaks
  // Web Speech API transcription (interim "Hearing speech…" fires but no
  // final transcript ever lands). We hit this exact issue earlier in the
  // project and removed our own audio meter for the same reason.
  // The bars are now driven by a synthetic animation while listening, which
  // preserves the visual feedback without touching the mic.
  let rafId = null;

  function startMeter() {
    if (rafId) return;
    const bandCount = 5;
    const startedAt = performance.now();
    function tick(now) {
      const bars = document.querySelectorAll('.proto-ai__meter span');
      const t = (now - startedAt) / 1000;
      for (let i = 0; i < bandCount; i++) {
        // Each band oscillates at a slightly different speed for an organic feel
        const phase = t * (2.2 + i * 0.6) + i * 1.3;
        const ceiling = (i === 0 || i === bandCount - 1) ? 10 : 14;
        const amp = (Math.sin(phase) * 0.35 + 0.45 + Math.random() * 0.2);
        const h = Math.max(3, Math.round(amp * ceiling));
        bars.forEach((el) => {
          if (parseInt(el.dataset.band, 10) === i) el.style.height = h + 'px';
        });
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }
  function stopMeter() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    document.querySelectorAll('.proto-ai__meter span').forEach((el) => { el.style.height = ''; });
  }

  // -------- 7. Drag — replica toolbar handle (moves #toolbarWrap) --------
  // Restore saved toolbar position only when drag is enabled. While drag is
  // off, an older saved pixel position would freeze the toolbar wherever
  // it was last dragged and the user has no way to move it back — so we
  // honour the CSS default (top:50%; left:50%; centred) instead.
  if (DRAG_ENABLED) {
    try {
      const tbPos = JSON.parse(localStorage.getItem(STORAGE_TB_POS) || 'null');
      if (tbPos && typeof tbPos.x === 'number' && typeof tbPos.y === 'number') {
        toolbarWrap.style.left = tbPos.x + 'px';
        toolbarWrap.style.top = tbPos.y + 'px';
        toolbarWrap.style.transform = 'none';
      }
    } catch (e) {}
  }

  const tbHandle = replicaToolbar.querySelector('.proto-tb-handle');
  let tbDrag = null;

  function tbDragStart(cx, cy) {
    const rect = toolbarWrap.getBoundingClientRect();
    // Switch from centred-transform to absolute pixel positioning
    toolbarWrap.style.transform = 'none';
    toolbarWrap.style.left = rect.left + 'px';
    toolbarWrap.style.top = rect.top + 'px';
    tbDrag = { mx: cx, my: cy, x: rect.left, y: rect.top };
    document.body.style.cursor = 'grabbing';
  }
  function tbDragMove(cx, cy) {
    if (!tbDrag) return;
    const nx = tbDrag.x + (cx - tbDrag.mx);
    const ny = tbDrag.y + (cy - tbDrag.my);
    const maxX = window.innerWidth - toolbarWrap.offsetWidth;
    const maxY = window.innerHeight - toolbarWrap.offsetHeight;
    toolbarWrap.style.left = Math.min(Math.max(0, nx), maxX) + 'px';
    toolbarWrap.style.top  = Math.min(Math.max(0, ny), maxY) + 'px';
  }
  function tbDragEnd() {
    if (!tbDrag) return;
    tbDrag = null;
    document.body.style.cursor = '';
    const rect = toolbarWrap.getBoundingClientRect();
    try { localStorage.setItem(STORAGE_TB_POS, JSON.stringify({ x: rect.left, y: rect.top })); } catch (e) {}
  }

  if (DRAG_ENABLED) {
    tbHandle.addEventListener('mousedown', (e) => { e.preventDefault(); tbDragStart(e.clientX, e.clientY); });
    tbHandle.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; tbDragStart(t.clientX, t.clientY);
    }, { passive: true });
  }

  // -------- 8. Drag — Feed surface --------------------------------------
  // Feed surface uses RIGHT/BOTTOM anchoring (not LEFT/TOP) so the drag
  // handle on the right edge stays pinned when the wrap resizes between
  // states — content grows/shrinks toward the left, handle stays put.
  // Default CSS positions the surface bottom-centre via transform; on first
  // reveal we measure and convert that to a fixed `right` pixel value so
  // subsequent state changes don't move the handle.
  const listenerHandle = listenerSurface.querySelector('.proto-listener__handle');
  let listenerDrag = null;
  let listenerPositioned = false;

  function pinSurface(r, b) {
    // Switch from CSS-default centring to fixed right/bottom anchoring.
    // The CSS centring trick uses `top: 50%; left: 50%; transform:
    // translate(-50%, -50%)` all marked !important — flipping
    // data-positioned="1" routes the element to the `[data-positioned="1"]`
    // rule which clears top/left/transform (also !important), so the
    // inline right/bottom set below take effect cleanly.
    listenerSurface.dataset.positioned = '1';
    listenerSurface.style.right = r + 'px';
    listenerSurface.style.bottom = b + 'px';
  }

  function ensureListenerPositioned() {
    // Position is CSS-only now (right: calc(50% - 145px); top: 75%) so
    // the right edge stays pinned as the bar width changes between
    // states. JS pinning only runs when DRAG_ENABLED — and even then
    // only to restore a saved drag position.
    if (!DRAG_ENABLED) { listenerPositioned = true; return; }
    if (listenerPositioned) return;
    // NB: `offsetParent` is always null for `position: fixed` elements, so
    // we can't gate on that — the `rect.width === 0` check below catches
    // the "not yet laid out" case correctly.
    const rect = listenerSurface.getBoundingClientRect();
    if (rect.width === 0) return;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_LISTENER_POS) || 'null');
      if (saved && typeof saved.r === 'number' && typeof saved.b === 'number') {
        const maxR = Math.max(0, window.innerWidth - rect.width);
        const maxB = Math.max(0, window.innerHeight - rect.height);
        if (saved.r >= 0 && saved.r <= maxR && saved.b >= 0 && saved.b <= maxB) {
          pinSurface(saved.r, saved.b);
          listenerPositioned = true;
          return;
        }
      }
    } catch (e) {}
    const r = Math.max(0, Math.round(window.innerWidth - rect.right));
    const b = Math.max(0, Math.round(window.innerHeight - rect.bottom));
    pinSurface(r, b);
    listenerPositioned = true;
  }

  function listenerDragStart(cx, cy) {
    ensureListenerPositioned();
    const rect = listenerSurface.getBoundingClientRect();
    const r = window.innerWidth - rect.right;
    const b = window.innerHeight - rect.bottom;
    pinSurface(r, b);
    listenerDrag = { mx: cx, my: cy, r, b };
    document.body.style.cursor = 'grabbing';
  }
  function listenerDragMove(cx, cy) {
    if (!listenerDrag) return;
    const nr = listenerDrag.r - (cx - listenerDrag.mx);
    const nb = listenerDrag.b - (cy - listenerDrag.my);
    const w = listenerSurface.offsetWidth;
    const h = listenerSurface.offsetHeight;
    const maxR = window.innerWidth - w;
    const maxB = window.innerHeight - h;
    listenerSurface.style.right  = Math.min(Math.max(0, nr), maxR) + 'px';
    listenerSurface.style.bottom = Math.min(Math.max(0, nb), maxB) + 'px';
  }
  function listenerDragEnd() {
    if (!listenerDrag) return;
    listenerDrag = null;
    document.body.style.cursor = '';
    const r = parseFloat(listenerSurface.style.right) || 0;
    const b = parseFloat(listenerSurface.style.bottom) || 0;
    try { localStorage.setItem(STORAGE_LISTENER_POS, JSON.stringify({ r, b })); } catch (e) {}
  }

  if (DRAG_ENABLED && listenerHandle) {
    listenerHandle.addEventListener('mousedown', (e) => { e.preventDefault(); listenerDragStart(e.clientX, e.clientY); });
    listenerHandle.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; listenerDragStart(t.clientX, t.clientY);
    }, { passive: true });
  }

  if (DRAG_ENABLED) {
    document.addEventListener('mousemove', (e) => {
      tbDragMove(e.clientX, e.clientY);
      listenerDragMove(e.clientX, e.clientY);
    });
    document.addEventListener('mouseup', () => { tbDragEnd(); listenerDragEnd(); });
    document.addEventListener('touchmove', (e) => {
      if (!tbDrag && !listenerDrag) return;
      const t = e.touches[0];
      tbDragMove(t.clientX, t.clientY);
      listenerDragMove(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchend', () => { tbDragEnd(); listenerDragEnd(); });
  }

  // -------- 9. Bootstrap initial view ------------------------------------
  // Default is the Listener surface; Components is reached via the chip
  // toggle. URL ?view=components honoured; saved view only honoured if
  // it's 'components' — anything else collapses to Listener.
  let initialView = 'listener';
  try {
    const fromUrl = new URL(location.href).searchParams.get('view');
    if (fromUrl === 'components' || fromUrl === 'listener') initialView = fromUrl;
    else {
      const saved = localStorage.getItem(STORAGE_VIEW);
      if (saved === 'components') initialView = 'components';
    }
  } catch (e) {}
  // Compact is the only variant exposed in the live UI right now. Wide
  // is still available via Components for design reference.
  setVariant('compact');

  setView(initialView);
  machine.reconcileFromDOM();
  requestAnimationFrame(ensureListenerPositioned);
})();
