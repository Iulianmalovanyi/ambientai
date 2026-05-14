// =====================================================================
// Phone-as-microphone connection layer using PeerJS (WebRTC).
//
// Architecture:
//   - Laptop opens the page normally. We create a PeerJS Peer with a
//     random ID and display a QR code containing this page's URL with
//     ?mic=<that-id>.
//   - Phone scans QR, opens the URL. The page detects ?mic= and switches
//     to "mobile mic mode" — a stripped UI that connects back to the
//     laptop's Peer ID, requests the mic, runs the Web Speech API
//     locally, and streams each final transcript over a WebRTC data
//     channel as a JSON message.
//   - Laptop receives messages and feeds the text into the same
//     detection pipeline the local mic uses.
//
// No raw audio crosses the network — only the resulting text. The PeerJS
// public broker is used for signalling (free, no server we need to host).
// =====================================================================

const PEERJS_CONFIG = {
  // Use the free public PeerJS cloud broker for signalling. ICE servers
  // are STUN + free public TURN relays (Metered OpenRelay) so cross-network
  // connections (e.g. phone on cellular, laptop on Wi-Fi) can still
  // negotiate. Without TURN, only same-LAN typically works.
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: [
          'turn:relay1.expressturn.com:3478',
          'turn:relay1.expressturn.com:3478?transport=tcp'
        ],
        username: 'efJBIBF6IRZE9YGJLW',
        credential: 'tcXVQHCqYr08Yz4n'
      }
    ]
  },
  debug: 2
};

// -------------------- DESKTOP / LAPTOP SIDE --------------------

/**
 * Start a peer on the laptop and wait for a phone to connect.
 * @param {object} handlers
 *   - onPeerId(id)            – called once we have an ID (use to render QR)
 *   - onPhoneConnected()      – phone has opened a data channel
 *   - onTranscript(text, isFinal) – text from phone (final transcripts only,
 *                                   isFinal always true in this PoC)
 *   - onPhoneDisconnected()
 *   - onError(message)
 * @returns { stop }
 */
export function startLaptopPeer(handlers) {
  if (!window.Peer) {
    handlers.onError?.('PeerJS library failed to load.');
    return { stop() {} };
  }
  const peer = new window.Peer(undefined, PEERJS_CONFIG);
  let activeConn = null;

  peer.on('open', (id) => {
    console.log('[Phone] laptop peer open with id:', id);
    handlers.onPeerId?.(id);
  });

  peer.on('connection', (conn) => {
    if (activeConn) {
      // Refuse second connection in PoC — only one phone at a time
      try { conn.close(); } catch (_) {}
      return;
    }
    activeConn = conn;
    conn.on('open', () => {
      console.log('[Phone] connection open');
      handlers.onPhoneConnected?.();
    });
    conn.on('data', (raw) => {
      try {
        const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (msg.type === 'transcript' && typeof msg.text === 'string') {
          handlers.onTranscript?.(msg.text, msg.isFinal !== false);
        } else if (msg.type === 'status') {
          console.log('[Phone] status:', msg.value);
        }
      } catch (e) {
        console.warn('[Phone] bad message', raw, e);
      }
    });
    conn.on('close', () => {
      console.log('[Phone] connection closed');
      activeConn = null;
      handlers.onPhoneDisconnected?.();
    });
    conn.on('error', (err) => {
      console.warn('[Phone] connection error', err);
      handlers.onError?.(`Connection error: ${err.message || err}`);
    });
  });

  peer.on('error', (err) => {
    console.warn('[Phone] peer error', err);
    handlers.onError?.(`Peer error: ${err.type || err.message || err}`);
  });

  return {
    stop() {
      try { activeConn?.close(); } catch (_) {}
      try { peer.destroy(); } catch (_) {}
    }
  };
}

/**
 * Build the URL that the phone should open. Uses the current page URL,
 * appending (or replacing) the ?mic= parameter.
 */
export function buildPhoneUrl(peerId) {
  const u = new URL(window.location.href);
  u.searchParams.set('mic', peerId);
  // Strip any other params we might have to keep it simple
  return u.toString();
}

// -------------------- MOBILE / PHONE SIDE --------------------

/**
 * On the phone, connect back to the laptop peer.
 * @param {string} targetPeerId
 * @param {object} handlers
 *   - onConnected()
 *   - onDisconnected()
 *   - onError(message)
 * @returns { sendTranscript(text, isFinal), stop }
 */
export function startPhonePeer(targetPeerId, handlers) {
  if (!window.Peer) {
    handlers.onError?.('PeerJS library failed to load.');
    return { sendTranscript: () => {}, stop() {} };
  }
  const peer = new window.Peer(undefined, PEERJS_CONFIG);
  let conn = null;

  peer.on('open', (myId) => {
    console.log('[Phone] phone peer open with id:', myId, '→ connecting to', targetPeerId);
    conn = peer.connect(targetPeerId, { reliable: true });
    conn.on('open', () => {
      console.log('[Phone] data channel open');
      handlers.onConnected?.();
    });
    conn.on('close', () => {
      console.log('[Phone] data channel closed');
      handlers.onDisconnected?.();
    });
    conn.on('error', (err) => {
      console.warn('[Phone] conn error', err);
      handlers.onError?.(`Connection error: ${err.message || err}`);
    });
  });

  peer.on('error', (err) => {
    console.warn('[Phone] peer error', err);
    handlers.onError?.(`Peer error: ${err.type || err.message || err}`);
  });

  return {
    sendTranscript(text, isFinal = true) {
      if (!conn || !conn.open) return;
      try {
        conn.send(JSON.stringify({ type: 'transcript', text, isFinal }));
      } catch (e) {
        console.warn('[Phone] send failed', e);
      }
    },
    sendStatus(value) {
      if (!conn || !conn.open) return;
      try {
        conn.send(JSON.stringify({ type: 'status', value }));
      } catch (_) {}
    },
    stop() {
      try { conn?.close(); } catch (_) {}
      try { peer.destroy(); } catch (_) {}
    }
  };
}
