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
  const VIEWS = ['attached', 'separate'];

  // Figma-extracted SVG symbols live in index.html (the static <defs> block
  // labelled "Figma-aligned symbols") so they're available on the
  // phone-mic page too — prototype.js short-circuits there.

  // -------- 1. View switcher chip ----------------------------------------
  const chip = document.createElement('div');
  chip.className = 'proto-chip';
  chip.setAttribute('role', 'group');
  chip.setAttribute('aria-label', 'UI layout variant');
  chip.innerHTML = `
    <span class="proto-chip__label">Layout</span>
    <button class="proto-chip__btn" data-view="attached">Attached</button>
    <button class="proto-chip__btn" data-view="separate">Separate</button>
  `;
  document.body.appendChild(chip);

  function setView(view) {
    if (!VIEWS.includes(view)) view = 'attached';
    document.body.classList.remove('view-attached', 'view-separate');
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

  const RECORDING_STATES = ['idle', 'starting', 'listening', 'paused', 'stopping'];
  const TRANSITION_MS = 300;
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
      // Skip reconciliation while we're in a transient state — the timer
      // will resolve it. This avoids race conditions where the underlying
      // app.js fires immediately after a click and the observer would
      // overwrite our intentional 'starting' / 'stopping' state.
      if (isTransitional()) return;
      const isActive = !!(tbStart && tbStart.classList.contains('is-active'));
      const isPaused = !isActive &&
                       !!(listenChip && listenChip.classList.contains('is-paused')) &&
                       !!(listenChip && !listenChip.hidden);
      const want = isActive ? 'listening' : isPaused ? 'paused' : 'idle';
      if (want !== state) set(want);
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
      // Listening    → Stop (full reset, with 300ms 'stopping' transition)
      // Paused       → Resume via Start
      // Idle         → Start fresh
      // Starting     → ignore (already starting)
      // Stopping     → ignore (already stopping)
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
  function setPatientOpen(open) {
    document.body.classList.toggle('patient-open', open);
    if (patientBtn) patientBtn.classList.toggle('is-surface-open', open);
    try { sessionStorage.setItem(PATIENT_KEY, open ? '1' : '0'); } catch (e) {}
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
