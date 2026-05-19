/* =====================================================================
   AmbiantAI PoC — UI exploration overlay
   Self-contained, does not import from or modify app.js.
   Adds: view-switcher chip, replica toolbar markup (Figma-accurate),
   Ambient AI surface (attached + separate variants), click proxying to
   existing buttons, read-only state mirroring, Web Audio voice meter,
   device label, draggable toolbar with localStorage position persistence.
   ===================================================================== */
(function () {
  if (new URL(location.href).searchParams.get('mic')) return; // skip phone-mic page

  const STORAGE_VIEW = 'ambient-ui-view';
  const STORAGE_SEP_POS = 'ambient-ui-sep-pos';
  const STORAGE_TB_POS = 'ambient-ui-tb-pos';
  const STORAGE_FEED_POS = 'ambient-ui-feed-pos';
  const VIEWS = ['attached', 'separate', 'components', 'feed'];

  // Figma-extracted SVG symbols live in index.html (the static <defs> block
  // labelled "Figma-aligned symbols") so they're available on the
  // phone-mic page too — prototype.js short-circuits there.

  // -------- 1. View switcher chip ----------------------------------------
  const chip = document.createElement('div');
  chip.className = 'proto-chip';
  chip.setAttribute('role', 'group');
  chip.setAttribute('aria-label', 'UI direction');
  chip.innerHTML = `
    <span class="proto-chip__label">Direction</span>
    <button class="proto-chip__btn" data-view="attached">Attached</button>
    <button class="proto-chip__btn" data-view="separate">Separate</button>
    <button class="proto-chip__btn" data-view="feed">Feed</button>
    <button class="proto-chip__btn" data-view="components">Components</button>
  `;
  document.body.appendChild(chip);

  function setView(view) {
    if (!VIEWS.includes(view)) view = 'attached';
    document.body.classList.remove('view-attached', 'view-separate', 'view-components', 'view-feed');
    document.body.classList.add(`view-${view}`);
    chip.querySelectorAll('[data-view]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === view);
    });
    try { localStorage.setItem(STORAGE_VIEW, view); } catch (e) {}
    if (typeof machine !== 'undefined' && machine.state === 'listening') startMeter();
  }
  chip.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) setView(btn.dataset.view);
  });

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
        <button class="proto-tb-btn" type="button" data-proto-btn="patient" aria-label="Patient">
          <svg class="proto-tb-icon"><use href="#fic-patient"/></svg>
        </button>
        <button class="proto-tb-btn" type="button" data-proto-btn="dashboard" aria-label="Dashboard">
          <svg class="proto-tb-icon"><use href="#fic-dashboard"/></svg>
        </button>
        <button class="proto-tb-btn" type="button" data-proto-btn="inbox" aria-label="Inbox">
          <svg class="proto-tb-icon"><use href="#fic-inbox"/></svg>
        </button>
        <button class="proto-tb-btn" type="button" data-proto-btn="ask" aria-label="Ask">
          <svg class="proto-tb-icon"><use href="#fic-ask"/></svg>
        </button>
      </div>
      <button class="proto-tb-btn proto-tb-menu" type="button" data-proto-btn="menu" aria-label="Menu">
        <svg class="proto-tb-icon proto-tb-icon--menu"><use href="#fic-menu-cts"/></svg>
      </button>
      <div class="proto-tb-handle" role="button" tabindex="0" aria-label="Drag toolbar" title="Drag to move">
        <span></span><span></span>
        <span></span><span></span>
        <span></span><span></span>
        <span></span><span></span>
      </div>
    </div>
  `;
  toolbarWrap.appendChild(replicaToolbar);

  // -------- 3. Ambient AI surface (unchanged from previous iteration) ----
  function buildAiSurface(variant) {
    const root = document.createElement('div');
    root.className = `proto-ai proto-ai--${variant}`;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Ambient AI controls');
    root.innerHTML = `
      <div class="proto-ai__container">
        <div class="proto-ai__row">
          <button class="proto-ai__pill proto-ai__pause" type="button" data-proxy="tbPause" aria-label="Pause listening">
            <svg class="proto-ai__ic"><use href="#fic-pause-sm"/></svg>
          </button>
          <button class="proto-ai__pill proto-ai__primary" type="button" data-proto-action="toggle" aria-label="Start listening">
            <span class="proto-ai__rec" aria-hidden="true"></span>
            <span class="proto-ai__primary-label">Start listening</span>
            <span class="proto-ai__primary-meta" aria-hidden="true" hidden>0:00</span>
          </button>
        </div>
        <div class="proto-ai__row proto-ai__row--device">
          <div class="proto-ai__mic-row">
            <svg class="proto-ai__ic" aria-hidden="true"><use href="#fic-mic-sm"/></svg>
            <span class="proto-ai__device">Microphone</span>
            <div class="proto-ai__meter" aria-hidden="true">
              <span data-band="0"></span><span data-band="1"></span><span data-band="2"></span><span data-band="3"></span><span data-band="4"></span>
            </div>
          </div>
          <button class="proto-ai__phone" type="button" data-proxy="tbPhone" aria-label="Use phone as microphone">
            <svg class="proto-ai__ic"><use href="#fic-phone-sm"/></svg>
          </button>
        </div>
      </div>
      <div class="proto-ai__grip" role="button" tabindex="0" aria-label="Drag" title="Drag to move">
        <svg class="proto-ai__ic"><use href="#fic-grip-v"/></svg>
      </div>
    `;
    return root;
  }

  const aiAttached = buildAiSurface('attached');
  const aiSeparate = buildAiSurface('separate');
  toolbarWrap.appendChild(aiAttached);
  document.body.appendChild(aiSeparate);

  // -------- 3a. Feed surface (Direction = Feed) --------------------------
  // Structured ambient surface with inline transcription feed + risk counter.
  // Markup per Figma node 13443:6983. Lives inside #toolbarWrap so its
  // position follows the same drag handle as the attached/replica toolbar.
  function buildFeedSurface() {
    const root = document.createElement('div');
    root.className = 'proto-feed';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Ambient AI feed surface');
    root.innerHTML = `
      <div class="proto-feed__wrap">
        <div class="proto-feed__container">
          <!-- Compact idle row — visible only when state = idle -->
          <div class="proto-feed__idle">
            <button class="proto-feed__listen" type="button" data-proto-action="toggle" aria-label="Start listening">
              <span class="proto-feed__rec-outline" aria-hidden="true"></span>
              <span class="proto-feed__listen-label">Listen</span>
            </button>
            <button class="proto-feed__settings proto-feed__settings--idle" type="button" data-feed-action="mic-settings" aria-label="Microphone settings">
              <svg class="proto-feed__ic"><use href="#fic-mic-settings-sm"/></svg>
            </button>
          </div>
          <!-- Primer — shown right after patient opens. Confirms the patient's
               language before recording, then offers Start session or Skip. -->
          <div class="proto-feed__primer">
            <div class="proto-feed__primer-row proto-feed__primer-row--lang">
              <span class="proto-feed__primer-lead">Patient speaks</span>
              <label class="proto-feed__primer-lang">
                <svg class="proto-feed__primer-lang-ic" aria-hidden="true" viewBox="0 0 16 16">
                  <path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.25c.79 0 1.65.84 2.27 2.36.18.44.33.93.46 1.44H5.27c.13-.51.28-1 .46-1.44C6.35 3.59 7.2 2.75 8 2.75Zm-3.5 3.8h-1.97A5.25 5.25 0 0 1 5.93 3.5c-.38.61-.7 1.38-.94 2.25-.12.42-.22.85-.29 1.3Zm6.78 0c-.07-.45-.17-.88-.29-1.3-.24-.87-.56-1.64-.94-2.25 1.4.54 2.55 1.62 3.18 3.05.05.16.11.32.16.5h-1.97c-.05-.18-.11-.36-.17-.53l.03.03Zm.83 1.45a5.25 5.25 0 0 1-.16 3h1.97a5.25 5.25 0 0 0 .53-3h-2.34Zm-1.43 0a13.6 13.6 0 0 1 .15 1.5c0 .52-.05 1.02-.15 1.5h-5.6a13.6 13.6 0 0 1-.15-1.5c0-.52.05-1.02.15-1.5h5.6Zm-7.03 0H1.31a5.25 5.25 0 0 0 .53 3h1.97a13.6 13.6 0 0 1-.16-3Zm.59 4.25H2.34a5.25 5.25 0 0 0 3.59 2.55 7 7 0 0 1-.94-2.25c-.05-.16-.11-.32-.16-.5l-.59.2Zm6.55 0c-.13.51-.28 1-.46 1.44C9.65 14.21 8.8 15 8 15s-1.65-.84-2.27-2.36a13.4 13.4 0 0 1-.46-1.44h5.46Zm-.59-1.45a5.25 5.25 0 0 1-.16 1.45h-5.13c-.08-.46-.13-.96-.16-1.45h5.45Z"/>
                </svg>
                <select class="proto-feed__primer-lang-select" data-feed-action="primer-lang" aria-label="Patient language">
                  <option value="en-GB">English</option>
                  <option value="es-ES">Spanish</option>
                  <option value="uk-UA">Ukrainian</option>
                </select>
                <svg class="proto-feed__primer-lang-chev" aria-hidden="true" viewBox="0 0 12 12">
                  <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m3 5 3 3 3-3"/>
                </svg>
              </label>
            </div>
            <div class="proto-feed__primer-row proto-feed__primer-row--actions">
              <button class="proto-feed__primer-start" type="button" data-feed-action="start-session" aria-label="Start session">
                <span class="proto-feed__rec-outline" aria-hidden="true"></span>
                <span>Start session</span>
              </button>
              <button class="proto-feed__primer-skip" type="button" data-feed-action="skip-session" aria-label="Skip — no recording for this patient">
                Skip
              </button>
              <button class="proto-feed__settings" type="button" data-feed-action="mic-settings" aria-label="Microphone settings">
                <svg class="proto-feed__ic"><use href="#fic-mic-settings-sm"/></svg>
              </button>
            </div>
          </div>
          <!-- Active rows — visible only when state = listening/paused/stopping -->
          <div class="proto-feed__active">
            <button class="proto-feed__session" type="button" data-feed-action="open-summary" title="Open summary · pauses session">
              <span class="proto-feed__logo proto-feed__logo--lg" aria-hidden="true">
                <svg viewBox="0 0 28 28"><use href="#fic-menu-cts"/></svg>
              </span>
              <span class="proto-feed__transcript">
                <span class="proto-feed__transcript-text" aria-live="polite"></span>
                <span class="proto-feed__status-label proto-feed__status-label--listening">Listening…</span>
                <span class="proto-feed__status-label proto-feed__status-label--paused">Paused</span>
              </span>
              <span class="proto-feed__counter proto-feed__counter--empty" aria-label="Risk factor count"></span>
            </button>
            <div class="proto-feed__controls">
              <button class="proto-feed__pause" type="button" data-proxy="tbPause" aria-label="Pause listening">
                <svg class="proto-feed__ic"><use href="#fic-pause-sm"/></svg>
              </button>
              <button class="proto-feed__primary" type="button" data-proto-action="toggle" aria-label="Stop listening">
                <svg class="proto-feed__primary-ic proto-feed__primary-ic--stop"><use href="#fic-stop-sm"/></svg>
                <span class="proto-feed__primary-rec proto-feed__primary-rec--ring" aria-hidden="true"></span>
                <span class="proto-feed__primary-label">Stop</span>
                <span class="proto-feed__primary-time">0:00</span>
              </button>
              <button class="proto-feed__stop-paused" type="button" data-feed-action="stop" aria-label="End session">
                <svg class="proto-feed__ic"><use href="#fic-stop-sm"/></svg>
              </button>
              <button class="proto-feed__settings" type="button" data-feed-action="mic-settings" aria-label="Microphone settings">
                <svg class="proto-feed__ic"><use href="#fic-mic-settings-sm"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div class="proto-feed__handle" role="button" tabindex="0" aria-label="Drag" title="Drag to move">
          <svg class="proto-feed__ic"><use href="#fic-grip-v"/></svg>
        </div>
      </div>

      <!-- Mic Settings popover — anchored below the gear button -->
      <div class="proto-feed__popover" hidden role="menu" aria-label="Microphone settings">
        <div class="proto-feed__pop-issue" hidden>
          <span>Microphone is blocked — open browser settings to enable</span>
        </div>
        <div class="proto-feed__pop-section">Microphone</div>
        <button class="proto-feed__pop-device proto-feed__pop-device--active" type="button" data-feed-device="device-1">
          <svg class="proto-feed__pop-check"><use href="#fic-check-sm"/></svg>
          <span class="proto-feed__pop-device-name">Chromebook Microphone</span>
          <span class="proto-feed__pop-meter" aria-hidden="true">
            <span data-feed-band="0"></span><span data-feed-band="1"></span><span data-feed-band="2"></span><span data-feed-band="3"></span><span data-feed-band="4"></span>
          </span>
        </button>
        <button class="proto-feed__pop-device" type="button" data-feed-device="device-2">
          <span class="proto-feed__pop-check proto-feed__pop-check--placeholder"></span>
          <span class="proto-feed__pop-device-name">Microsoft Teams Audio Device</span>
        </button>
        <div class="proto-feed__pop-section">Use your phone</div>
        <button class="proto-feed__pop-action" type="button" data-proxy="tbPhone">
          <svg class="proto-feed__pop-icon"><use href="#fic-phone-sm"/></svg>
          <span class="proto-feed__pop-device-name">Connect with QR code</span>
        </button>
      </div>
    `;
    return root;
  }

  const feedSurface = buildFeedSurface();
  toolbarWrap.appendChild(feedSurface);

  // -------- 3b. Components gallery (Direction = Components) --------------
  // Non-interactive showcase of the main building blocks. Each card holds a
  // freshly-built static representation — IDs stripped so they don't clash
  // with the live UI above. Buttons inside the cards are not wired up.
  function buildAiPreview(variant, opts = {}) {
    // Same markup as buildAiSurface but with display-state classes baked in
    // (no live state machine). `opts.state` controls what's shown.
    const state = opts.state || 'idle'; // idle | listening | paused
    const meta = state !== 'idle' ? `<span class="proto-ai__primary-meta">${opts.timer || '0:00'}</span>` : '';
    const label = state === 'listening' ? 'Stop listening'
                : state === 'paused'    ? 'Resume listening'
                : 'Start listening';
    const showPause = state === 'listening' ? 'inline-flex' : 'none';
    const recState = state === 'listening' ? 'is-rec-on is-rec-breath'
                   : state === 'paused'    ? 'is-rec-on'
                   : '';
    const barHeights = state === 'listening' ? [9, 13, 5, 8, 6]
                     : state === 'paused'    ? [9, 13, 5, 8, 6]
                     : [3, 3, 3, 3, 3];
    const barOpacity = state === 'idle' ? '0' : '1';
    const barColor = state === 'paused' ? '#B0AC97' : '#5CA246';

    return `
      <div class="proto-ai proto-ai--${variant} proto-ai--preview">
        <div class="proto-ai__container">
          <div class="proto-ai__row">
            <button class="proto-ai__pill proto-ai__pause" style="display:${showPause}">
              <svg class="proto-ai__ic"><use href="#fic-pause-sm"/></svg>
            </button>
            <button class="proto-ai__pill proto-ai__primary">
              <span class="proto-ai__rec ${recState}"></span>
              <span class="proto-ai__primary-label">${label}</span>
              ${meta}
            </button>
            ${variant === 'separate' ? `<div class="proto-ai__grip"><svg class="proto-ai__ic"><use href="#fic-grip-v"/></svg></div>` : ''}
          </div>
          <div class="proto-ai__row proto-ai__row--device">
            <div class="proto-ai__mic-row">
              <svg class="proto-ai__ic"><use href="#fic-mic-sm"/></svg>
              <span class="proto-ai__device">Microphone</span>
              <div class="proto-ai__meter">
                ${barHeights.map((h, i) => `<span data-band="${i}" style="height:${h}px;opacity:${barOpacity};background:${barColor}"></span>`).join('')}
              </div>
            </div>
            <button class="proto-ai__phone">
              <svg class="proto-ai__ic"><use href="#fic-phone-sm"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function buildToolbarPreview() {
    return `
      <div class="proto-toolbar proto-toolbar--preview">
        <div class="proto-tb-wrap">
          <div class="proto-tb-primary">
            <button class="proto-tb-btn"><svg class="proto-tb-icon"><use href="#fic-patient"/></svg></button>
            <button class="proto-tb-btn"><svg class="proto-tb-icon"><use href="#fic-dashboard"/></svg></button>
            <button class="proto-tb-btn"><svg class="proto-tb-icon"><use href="#fic-inbox"/></svg></button>
            <button class="proto-tb-btn"><svg class="proto-tb-icon"><use href="#fic-ask"/></svg></button>
          </div>
          <button class="proto-tb-btn proto-tb-menu">
            <svg class="proto-tb-icon proto-tb-icon--menu"><use href="#fic-menu-cts"/></svg>
          </button>
          <div class="proto-tb-handle">
            <span></span><span></span><span></span><span></span>
            <span></span><span></span><span></span><span></span>
          </div>
        </div>
      </div>
    `;
  }

  function buildFeedPreview(state, opts = {}) {
    // Static rendering of the Feed surface in a given state — no event
    // handlers, no observers. The `--state-*` modifier classes opt into
    // the per-state CSS variants without relying on the body's state class.
    const transcript = opts.transcript || '';
    const count = opts.count != null ? opts.count : 0;
    const time = opts.time || '0:00';
    const isHigh = count >= 3;
    const counterClass = count <= 0 ? 'proto-feed__counter--empty' : (isHigh ? 'is-high' : '');
    const counterText = count <= 0 ? '0' : (count >= 100 ? '99+' : String(count));

    const idleBody = `
      <div class="proto-feed__idle" style="display: flex;">
        <button class="proto-feed__listen" type="button">
          <span class="proto-feed__rec-outline"></span>
          <span class="proto-feed__listen-label">Listen</span>
        </button>
        <button class="proto-feed__settings" type="button">
          <svg class="proto-feed__ic"><use href="#fic-mic-settings-sm"/></svg>
        </button>
      </div>
    `;

    const primerBody = `
      <div class="proto-feed__primer" style="display: flex; flex-direction: column; gap: 6px;">
        <div class="proto-feed__primer-row proto-feed__primer-row--lang">
          <span class="proto-feed__primer-lead">Patient speaks</span>
          <label class="proto-feed__primer-lang">
            <svg class="proto-feed__primer-lang-ic" viewBox="0 0 16 16">
              <path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.25c.79 0 1.65.84 2.27 2.36.18.44.33.93.46 1.44H5.27c.13-.51.28-1 .46-1.44C6.35 3.59 7.2 2.75 8 2.75Zm-3.5 3.8h-1.97A5.25 5.25 0 0 1 5.93 3.5c-.38.61-.7 1.38-.94 2.25-.12.42-.22.85-.29 1.3Zm6.78 0c-.07-.45-.17-.88-.29-1.3-.24-.87-.56-1.64-.94-2.25 1.4.54 2.55 1.62 3.18 3.05.05.16.11.32.16.5h-1.97c-.05-.18-.11-.36-.17-.53l.03.03Zm.83 1.45a5.25 5.25 0 0 1-.16 3h1.97a5.25 5.25 0 0 0 .53-3h-2.34Zm-1.43 0a13.6 13.6 0 0 1 .15 1.5c0 .52-.05 1.02-.15 1.5h-5.6a13.6 13.6 0 0 1-.15-1.5c0-.52.05-1.02.15-1.5h5.6Zm-7.03 0H1.31a5.25 5.25 0 0 0 .53 3h1.97a13.6 13.6 0 0 1-.16-3Zm.59 4.25H2.34a5.25 5.25 0 0 0 3.59 2.55 7 7 0 0 1-.94-2.25c-.05-.16-.11-.32-.16-.5l-.59.2Zm6.55 0c-.13.51-.28 1-.46 1.44C9.65 14.21 8.8 15 8 15s-1.65-.84-2.27-2.36a13.4 13.4 0 0 1-.46-1.44h5.46Zm-.59-1.45a5.25 5.25 0 0 1-.16 1.45h-5.13c-.08-.46-.13-.96-.16-1.45h5.45Z"/>
            </svg>
            <select class="proto-feed__primer-lang-select" disabled>
              <option>English</option>
            </select>
            <svg class="proto-feed__primer-lang-chev" viewBox="0 0 12 12">
              <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m3 5 3 3 3-3"/>
            </svg>
          </label>
        </div>
        <div class="proto-feed__primer-row proto-feed__primer-row--actions">
          <button class="proto-feed__primer-start" type="button">
            <span class="proto-feed__rec-outline"></span>
            <span>Start session</span>
          </button>
          <button class="proto-feed__primer-skip" type="button">Skip</button>
          <button class="proto-feed__settings" type="button">
            <svg class="proto-feed__ic"><use href="#fic-mic-settings-sm"/></svg>
          </button>
        </div>
      </div>
    `;

    const activeBody = (s) => {
      const showPause = s === 'listening';
      const showStopPaused = s === 'paused';
      const primaryLabel = s === 'paused' ? 'Listen' : 'Stop';
      const primaryIcStop = s === 'paused' ? 'display:none' : '';
      const primaryRec = s === 'paused' ? 'display:inline-block' : 'display:none';
      const statusLabel = s === 'listening'
        ? '<span class="proto-feed__status-label proto-feed__status-label--listening" style="display:flex">Listening…</span>'
        : '<span class="proto-feed__status-label proto-feed__status-label--paused" style="display:flex; background:transparent; padding-right:0;">Paused</span>';
      const transcriptDisplay = s === 'paused' ? 'none' : 'flex';

      return `
        <div class="proto-feed__active" style="display: flex; flex-direction: column; gap: 6px;">
          <button class="proto-feed__session" type="button">
            <span class="proto-feed__logo proto-feed__logo--lg" aria-hidden="true">
              <svg viewBox="0 0 28 28"><use href="#fic-menu-cts"/></svg>
            </span>
            <span class="proto-feed__transcript">
              <span class="proto-feed__transcript-text" style="display:${transcriptDisplay}">${transcript}</span>
              ${statusLabel}
            </span>
            <span class="proto-feed__counter ${counterClass}">${counterText}</span>
          </button>
          <div class="proto-feed__controls">
            <button class="proto-feed__pause" type="button" style="display:${showPause ? 'inline-flex' : 'none'}">
              <svg class="proto-feed__ic"><use href="#fic-pause-sm"/></svg>
            </button>
            <button class="proto-feed__primary" type="button">
              <svg class="proto-feed__primary-ic proto-feed__primary-ic--stop" style="${primaryIcStop}"><use href="#fic-stop-sm"/></svg>
              <span class="proto-feed__primary-rec" style="${primaryRec}"></span>
              <span class="proto-feed__primary-label">${primaryLabel}</span>
              <span class="proto-feed__primary-time">${time}</span>
            </button>
            <button class="proto-feed__stop-paused" type="button" style="display:${showStopPaused ? 'inline-flex' : 'none'}">
              <svg class="proto-feed__ic"><use href="#fic-stop-sm"/></svg>
            </button>
            <button class="proto-feed__settings" type="button">
              <svg class="proto-feed__ic"><use href="#fic-mic-settings-sm"/></svg>
            </button>
          </div>
        </div>
      `;
    };

    let body;
    if (state === 'idle') body = idleBody;
    else if (state === 'primer') body = primerBody;
    else body = activeBody(state);

    return `
      <div class="proto-feed proto-feed--preview proto-feed--state-${state}">
        <div class="proto-feed__wrap">
          <div class="proto-feed__container">
            ${body}
          </div>
          <div class="proto-feed__handle">
            <svg class="proto-feed__ic"><use href="#fic-grip-v"/></svg>
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
          <h2>Ambient AI bar — Attached</h2>
          <p>Docks flush under the toolbar when a patient is open. Same width as the toolbar.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--ai">
          <div class="proto-comp__ai-row">
            <div class="proto-comp__ai-cell">
              <span class="proto-comp__caption">Idle</span>
              ${buildAiPreview('attached', { state: 'idle' })}
            </div>
            <div class="proto-comp__ai-cell">
              <span class="proto-comp__caption">Listening</span>
              ${buildAiPreview('attached', { state: 'listening', timer: '4:18' })}
            </div>
            <div class="proto-comp__ai-cell">
              <span class="proto-comp__caption">Paused</span>
              ${buildAiPreview('attached', { state: 'paused', timer: '4:18' })}
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p><strong>States:</strong> idle · starting (300 ms) · listening (breathing) · paused (frozen) · stopping (300 ms fade).</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Ambient AI bar — Separate</h2>
          <p>Independent floating bar. Always visible. Has its own drag grip on the right.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--ai">
          <div class="proto-comp__ai-row">
            <div class="proto-comp__ai-cell">
              <span class="proto-comp__caption">Idle</span>
              ${buildAiPreview('separate', { state: 'idle' })}
            </div>
            <div class="proto-comp__ai-cell">
              <span class="proto-comp__caption">Listening</span>
              ${buildAiPreview('separate', { state: 'listening', timer: '4:18' })}
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Drag the grip on the right to reposition. Position persists across reloads.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Ambient AI — Feed</h2>
          <p>Structured surface with inline transcription, risk-factor counter, and dedicated mic-settings popover. Sits on a translucent dark wrap. Four states: idle, primer (Open patient prompt), listening, paused.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--feed">
          <div class="proto-comp__feed-row">
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Idle</span>
              ${buildFeedPreview('idle')}
            </div>
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Primer (patient just opened)</span>
              ${buildFeedPreview('primer')}
            </div>
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Listening</span>
              ${buildFeedPreview('listening', { transcript: 'abdominal uh like in the stomach', count: 3, time: '4:18' })}
            </div>
            <div class="proto-comp__feed-cell">
              <span class="proto-comp__caption">Paused</span>
              ${buildFeedPreview('paused', { count: 3, time: '4:18' })}
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p><strong>States:</strong> idle (compact Listen pill) · primer (Start session / Skip) · listening (transcript flows + counter live) · paused (status + counter, controls swap to Resume / Stop / Settings) · starting / stopping are short transitions, not separately rendered.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Risk Summary modal</h2>
          <p>Opens from the notification card's "Details" link after detections come in. Shows a summary header + a list of detected risk factors.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--modal">
          <div class="proto-comp__modal-preview proto-comp__modal-preview--summary">
            <header class="patient-bar">
              <span class="nhs-tag">NHS</span>
              <span class="patient-id">123 456 7890</span>
              <span class="patient-name"><span class="muted">Mr.</span> <strong>Willington, Albert</strong></span>
              <span class="patient-meta-badge">M</span>
              <span class="patient-meta">59yrs</span>
              <span class="patient-meta">12 Nov 1967</span>
              <button class="icon-btn icon-btn--light"><svg class="ic"><use href="#ic-close"/></svg></button>
            </header>
            <div class="modal-body">
              <div class="summary-head">
                <div class="summary-title-row">
                  <svg class="ic ic--sparkles"><use href="#ic-sparkles"/></svg>
                  <span class="eyebrow">RISK SUMMARY</span>
                </div>
                <h2>3 cancer signals identified</h2>
                <p class="summary-lede">We found factors mentioned during the consultation that may indicate cancer risk. Review the evidence, then confirm or edit the factors in risk assessment.</p>
              </div>
              <div class="summary-list">
                <div class="summary-card"><strong>Persistent cough</strong><p class="muted">"…this annoying little cough that hasn't gone away…"</p></div>
                <div class="summary-card"><strong>Unintentional weight loss</strong><p class="muted">"…lost about a stone without trying…"</p></div>
                <div class="summary-card"><strong>Haematuria</strong><p class="muted">"…urine looked pinkish yesterday…"</p></div>
              </div>
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Currently lives at <code>#detailsOverlay</code> in <code>index.html</code>. Trigger: detection count &gt; 0.</p>
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

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Mobile mic page</h2>
          <p>Phone-side capture screen reached by scanning the QR in the Phone Connection modal. URL contains <code>?mic=&lt;peer-id&gt;</code>.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--phone">
          <div class="proto-phone-frame">
            <div class="proto-phone-frame__notch"></div>
            <div class="proto-phone-frame__screen">
              <div class="mobile-mic proto-mobile-mic--preview">
                <div class="mm-header">
                  <svg class="ic ic--lg mm-logo-ic"><use href="#fic-menu-cts"/></svg>
                  <strong>C the Signs — Ambient AI</strong>
                </div>
                <div class="mm-status">
                  <span class="dot dot--connected"></span>
                  <span>Connected to laptop</span>
                </div>
                <div class="mm-mic-area">
                  <button class="mm-mic-btn">
                    <svg class="ic ic--xl mm-mic-ic"><use href="#fic-mic-sm"/></svg>
                    <span>Tap to listen</span>
                  </button>
                </div>
                <div class="mm-transcript">
                  <span class="muted">Transcript appears here as you speak.</span>
                </div>
                <p class="mm-footnote">Audio stays on this phone. Only the transcribed text is sent to the laptop.</p>
              </div>
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Full-screen page when active. Container above is for preview only — the real page fills the whole viewport.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Status pill (dev utility)</h2>
          <p>PoC-only control surface: transcript toggle, "New patient open" simulation, language picker, STT status line. Will not ship to production.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--util">
          <div class="proto-comp__status-pill">
            <div class="status-pill-row">
              <span class="status-feature">
                <svg class="ic ic--sm"><use href="#ic-sparkles"/></svg>
                Ambient AI <span class="poc-tag">PoC</span>
              </span>
              <span class="lang-picker-wrap">
                <label class="lang-label">Patient speaks:</label>
                <select class="lang-picker" disabled>
                  <option>English</option>
                </select>
              </span>
            </div>
            <div class="status-pill-row status-pill-actions">
              <button class="btn btn--ghost">Show transcript</button>
              <button class="btn btn--primary">
                <svg class="ic ic--sm"><use href="#ic-user-plus"/></svg>
                New patient open
              </button>
            </div>
            <div class="status-pill-note">Web Speech API ready · Click the mic button to begin</div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Top-left of the viewport. Hidden in the Components direction.</p>
        </footer>
      </article>

      <article class="proto-comp">
        <header class="proto-comp__head">
          <h2>Notification card</h2>
          <p>Floats below the Patient button when detections come in. "Risk assess", "Details", "Hide" actions.</p>
        </header>
        <div class="proto-comp__stage proto-comp__stage--util">
          <div class="proto-comp__notif">
            <div class="notif-body">
              <div class="notif-badge">3</div>
              <div class="notif-content">
                <div class="notif-title">3 risk factors detected</div>
                <div class="notif-sub">Latest: Persistent cough · from the consultation</div>
                <div class="notif-actions">
                  <button class="link link--primary">Risk assess</button>
                  <button class="link">Details</button>
                  <button class="link">Hide</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <footer class="proto-comp__foot">
          <p>Currently lives at <code>.notif</code> in <code>index.html</code>.</p>
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

  const RECORDING_STATES = ['idle', 'primer', 'starting', 'listening', 'paused', 'stopping'];
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
      // Skip reconciliation in transient states (timer resolves) and in
      // `primer` (user-choice state, no DOM correlate). Without this,
      // a routine reconcile would silently override primer → idle.
      if (state === 'primer' || isTransitional()) return;
      const isActive = !!(tbStart && tbStart.classList.contains('is-active'));
      const isPaused = !isActive &&
                       !!(listenChip && listenChip.classList.contains('is-paused')) &&
                       !!(listenChip && !listenChip.hidden);
      const want = isActive ? 'listening' : isPaused ? 'paused' : 'idle';
      if (want !== state) set(want);
    }

    // Apply the initial state's body class so derived selectors (e.g.
    // body.proto-idle.view-feed) work on first paint — set() itself short-
    // circuits when next === state, so we paint the baseline manually here.
    document.body.classList.add(`proto-${state}`);

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
      // Listening              → Stop (full reset, with 300ms 'stopping' transition)
      // Paused / Idle / Primer → Start (begin a session)
      // Starting / Stopping    → ignore (already transitioning)
      const s = machine.state;
      if (s === 'listening') {
        machine.set('stopping');
        if (tbStop && !tbStop.disabled) tbStop.click();
      } else if (s === 'paused' || s === 'idle' || s === 'primer') {
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
  function setPatientOpen(open) {
    document.body.classList.toggle('patient-open', open);
    if (patientBtn) patientBtn.classList.toggle('is-surface-open', open);
    try { sessionStorage.setItem(PATIENT_KEY, open ? '1' : '0'); } catch (e) {}
    // Feed direction: opening the patient ALWAYS shows the primer (language
    // confirm + Start / Skip), unless an active session is running. Closing
    // the patient drops back to idle so the surface hides.
    // Note: previously this only triggered from `idle`, which meant stale
    // states ('paused' left over from a failed test, for example) would
    // silently swallow the patient-open click. The new check is permissive:
    // any non-active state opens the primer.
    if (typeof machine !== 'undefined' && document.body.classList.contains('view-feed')) {
      const sessionActive =
        machine.state === 'starting' ||
        machine.state === 'listening' ||
        machine.state === 'stopping';
      if (open && !sessionActive) {
        machine.set('primer');
      } else if (!open) {
        // Patient closed (Skip or toggle off): always drop to idle, regardless
        // of where the machine was. Stops stale states sticking around.
        machine.set('idle');
      }
    }
  }
  if (patientBtn) {
    patientBtn.addEventListener('click', () => {
      setPatientOpen(!document.body.classList.contains('patient-open'));
    });
  }
  const newPatientBtn = document.getElementById('btnNewPatient');
  if (newPatientBtn) {
    newPatientBtn.addEventListener('click', () => setPatientOpen(true));
  }
  // Restore last state for the session
  try {
    if (sessionStorage.getItem(PATIENT_KEY) === '1') setPatientOpen(true);
  } catch (e) {}

  // -------- Feed surface — observers + handlers --------------------------
  // Transcript feed: mirror text from #transcriptBody (already maintained by
  // app.js). Counter chip: mirror count from #tbBadge.
  const transcriptBody = document.getElementById('transcriptBody');
  const tbBadge = document.getElementById('tbBadge');
  const feedTranscript = feedSurface.querySelector('.proto-feed__transcript-text');
  const feedCounter = feedSurface.querySelector('.proto-feed__counter');
  const feedTimer = feedSurface.querySelector('.proto-feed__primary-time');

  function paintFeedTranscript() {
    if (!transcriptBody || !feedTranscript) return;
    // app.js writes a placeholder "<span class='empty'>Transcript will
    // appear here as you speak…</span>" into #transcriptBody before any
    // speech lands. Treat that as empty so the placeholder never leaks
    // into the Feed surface.
    if (transcriptBody.querySelector('.empty')) {
      feedTranscript.textContent = '';
      return;
    }
    const txt = (transcriptBody.textContent || '').replace(/\s+/g, ' ').trim();
    feedTranscript.textContent = txt.slice(-120);
  }
  if (transcriptBody) {
    new MutationObserver(paintFeedTranscript).observe(transcriptBody, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    paintFeedTranscript();
  }

  function paintFeedCounter() {
    if (!feedCounter) return;
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
    feedCounter.textContent = n >= 100 ? '99+' : String(n);
    feedCounter.classList.toggle('proto-feed__counter--empty', n <= 0);
    feedCounter.classList.toggle('is-high', n >= 3);
  }
  if (tbBadge) {
    new MutationObserver(paintFeedCounter).observe(tbBadge, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
    paintFeedCounter();
  }

  // Mirror the timer text from the existing primary meta into the Feed's
  // own time slot — keeps both surfaces showing the same elapsed value.
  const existingMeta = document.querySelector('.proto-ai__primary-meta');
  function paintFeedTimer() {
    if (!feedTimer || !existingMeta) return;
    feedTimer.textContent = existingMeta.textContent || '0:00';
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
    const label = feedSurface.querySelector('.proto-feed__primary-label');
    const btn = feedSurface.querySelector('.proto-feed__primary');
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
    sessionSideList.innerHTML = factors.map((f, i) => `
      <li>
        <div>${escapeHtml(f.name)}</div>
        ${f.phrase ? `<span class="kw-pill">"${escapeHtml(f.phrase)}"</span>` : ''}
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

  feedSurface.querySelector('[data-feed-action="open-summary"]').addEventListener('click', () => {
    if (machine.state === 'listening') {
      if (tbPause && !tbPause.disabled) tbPause.click();
      machine.set('paused');
    }
    openSessionSummary();
  });

  // Primer row buttons
  feedSurface.querySelector('[data-feed-action="start-session"]').addEventListener('click', () => {
    machine.set('starting');
    if (tbStart && !tbStart.disabled) tbStart.click();
  });
  feedSurface.querySelector('[data-feed-action="skip-session"]').addEventListener('click', () => {
    // Skip = no session for this patient. Dismiss the surface entirely by
    // closing the patient context — same effect as toggling the Patient
    // button off. Re-opening the patient (or opening a different one) will
    // re-trigger the primer.
    setPatientOpen(false);
  });

  // Mirror the primer language picker into the existing #langPicker that
  // app.js reads from. Two-way sync — change either, both stay in step.
  const primerLangSelect = feedSurface.querySelector('[data-feed-action="primer-lang"]');
  const appLangPicker = document.getElementById('langPicker');
  if (primerLangSelect && appLangPicker) {
    // Initialise primer select from the app's current value
    primerLangSelect.value = appLangPicker.value;
    primerLangSelect.addEventListener('change', () => {
      appLangPicker.value = primerLangSelect.value;
      // Trigger app.js's change handler so the choice propagates
      appLangPicker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // If something else updates the app picker, mirror back
    appLangPicker.addEventListener('change', () => {
      if (primerLangSelect.value !== appLangPicker.value) {
        primerLangSelect.value = appLangPicker.value;
      }
    });
  }

  // Stop button (visible in paused state)
  feedSurface.querySelector('[data-feed-action="stop"]').addEventListener('click', () => {
    machine.set('stopping');
    if (tbStop && !tbStop.disabled) tbStop.click();
  });

  // Mic Settings popover toggle
  const feedPopover = feedSurface.querySelector('.proto-feed__popover');
  function positionPopover(triggerEl) {
    if (!feedPopover || !triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const wrapRect = feedSurface.getBoundingClientRect();
    // Position relative to the feed surface (which has position: relative implied
    // by being a positioned ancestor in CSS; we'll absolute-position here).
    feedPopover.style.top = (rect.bottom - wrapRect.top + 6) + 'px';
    feedPopover.style.right = (wrapRect.right - rect.right) + 'px';
    feedPopover.style.left = 'auto';
  }
  feedSurface.querySelectorAll('[data-feed-action="mic-settings"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !feedPopover.hidden;
      if (isOpen) {
        feedPopover.hidden = true;
      } else {
        positionPopover(btn);
        feedPopover.hidden = false;
      }
    });
  });
  // Close popover on outside click or Escape
  document.addEventListener('click', (e) => {
    if (feedPopover.hidden) return;
    if (feedPopover.contains(e.target)) return;
    if (e.target.closest('[data-feed-action="mic-settings"]')) return;
    feedPopover.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !feedPopover.hidden) feedPopover.hidden = true;
  });

  // Device picker — visual only; toggle the checkmark active state
  feedPopover.querySelectorAll('[data-feed-device]').forEach((btn) => {
    btn.addEventListener('click', () => {
      feedPopover.querySelectorAll('[data-feed-device]').forEach((b) => {
        b.classList.toggle('proto-feed__pop-device--active', b === btn);
        const chk = b.querySelector('.proto-feed__pop-check');
        if (chk) chk.classList.toggle('proto-feed__pop-check--placeholder', b !== btn);
      });
    });
  });

  // The wrap needs position: relative for the popover anchor to work
  feedSurface.style.position = 'relative';

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
  // Restore saved toolbar position
  try {
    const tbPos = JSON.parse(localStorage.getItem(STORAGE_TB_POS) || 'null');
    if (tbPos && typeof tbPos.x === 'number' && typeof tbPos.y === 'number') {
      toolbarWrap.style.left = tbPos.x + 'px';
      toolbarWrap.style.top = tbPos.y + 'px';
      toolbarWrap.style.transform = 'none';
    }
  } catch (e) {}

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

  tbHandle.addEventListener('mousedown', (e) => { e.preventDefault(); tbDragStart(e.clientX, e.clientY); });
  tbHandle.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; tbDragStart(t.clientX, t.clientY);
  }, { passive: true });

  // -------- 8. Drag — separate AI bar ------------------------------------
  try {
    const sepPos = JSON.parse(localStorage.getItem(STORAGE_SEP_POS) || 'null');
    if (sepPos && typeof sepPos.x === 'number' && typeof sepPos.y === 'number') {
      aiSeparate.style.left = sepPos.x + 'px';
      aiSeparate.style.top = sepPos.y + 'px';
    }
  } catch (e) {}

  const sepGrip = aiSeparate.querySelector('.proto-ai__grip');
  let sepDrag = null;

  function sepDragStart(cx, cy) {
    const rect = aiSeparate.getBoundingClientRect();
    sepDrag = { mx: cx, my: cy, x: rect.left, y: rect.top };
    document.body.style.cursor = 'grabbing';
  }
  function sepDragMove(cx, cy) {
    if (!sepDrag) return;
    const nx = sepDrag.x + (cx - sepDrag.mx);
    const ny = sepDrag.y + (cy - sepDrag.my);
    const maxX = window.innerWidth - aiSeparate.offsetWidth;
    const maxY = window.innerHeight - aiSeparate.offsetHeight;
    aiSeparate.style.left = Math.min(Math.max(0, nx), maxX) + 'px';
    aiSeparate.style.top  = Math.min(Math.max(0, ny), maxY) + 'px';
  }
  function sepDragEnd() {
    if (!sepDrag) return;
    sepDrag = null;
    document.body.style.cursor = '';
    const rect = aiSeparate.getBoundingClientRect();
    try { localStorage.setItem(STORAGE_SEP_POS, JSON.stringify({ x: rect.left, y: rect.top })); } catch (e) {}
  }

  sepGrip.addEventListener('mousedown', (e) => { e.preventDefault(); sepDragStart(e.clientX, e.clientY); });
  sepGrip.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; sepDragStart(t.clientX, t.clientY);
  }, { passive: true });

  // Shared move/end listeners — single source for both drags
  document.addEventListener('mousemove', (e) => { tbDragMove(e.clientX, e.clientY); sepDragMove(e.clientX, e.clientY); });
  document.addEventListener('mouseup', () => { tbDragEnd(); sepDragEnd(); });
  document.addEventListener('touchmove', (e) => {
    if (!tbDrag && !sepDrag) return;
    const t = e.touches[0]; tbDragMove(t.clientX, t.clientY); sepDragMove(t.clientX, t.clientY);
  }, { passive: true });
  document.addEventListener('touchend', () => { tbDragEnd(); sepDragEnd(); });

  // -------- 9. Bootstrap initial view ------------------------------------
  let initialView = 'attached';
  try {
    const fromUrl = new URL(location.href).searchParams.get('view');
    if (fromUrl && VIEWS.includes(fromUrl)) initialView = fromUrl;
    else {
      const saved = localStorage.getItem(STORAGE_VIEW);
      if (saved && VIEWS.includes(saved)) initialView = saved;
    }
  } catch (e) {}
  setView(initialView);
  machine.reconcileFromDOM();
})();
