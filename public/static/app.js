/**
 * ================================================================
 * XIAOZHI WEB CLIENT — VIRTUAL ESP32 DEVICE EMULATOR
 * ================================================================
 *
 * OPUS ENCODING NOTE:
 * This module dynamically imports libopus-wasm from jsDelivr CDN for
 * real Opus encoding/decoding. The server REQUIRES genuine Opus frames.
 * Sending raw PCM causes "Error occurred while processing message" errors.
 * ================================================================
 *
 * ARCHITECTURE REPORT:
 * This file implements a complete software emulation of an ESP32
 * device communicating with the Xiaozhi AI server ecosystem.
 *
 * PROTOCOL DOCUMENTATION (Reverse-Engineered):
 *
 * Connection:
 *   WebSocket URL:    wss://api.xiaozhi.me/xiaozhi/v1/
 *   Required Headers:
 *     Authorization:    "Bearer <access_token>"
 *     Protocol-Version: "1" (or "2" or "3")
 *     Device-Id:        "<MAC-style 12-hex-char address>"
 *     Client-Id:        "<UUID v4>"
 *
 * Handshake (Device → Server):
 *   {
 *     "type": "hello",
 *     "version": 1,
 *     "features": { "mcp": true },
 *     "transport": "websocket",
 *     "audio_params": {
 *       "format": "opus",
 *       "sample_rate": 16000,
 *       "channels": 1,
 *       "frame_duration": 60
 *     }
 *   }
 *
 * Handshake ACK (Server → Device):
 *   {
 *     "type": "hello",
 *     "transport": "websocket",
 *     "session_id": "<session-uuid>",
 *     "audio_params": { "format": "opus", "sample_rate": 24000, ... }
 *   }
 *
 * Session Messages:
 *
 * [Device→Server] Start Listening:
 *   { "session_id": "...", "type": "listen", "state": "start", "mode": "manual" }
 *
 * [Device→Server] Stop Listening:
 *   { "session_id": "...", "type": "listen", "state": "stop" }
 *
 * [Device→Server] Abort TTS:
 *   { "session_id": "...", "type": "abort", "reason": "wake_word_detected" }
 *
 * [Server→Device] STT Result:
 *   { "session_id": "...", "type": "stt", "text": "what user said" }
 *
 * [Server→Device] LLM Emotion:
 *   { "session_id": "...", "type": "llm", "emotion": "happy", "text": "😀" }
 *
 * [Server→Device] TTS Start:
 *   { "session_id": "...", "type": "tts", "state": "start" }
 *
 * [Server→Device] TTS Sentence:
 *   { "session_id": "...", "type": "tts", "state": "sentence_start", "text": "..." }
 *
 * [Server→Device] TTS Stop:
 *   { "session_id": "...", "type": "tts", "state": "stop" }
 *
 * [Server→Device] System Command:
 *   { "session_id": "...", "type": "system", "command": "reboot" }
 *
 * Binary Protocol (Version 1 = default):
 *   Raw Opus frames, no header. Binary WebSocket frames.
 *
 * Binary Protocol (Version 2):
 *   struct { uint16_t version; uint16_t type; uint32_t reserved;
 *            uint32_t timestamp; uint32_t payload_size; uint8_t payload[]; }
 *
 * Binary Protocol (Version 3):
 *   struct { uint8_t type; uint8_t reserved; uint16_t payload_size;
 *            uint8_t payload[]; }
 *
 * Audio:
 *   Upload:   Opus encoded at 16kHz, mono, 60ms frames (960 samples)
 *   Playback: Server sends Opus at 24kHz (server-side), decoded for playback
 *
 * TEXT-ONLY MODE (no audio):
 *   The Xiaozhi server supports text interaction. The device can send
 *   a "listen" with mode="manual" and then immediately "stop" without
 *   sending any audio. However, the server may expect audio frames.
 *
 *   Better approach: Send listen{start}, then after a brief moment
 *   send a fake "stt" result through a DIFFERENT approach. Actually,
 *   the correct text-only approach is:
 *
 *   The server xinnan-tech/xiaozhi-esp32-server has a text mode where
 *   the client sends audio with the speech. For text-only mode we need
 *   to encode the text as Opus audio OR use the fact that the server
 *   also has an HTTP API for testing.
 *
 *   Actually from the protocol docs and code: the device sends listen{start},
 *   then binary Opus audio, then listen{stop}. The server's ASR transcribes
 *   it. For a WEB CLIENT, we use the Web Speech API to convert text→speech,
 *   encode as Opus, and send. OR we just send text directly if the server
 *   supports a text mode.
 *
 *   From the Python client code and server docs: some server implementations
 *   accept a "text" field in the listen start message:
 *   { "type": "listen", "state": "start", "mode": "manual", "text": "hello" }
 *   This is NOT standard but some servers support it as a shortcut.
 *
 *   We will implement BOTH modes:
 *   1. Text mode: listen{start, text:"..."} → listen{stop}  (server shortcut)
 *   2. Audio mode: mic → Opus → binary frames
 * ================================================================
 */

'use strict';

// ================================================================
// MODULE: Logger
// Outputs to debug console panel with timestamps and tags
// ================================================================
const Logger = (() => {
  const logEl = document.getElementById('debugLog');
  const LEVELS = ['BOOT','AUTH','WS','CHAT','PROTO','AUDIO','ERROR','WARN','INFO','STATE','MCP','VISION'];

  function log(tag, message, data = null) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0] + '.' +
                    String(now.getMilliseconds()).padStart(3, '0');

    // Console output
    const prefix = `[${tag}]`;
    if (tag === 'ERROR') {
      console.error(prefix, message, data || '');
    } else if (tag === 'WARN') {
      console.warn(prefix, message, data || '');
    } else {
      console.log(prefix, message, data || '');
    }

    // Debug panel output
    if (logEl) {
      const entry = document.createElement('div');
      entry.className = 'log-entry';

      const sanitizedTag = LEVELS.includes(tag) ? tag : 'INFO';

      let msgText = message;
      if (data !== null) {
        try {
          msgText += ' ' + (typeof data === 'object' ? JSON.stringify(data) : data);
        } catch (e) { /* ignore */ }
      }

      entry.innerHTML = `
        <span class="log-time">${timeStr}</span>
        <span class="log-tag ${sanitizedTag}">[${sanitizedTag}]</span>
        <span class="log-msg">${escapeHtml(msgText)}</span>
      `;
      logEl.appendChild(entry);

      // Auto-scroll to bottom
      requestAnimationFrame(() => {
        logEl.scrollTop = logEl.scrollHeight;
      });
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    boot:  (msg, d) => log('BOOT',  msg, d),
    auth:  (msg, d) => log('AUTH',  msg, d),
    ws:    (msg, d) => log('WS',    msg, d),
    chat:  (msg, d) => log('CHAT',  msg, d),
    proto: (msg, d) => log('PROTO', msg, d),
    audio: (msg, d) => log('AUDIO', msg, d),
    error: (msg, d) => log('ERROR', msg, d),
    warn:  (msg, d) => log('WARN',  msg, d),
    info:  (msg, d) => log('INFO',  msg, d),
    state: (msg, d) => log('STATE', msg, d),
    mcp:   (msg, d) => log('MCP',   msg, d),
    vision: (msg, d) => log('VISION', msg, d),
  };
})();

// ================================================================
// MODULE: AvatarStorage                                   [PHASE 4]
// ----------------------------------------------------------------
// Clean storage abstraction for assistant avatars.
// Currently implemented with localStorage (base64 data URLs).
// The interface is designed to be swapped out for Cloudflare R2
// in Phase 5 without changing any UI code.
//
// API surface:
//   AvatarStorage.save(assistantId, dataUrl) → void
//   AvatarStorage.load(assistantId)          → dataUrl | null
//   AvatarStorage.remove(assistantId)        → void
//
// Safety guarantee: ALL methods are wrapped in try/catch so avatar
// failures can NEVER prevent Olivia from booting.
// ================================================================
const AvatarStorage = (() => {
  const KEY_PREFIX = 'olivia_avatar_v1_';

  function key(assistantId) {
    return KEY_PREFIX + assistantId;
  }

  /** Save a data-URL avatar for an assistant. */
  function save(assistantId, dataUrl) {
    try {
      if (!assistantId || !dataUrl) return;
      localStorage.setItem(key(assistantId), dataUrl);
    } catch (e) {
      Logger.warn('[AvatarStorage] save failed', e.message);
    }
  }

  /** Load a data-URL avatar for an assistant. Returns null if not set. */
  function load(assistantId) {
    try {
      if (!assistantId) return null;
      return localStorage.getItem(key(assistantId)) || null;
    } catch (e) {
      Logger.warn('[AvatarStorage] load failed', e.message);
      return null;
    }
  }

  /** Remove an assistant's avatar from storage. */
  function remove(assistantId) {
    try {
      if (!assistantId) return;
      localStorage.removeItem(key(assistantId));
    } catch (e) {
      Logger.warn('[AvatarStorage] remove failed', e.message);
    }
  }

  return { save, load, remove };
})();

// ================================================================
// MODULE: AvatarSystem                                    [PHASE 4]
// ----------------------------------------------------------------
// High-level avatar management: resize + save, render everywhere,
// open upload dialog, manage the hidden file input.
//
// Safety: all DOM access is guarded so avatar errors NEVER block boot.
// ================================================================
const AvatarSystem = (() => {
  const DEFAULT_AVATAR = '/static/olivia-avatar-default.svg';
  const TARGET_SIZE = 256;

  /** Return cached data URL for an assistant, or null if none. */
  function getAvatarDataUrl(assistantId) {
    try {
      return AvatarStorage.load(assistantId) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Resize an image File/Blob to TARGET_SIZE x TARGET_SIZE using
   * an off-screen canvas, then compress as JPEG.
   * Returns a Promise<string> with the data URL.
   */
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      try {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          const canvas = document.createElement('canvas');
          canvas.width  = TARGET_SIZE;
          canvas.height = TARGET_SIZE;
          const ctx = canvas.getContext('2d');
          // Center-crop to square, then scale
          const size = Math.min(img.naturalWidth, img.naturalHeight);
          const sx = (img.naturalWidth  - size) / 2;
          const sy = (img.naturalHeight - size) / 2;
          ctx.drawImage(img, sx, sy, size, size, 0, 0, TARGET_SIZE, TARGET_SIZE);
          // Compress as JPEG at 85% quality
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve(dataUrl);
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Image failed to load'));
        };
        img.src = objectUrl;
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Process a File, resize it, and save as avatar for the given assistant.
   * Returns the data URL on success, or null on failure.
   */
  async function processAndSave(assistantId, file) {
    try {
      const dataUrl = await resizeImage(file);
      AvatarStorage.save(assistantId, dataUrl);
      Logger.info(`[AvatarSystem] Avatar saved for ${assistantId.slice(0, 8)}`);
      return dataUrl;
    } catch (e) {
      Logger.warn('[AvatarSystem] Failed to process avatar image', e.message);
      return null;
    }
  }

  /**
   * Set an element's src safely.
   * Uses the default avatar if dataUrl is falsy.
   */
  function setImgSrc(imgEl, dataUrl) {
    if (!imgEl) return;
    try {
      imgEl.src = dataUrl || DEFAULT_AVATAR;
    } catch (e) { /* ignore */ }
  }

  /**
   * Refresh ALL avatar display locations for the active assistant:
   * - chat header avatar
   * - typing indicator avatar
   * - settings panel avatar (if settings are open)
   */
  function refreshAllAvatarDisplays() {
    try {
      const activeId = AssistantManager.getActiveId();
      const dataUrl  = getAvatarDataUrl(activeId);

      setImgSrc(document.getElementById('chatHeaderAvatarImg'), dataUrl);
      setImgSrc(document.getElementById('typingAvatarImg'), dataUrl);
      // Settings avatar only if the settings panel is currently showing this assistant
      // (it will be re-loaded by loadSettingsIntoForm() when opened anyway)
    } catch (e) {
      Logger.warn('[AvatarSystem] refreshAllAvatarDisplays error', e.message);
    }
  }

  /**
   * Open the avatar upload dialog for a specific assistant.
   * The hidden #avatarFileInput is used as the file picker.
   */
  function openUploadDialog(assistantId) {
    try {
      const input = document.getElementById('avatarFileInput');
      if (!input) return;
      // Store the target assistant id on the input element so the change
      // handler knows who the upload is for.
      input.dataset.targetAssistantId = assistantId;
      input.value = '';
      input.click();
    } catch (e) {
      Logger.warn('[AvatarSystem] openUploadDialog error', e.message);
    }
  }

  /**
   * Initialize: wire the hidden avatar file input to process uploads.
   * Called once from UIController.init().
   */
  function init() {
    try {
      const input = document.getElementById('avatarFileInput');
      if (!input) return;

      input.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const targetId = input.dataset.targetAssistantId || AssistantManager.getActiveId();
        input.value = '';

        // Show a brief loading toast
        if (typeof showToast === 'function') showToast('Processing avatar...', 'info', null, 2000);

        const dataUrl = await processAndSave(targetId, file);
        if (!dataUrl) {
          if (typeof showToast === 'function') showToast('Could not process image', 'error');
          return;
        }

        // Refresh avatar in all display locations
        refreshAllAvatarDisplays();

        // Refresh sidebar list (re-renders all conv-avatars)
        if (typeof UIController !== 'undefined') UIController.renderAssistantList();

        // Refresh settings panel avatar if it's showing the same assistant
        const settingsImg = document.getElementById('settingsAvatarImg');
        if (settingsImg) {
          const settingsPanel = document.getElementById('settingsPanel');
          if (settingsPanel && settingsPanel.classList.contains('open')) {
            // Check if settings panel is targeting this assistant
            setImgSrc(settingsImg, dataUrl);
          }
        }

        if (typeof showToast === 'function') showToast('Avatar updated!', 'success');
      });

      // Wire chat header avatar click
      const chatHeaderAvatar = document.getElementById('chatHeaderAvatar');
      if (chatHeaderAvatar) {
        chatHeaderAvatar.addEventListener('click', () => {
          openUploadDialog(AssistantManager.getActiveId());
        });
      }

      // Wire settings upload button
      const settingsUploadBtn = document.getElementById('settingsUploadAvatarBtn');
      if (settingsUploadBtn) {
        settingsUploadBtn.addEventListener('click', () => {
          // Target the assistant currently shown in settings
          const targetId = (typeof UIController !== 'undefined')
            ? UIController.getSettingsTargetIdPublic()
            : AssistantManager.getActiveId();
          openUploadDialog(targetId);
        });
      }

      // Wire settings remove button
      const settingsRemoveBtn = document.getElementById('settingsRemoveAvatarBtn');
      if (settingsRemoveBtn) {
        settingsRemoveBtn.addEventListener('click', () => {
          const targetId = (typeof UIController !== 'undefined')
            ? UIController.getSettingsTargetIdPublic()
            : AssistantManager.getActiveId();
          AvatarStorage.remove(targetId);
          const settingsImg = document.getElementById('settingsAvatarImg');
          setImgSrc(settingsImg, null);
          refreshAllAvatarDisplays();
          if (typeof UIController !== 'undefined') UIController.renderAssistantList();
          if (typeof showToast === 'function') showToast('Avatar removed', 'info');
        });
      }

      Logger.boot('[AvatarSystem] Initialized');
    } catch (e) {
      // CRITICAL: avatar init MUST NOT prevent boot
      Logger.warn('[AvatarSystem] init error (non-fatal)', e.message);
    }
  }

  /**
   * Load avatar into the settings panel for the given assistant.
   * Called from UIController.loadSettingsIntoForm().
   */
  function loadSettingsAvatar(assistantId) {
    try {
      const dataUrl = getAvatarDataUrl(assistantId);
      const settingsImg = document.getElementById('settingsAvatarImg');
      setImgSrc(settingsImg, dataUrl);
    } catch (e) {
      Logger.warn('[AvatarSystem] loadSettingsAvatar error', e.message);
    }
  }

  return {
    init,
    getAvatarDataUrl,
    openUploadDialog,
    processAndSave,
    refreshAllAvatarDisplays,
    loadSettingsAvatar,
    DEFAULT_AVATAR,
  };
})();

// ================================================================
// MODULE: VolumeStorage                                   [OLIVIA FEATURE]
// ----------------------------------------------------------------
// Clean storage abstraction for per-assistant local speech volume.
// Mirrors AvatarStorage exactly: one localStorage entry per assistant,
// every method guarded so a storage failure can NEVER block boot or
// break chat. Stores a single float 0.0–1.0.
//
// API surface:
//   VolumeStorage.save(assistantId, volume)   → void
//   VolumeStorage.load(assistantId)           → volume (0..1) | null
//   VolumeStorage.remove(assistantId)         → void
// ================================================================
const VolumeStorage = (() => {
  const KEY_PREFIX = 'olivia_volume_v1_';

  function key(assistantId) {
    return KEY_PREFIX + assistantId;
  }

  /** Save this assistant's local playback volume (0.0 - 1.0). */
  function save(assistantId, volume) {
    try {
      if (!assistantId) return;
      const clamped = Math.max(0, Math.min(1, Number(volume)));
      localStorage.setItem(key(assistantId), String(clamped));
    } catch (e) {
      Logger.warn('[VolumeStorage] save failed', e.message);
    }
  }

  /** Load this assistant's saved volume. Returns null if never set
   *  (caller should fall back to the 100% default). */
  function load(assistantId) {
    try {
      if (!assistantId) return null;
      const raw = localStorage.getItem(key(assistantId));
      if (raw === null) return null;
      const v = parseFloat(raw);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
    } catch (e) {
      Logger.warn('[VolumeStorage] load failed', e.message);
      return null;
    }
  }

  /** Remove a saved volume (called when an assistant is deleted). */
  function remove(assistantId) {
    try {
      if (!assistantId) return;
      localStorage.removeItem(key(assistantId));
    } catch (e) {
      Logger.warn('[VolumeStorage] remove failed', e.message);
    }
  }

  return { save, load, remove };
})();

// ================================================================
// MODULE: VolumeSystem                                    [OLIVIA FEATURE]
// ----------------------------------------------------------------
// PER-ASSISTANT SPEECH VOLUME — local Olivia playback only.
//
// This module NEVER touches the Xiaozhi WebSocket protocol, ProtocolClient,
// AssistantManager's persisted schema, SessionManager, pairing, or
// provisioning. It is a self-contained add-on, structured exactly like
// AvatarSystem/AvatarStorage above:
//
//   VolumeStorage (localStorage layer)  →  VolumeSystem (UI + logic layer)
//     ├─ wires the Speaker button + floating slider popup in the chat header
//     ├─ persists per-assistant volume, restores it on assistant switch
//     ├─ applies volume LIVE to AudioEngine's shared TTS gain node — but,
//     |    exactly like AudioEngine's mic capture / TTS queue elsewhere in
//     |    this codebase, ONLY for the assistant currently on screen (a
//     |    single shared speaker is a hardware resource, not per-session)
//     ├─ parses natural-language volume commands ("lower your volume",
//     |    "set your volume to 60%", "mute yourself", ...) and, if matched,
//     |    intercepts them BEFORE ChatEngine.sendTextMessage() so Xiaozhi
//     |    never sees them — see tryHandleLocalCommand(), called from
//     |    UIController.handleSendClick()
//     └─ exposes handleClientAction() as a clean, NOT-YET-WIRED extension
//          point for a future structured `{"type":"client_action",
//          "action":"set_volume","value":0.4}` message arriving from
//          Xiaozhi over the EXISTING, unmodified 'custom' message type
//          (see ProtocolClient's onCustom callback) — see HANDOFF.md.
//
// Safety: every public entry point is wrapped so a volume-feature bug
// can NEVER prevent Olivia from booting, connecting, or chatting.
// ================================================================
const VolumeSystem = (() => {
  const DEFAULT_VOLUME = 1.0;      // 100% — the spec's required default
  const STEP = 0.15;               // relative step for "louder"/"quieter" style commands

  // In-memory only (NOT persisted): remembers the volume an assistant had
  // right before "mute yourself" so "unmute" can restore it. Deliberately
  // not persisted — if the page reloads while muted, unmute falls back to
  // the saved/default volume, which is a safe, simple behaviour to document
  // in HANDOFF.md rather than growing the storage schema for an edge case.
  const preMuteVolumes = {};

  /** This assistant's effective volume: saved value, or 100% default. */
  function getVolume(assistantId) {
    const v = VolumeStorage.load(assistantId);
    return v === null ? DEFAULT_VOLUME : v;
  }

  function el(id) { return document.getElementById(id); }

  function iconClassFor(volume) {
    if (volume <= 0) return 'fas fa-volume-xmark';
    if (volume < 0.5) return 'fas fa-volume-low';
    return 'fas fa-volume-high';
  }

  /** Paint the slider/label/header icon to match a volume (0..1). Purely
   *  cosmetic — never touches storage or AudioEngine itself. */
  function paintUI(volume) {
    try {
      const pct = Math.round(volume * 100);
      const slider = el('volumeSlider');
      const label  = el('volumeSliderLabel');
      const icon   = el('speakerBtnIcon');
      if (slider) slider.value = String(pct);
      if (label) label.textContent = pct + '%';
      if (icon) icon.className = iconClassFor(volume);
    } catch (e) {
      Logger.warn('[VolumeSystem] paintUI error (non-fatal)', e.message);
    }
  }

  /**
   * Set an assistant's local playback volume. Always persists. Only
   * applies to the live AudioEngine gain node + repaints the UI when
   * `assistantId` is the assistant currently on screen — matches the
   * existing rule elsewhere in this app that the shared speaker/mic
   * hardware resources are gated by "is this the active assistant?".
   */
  function setVolume(assistantId, volume, opts = {}) {
    const clamped = Math.max(0, Math.min(1, Number(volume) || 0));
    VolumeStorage.save(assistantId, clamped);
    if (assistantId === AssistantManager.getActiveId()) {
      AudioEngine.setVolume(clamped);
      if (opts.paint !== false) paintUI(clamped);
    }
    return clamped;
  }

  /** Re-sync the slider/icon + live gain node for whichever assistant is
   *  NOW active. Call this after every assistant switch — mirrors
   *  AvatarSystem.refreshAllAvatarDisplays(). Safe / non-fatal on error. */
  function refreshActiveVolume() {
    try {
      const activeId = AssistantManager.getActiveId();
      if (!activeId) return;
      const volume = getVolume(activeId);
      AudioEngine.setVolume(volume);
      paintUI(volume);
    } catch (e) {
      Logger.warn('[VolumeSystem] refreshActiveVolume error (non-fatal)', e.message);
    }
  }

  // ── Floating popup open/close ───────────────────────────────────────
  function openPopup() {
    const popup = el('volumePopup');
    if (popup) popup.style.display = 'block';
  }
  function closePopup() {
    const popup = el('volumePopup');
    if (popup) popup.style.display = 'none';
  }
  function isPopupOpen() {
    const popup = el('volumePopup');
    return !!popup && popup.style.display !== 'none';
  }

  /**
   * Initialize: wire the Speaker button, its floating slider popup, and
   * outside-click-to-close. Called once from UIController.init(), inside
   * a try/catch — a failure here MUST NOT prevent the rest of the app
   * from booting (same guarantee AvatarSystem.init() makes).
   */
  function init() {
    try {
      const speakerBtn = el('speakerBtn');
      const popup       = el('volumePopup');
      const slider      = el('volumeSlider');
      const wrapper     = el('speakerBtnWrapper');
      if (!speakerBtn || !popup || !slider || !wrapper) {
        Logger.warn('[VolumeSystem] UI elements missing — skipping init');
        return;
      }

      speakerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isPopupOpen()) closePopup();
        else openPopup();
      });

      // Click outside the speaker button/popup closes it (spec requirement).
      document.addEventListener('click', (e) => {
        if (!isPopupOpen()) return;
        if (wrapper.contains(e.target)) return;
        closePopup();
      });

      // Live update as the slider moves — no Save button, per spec.
      slider.addEventListener('input', () => {
        const pct = parseInt(slider.value, 10);
        if (Number.isNaN(pct)) return;
        const activeId = AssistantManager.getActiveId();
        if (!activeId) return;
        setVolume(activeId, pct / 100, { paint: false }); // slider is already correct; just persist+apply gain
        const label = el('volumeSliderLabel');
        if (label) label.textContent = pct + '%';
        const icon = el('speakerBtnIcon');
        if (icon) icon.className = iconClassFor(pct / 100);
      });

      // Paint initial state for whichever assistant loads first.
      refreshActiveVolume();

      Logger.boot('[VolumeSystem] Initialized');
    } catch (e) {
      // CRITICAL: volume feature init MUST NOT prevent boot.
      Logger.warn('[VolumeSystem] init error (non-fatal)', e.message);
    }
  }

  // ── Natural-language local volume command parsing ──────────────────
  /**
   * Try to recognize `rawText` as a LOCAL volume command (handled
   * entirely by Olivia, never sent to Xiaozhi). Returns a small
   * descriptor object on match, or null if this is ordinary chat text.
   *
   * Deliberately anchored (^...$) against the whole (trimmed, lowercased)
   * message rather than matched as a substring — so normal conversation
   * that happens to mention the word "volume" (e.g. "turn the volume up
   * on the story you're telling me") is never misfired as a command.
   */
  function parseVolumeCommand(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;

    let text = rawText.trim().toLowerCase();
    if (!text) return null;
    // Strip trailing punctuation and common polite prefixes.
    text = text.replace(/[.!?]+$/, '').trim();
    text = text.replace(/^(please|hey olivia|olivia|can you|could you|would you)[,:]?\s+/i, '').trim();

    const pct = (n) => Math.max(0, Math.min(100, parseInt(n, 10))) / 100;

    // ── Mute / Unmute ──────────────────────────────────────────────
    if (/^mute(\s+yourself)?$/.test(text)) {
      return { action: 'mute' };
    }
    if (/^unmute(\s+yourself)?$/.test(text) || /^turn\s+(the\s+)?sound\s+back\s+on$/.test(text)) {
      return { action: 'unmute' };
    }

    // ── Extremes: "maximum volume", "volume max", "set volume to 100%" ──
    if (/^(set\s+)?(your\s+|the\s+)?volume\s+to\s+(max(imum)?|100\s*%?)$/.test(text) ||
        /^(max(imum)?\s+volume|volume\s+max(imum)?)$/.test(text)) {
      return { action: 'set', value: 1.0 };
    }
    if (/^(set\s+)?(your\s+|the\s+)?volume\s+to\s+(min(imum)?|0\s*%?)$/.test(text) ||
        /^(min(imum)?\s+volume|volume\s+min(imum)?)$/.test(text)) {
      return { action: 'set', value: 0.0 };
    }

    // ── Explicit percent/number: "set your volume to 25 percent",
    //    "set volume to 80%", "volume 60", "turn your volume to 60" ──
    let m = text.match(/^set\s+(?:your\s+|the\s+)?volume\s+to\s+(\d{1,3})\s*(?:%|percent)?$/);
    if (m) return { action: 'set', value: pct(m[1]) };

    m = text.match(/^turn\s+(?:your\s+|the\s+)?volume\s+to\s+(\d{1,3})\s*(?:%|percent)?$/);
    if (m) return { action: 'set', value: pct(m[1]) };

    m = text.match(/^volume\s+(?:to\s+)?(\d{1,3})\s*(?:%|percent)?$/);
    if (m) return { action: 'set', value: pct(m[1]) };

    // ── Relative step commands ──────────────────────────────────────
    if (/^(lower\s+your\s+volume|turn\s+yourself\s+down|turn\s+(?:your\s+|the\s+)?volume\s+down|decrease\s+your\s+volume|volume\s+down|quiet(?:er)?(?:\s+please)?|be\s+quieter)$/.test(text)) {
      return { action: 'delta', direction: 'down' };
    }
    if (/^(increase\s+your\s+volume|turn\s+yourself\s+up|turn\s+(?:your\s+|the\s+)?volume\s+up|raise\s+your\s+volume|volume\s+up|louder(?:\s+please)?|be\s+louder)$/.test(text)) {
      return { action: 'delta', direction: 'up' };
    }

    return null;
  }

  /**
   * Attempt to handle `text` as a local volume command for the CURRENTLY
   * ACTIVE assistant. Returns true if it was recognized and fully handled
   * (volume changed, UI updated, confirmation shown) — the caller
   * (UIController.handleSendClick) must then SKIP sending the message to
   * Xiaozhi. Returns false for ordinary chat text, which the caller
   * should send exactly as before.
   */
  function tryHandleLocalCommand(text) {
    try {
      const parsed = parseVolumeCommand(text);
      if (!parsed) return false;

      const activeId = AssistantManager.getActiveId();
      const active    = AssistantManager.getActiveAssistant();
      if (!activeId || !active) return false;

      let newVolume;
      switch (parsed.action) {
        case 'mute':
          preMuteVolumes[activeId] = getVolume(activeId);
          newVolume = 0;
          break;
        case 'unmute': {
          const remembered = preMuteVolumes[activeId];
          newVolume = (typeof remembered === 'number' && remembered > 0) ? remembered : DEFAULT_VOLUME;
          break;
        }
        case 'set':
          newVolume = parsed.value;
          break;
        case 'delta': {
          const current = getVolume(activeId);
          newVolume = parsed.direction === 'up' ? current + STEP : current - STEP;
          break;
        }
        default:
          return false;
      }

      const applied = setVolume(activeId, newVolume);
      const appliedPct = Math.round(applied * 100);

      const confirmation = parsed.action === 'mute'
        ? `${active.name} volume muted.`
        : `${active.name} volume set to ${appliedPct}%.`;

      // Local confirmation — rendered via the SAME "system" message style
      // used for "Connected to server" / "Chat cleared" etc, so it is
      // visually distinct from a real AI reply bubble (spec requirement).
      if (typeof UIController !== 'undefined') {
        UIController.addSystemMessage(confirmation, 'fa-volume-high');
      }
      if (typeof showToast === 'function') {
        showToast(confirmation, 'info');
      }

      Logger.info(`[VolumeSystem] Local command intercepted: "${text}" → ${JSON.stringify(parsed)} ⇒ ${appliedPct}%`);
      return true;
    } catch (e) {
      Logger.warn('[VolumeSystem] tryHandleLocalCommand error (non-fatal)', e.message);
      return false; // fail open — never block a real chat message on a bug here
    }
  }

  /**
   * ── FUTURE EXTENSION POINT (not wired to any protocol handler yet) ──
   * Structured client_action commands from Xiaozhi, e.g.:
   *   { "type": "client_action", "action": "set_volume", "value": 0.4 }
   *
   * ProtocolClient already has an unused 'custom' message type +
   * onCustom callback (see MODULE: ProtocolClient, handleTextMessage's
   * `case 'custom'` branch) — that plumbing is NOT touched by this
   * feature. A future phase can, WITHOUT inventing any new protocol
   * message type, forward a `custom` payload shaped like the above into
   * this function from SessionManager's `protocol.on('custom', ...)`
   * wiring. See HANDOFF.md → "Future AI-controlled client action
   * architecture" for the exact call site to add.
   *
   * This function is intentionally NOT called anywhere in this phase.
   */
  function handleClientAction(assistantId, action) {
    try {
      if (!assistantId || !action || action.type !== 'client_action') return false;
      switch (action.action) {
        case 'set_volume':
          if (typeof action.value === 'number') {
            setVolume(assistantId, action.value);
            return true;
          }
          return false;
        default:
          return false; // Unknown action — ignore. No protocol change.
      }
    } catch (e) {
      Logger.warn('[VolumeSystem] handleClientAction error (non-fatal)', e.message);
      return false;
    }
  }

  return {
    init,
    getVolume,
    setVolume,
    refreshActiveVolume,
    tryHandleLocalCommand,
    parseVolumeCommand,      // exposed for debugging/testing (XiaozhiDebug)
    handleClientAction,      // future extension point — see HANDOFF.md
    DEFAULT_VOLUME,
  };
})();

// ================================================================
// MODULE: AssistantManager  (PHASE 1 — Multi-Assistant Foundation)
// ================================================================
// Olivia now models every paired "device" as an independent Assistant
// record. Each Assistant is a self-contained Olivia instance: its own
// name, device identity (Device-Id / Client-Id), pairing/token state,
// connection endpoints, protocol + audio preferences, and a reserved
// slot for conversation history (wired up in a later phase).
//
// AssistantManager persists the full list + the currently active
// assistant id under a NEW localStorage key so we never collide with
// (or destroy) the legacy single-assistant storage format. On first
// load, if the new key is empty but the legacy key has data, the
// existing single assistant/device/pairing is migrated automatically
// into Assistant #1 — no user loses their current pairing.
//
// IMPORTANT: This module intentionally knows NOTHING about the
// Xiaozhi WebSocket/OTA/MCP protocol. It is a pure data + persistence
// layer. SettingsManager (below) is rewritten as a thin compatibility
// shim on top of AssistantManager's "active assistant" so that every
// existing call site (ProtocolClient, AudioEngine, ChatEngine,
// ProvisioningManager, UIController, DeviceEmulator, ...) keeps
// working completely unchanged.
// ================================================================
const AssistantManager = (() => {
  const STORAGE_KEY = 'olivia_assistants_v1';
  const LEGACY_SETTINGS_KEY = 'xiaozhi_web_client_settings';

  /** Flat legacy-key → nested Assistant-record path, used by the
   *  SettingsManager compatibility shim so old call sites keep working. */
  const FLAT_KEY_MAP = {
    wsUrl:            ['connection', 'wsUrl'],
    otaUrl:           ['connection', 'otaUrl'],
    connectionStatus: ['connection', 'status'],
    token:            ['pairing', 'token'],
    paired:           ['pairing', 'paired'],
    deviceName:       ['device', 'deviceName'],
    deviceId:         ['device', 'deviceId'],
    clientId:         ['device', 'clientId'],
    protocolVersion:  ['protocol', 'protocolVersion'],
    frameDuration:    ['protocol', 'frameDuration'],
    listeningMode:    ['protocol', 'listeningMode'],
    audioEnabled:     ['audio', 'audioEnabled'],
    ttsPlayback:      ['audio', 'ttsPlayback'],
    assistantName:    null, // top-level 'name' — special-cased below
  };

  const ASSISTANT_DEFAULTS = () => ({
    connection: {
      wsUrl:  'wss://api.xiaozhi.me/xiaozhi/v1/',
      otaUrl: 'https://api.tenclass.net/xiaozhi/ota/',
      status: 'disconnected', // idle|connecting|connected|listening|speaking|disconnected|error
    },
    pairing: {
      token:  '',    // Populated by OTA provisioning, not user-entered
      paired: false,
    },
    device: {
      deviceName: 'My Virtual ESP32',
      deviceId:   '', // Auto-generated on first use
      clientId:   '', // Auto-generated UUID on first use
    },
    protocol: {
      protocolVersion: 1,
      frameDuration:   60, // ms
      listeningMode:   'auto',
    },
    audio: {
      audioEnabled: true,
      ttsPlayback:  true,
    },
    conversationHistory: [], // reserved for Phase 3 (per-assistant chat log)
  });

  /** In-memory state: the full list + which assistant is active */
  let assistants = [];
  let activeId = null;
  let listeners = [];

  // ── Generators (unchanged logic from the original SettingsManager) ──
  /** Generate a MAC-address-style device ID (12 hex chars with colons)
   * MUST be lowercase to match ESP32 firmware format (uses %02x in snprintf).
   * The Xiaozhi server authenticates Device-Id case-sensitively:
   * it sends a WS close frame immediately if the Device-Id is uppercase.
   */
  function generateMacAddress() {
    const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    const first = (Math.floor(Math.random() * 64) * 4 + 2).toString(16).padStart(2, '0');
    return [first, hex(), hex(), hex(), hex(), hex()].join(':');
  }

  function normalizeMacAddress(mac) {
    return typeof mac === 'string' ? mac.toLowerCase() : mac;
  }

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /** Build a brand-new Assistant record with auto-generated device identity */
  function buildNewAssistant(name) {
    const base = ASSISTANT_DEFAULTS();
    base.device.deviceId = generateMacAddress();
    base.device.clientId = generateUUID();
    return {
      id: generateUUID(),
      name: name || 'My Assistant',
      createdAt: new Date().toISOString(),
      ...base,
    };
  }

  /** One-time migration of the legacy single-assistant settings blob */
  function migrateLegacySettings() {
    let legacy = null;
    try {
      const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
      if (raw) legacy = JSON.parse(raw);
    } catch (e) {
      Logger.warn('Failed to parse legacy settings during migration', e.message);
    }

    if (!legacy) return null;

    Logger.boot('Migrating legacy single-assistant settings into Assistant #1', {
      deviceId: legacy.deviceId,
      wsUrl: legacy.wsUrl,
    });

    const base = ASSISTANT_DEFAULTS();
    const migrated = {
      id: generateUUID(),
      name: legacy.deviceName || 'My Assistant',
      createdAt: new Date().toISOString(),
      connection: {
        wsUrl:  legacy.wsUrl  || base.connection.wsUrl,
        otaUrl: legacy.otaUrl || base.connection.otaUrl,
        status: 'disconnected',
      },
      pairing: {
        token:  legacy.token  || '',
        paired: legacy.paired === true,
      },
      device: {
        deviceName: legacy.deviceName || base.device.deviceName,
        deviceId:   legacy.deviceId   || generateMacAddress(),
        clientId:   legacy.clientId   || generateUUID(),
      },
      protocol: {
        protocolVersion: legacy.protocolVersion || base.protocol.protocolVersion,
        frameDuration:    legacy.frameDuration    || base.protocol.frameDuration,
        listeningMode:    legacy.listeningMode    || base.protocol.listeningMode,
      },
      audio: {
        audioEnabled: legacy.audioEnabled !== false,
        ttsPlayback:  legacy.ttsPlayback  !== false,
      },
      conversationHistory: [],
    };

    return migrated;
  }

  function load() {
    let loaded = false;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.assistants) && parsed.assistants.length > 0) {
          assistants = parsed.assistants;
          activeId = parsed.activeId || assistants[0].id;
          loaded = true;
        }
      }
    } catch (e) {
      Logger.warn('Failed to load assistants from localStorage', e.message);
    }

    if (!loaded) {
      // No multi-assistant storage yet — try migrating the legacy single
      // assistant blob so no existing user loses their pairing.
      const migrated = migrateLegacySettings();
      if (migrated) {
        assistants = [migrated];
        activeId = migrated.id;
      } else {
        // Brand-new install — create a single default assistant.
        const fresh = buildNewAssistant('My Assistant');
        assistants = [fresh];
        activeId = fresh.id;
        Logger.boot('No existing settings found — created default assistant', {
          deviceId: fresh.device.deviceId,
        });
      }
      save();
    }

    // Normalize every assistant's Device-Id to lowercase (fixes older
    // uppercase MACs saved by pre-multi-assistant app versions). Any
    // assistant whose id had to be normalized is force-unpaired since
    // the Xiaozhi server never accepted the uppercase form.
    let anyNormalized = false;
    assistants.forEach(a => {
      const normalized = normalizeMacAddress(a.device.deviceId);
      if (normalized !== a.device.deviceId) {
        Logger.boot(`Normalizing Device-Id to lowercase for "${a.name}"`, normalized);
        a.device.deviceId = normalized;
        a.pairing.paired = false;
        a.pairing.token = '';
        anyNormalized = true;
      }
      if (!a.device.clientId) {
        a.device.clientId = generateUUID();
        anyNormalized = true;
      }
    });
    if (anyNormalized) save();

    if (!assistants.find(a => a.id === activeId)) {
      activeId = assistants[0].id;
    }

    Logger.boot(`Assistants loaded (${assistants.length})`, {
      activeId,
      names: assistants.map(a => a.name),
    });
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ assistants, activeId }));
    } catch (e) {
      Logger.warn('Failed to save assistants', e.message);
    }
  }

  function notify() {
    listeners.forEach(cb => {
      try { cb(); } catch (e) { Logger.warn('AssistantManager listener error', e.message); }
    });
  }

  /** Subscribe to any change in assistants/activeId (list edits, status, switch) */
  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  function getAllAssistants() {
    return assistants.map(a => JSON.parse(JSON.stringify(a)));
  }

  function getActiveAssistant() {
    return assistants.find(a => a.id === activeId) || null;
  }

  function getActiveId() { return activeId; }

  function getById(id) {
    return assistants.find(a => a.id === id) || null;
  }

  /** Switch the active assistant. UI-only — no reconnect/disconnect/pairing. */
  function setActive(id) {
    if (!assistants.find(a => a.id === id)) return false;
    activeId = id;
    save();
    notify();
    return true;
  }

  /**
   * Create and persist a brand-new assistant.
   * NOTE: exists for architectural completeness (Phase 2 will wire this to
   * a working "＋ Add Assistant" flow). Not called by the Phase 1 UI yet.
   */
  function createAssistant(name) {
    const created = buildNewAssistant(name);
    assistants.push(created);
    save();
    notify();
    return JSON.parse(JSON.stringify(created));
  }

  /**
   * PHASE 2: Never allow deleting the last remaining assistant — the app
   * always needs at least one. Callers (UI) should check the return value
   * and inform the user; this is the hard backstop.
   */
  function removeAssistant(id) {
    if (assistants.length <= 1) return false;
    const idx = assistants.findIndex(a => a.id === id);
    if (idx === -1) return false;
    assistants.splice(idx, 1);
    if (activeId === id) {
      activeId = assistants.length ? assistants[0].id : null;
    }
    save();
    notify();
    return true;
  }

  function renameAssistant(id, name) {
    const a = getById(id);
    if (!a || !name || !name.trim()) return false;
    a.name = name.trim();
    save();
    notify();
    return true;
  }

  // ── Generic by-id flat get/set helpers (PHASE 2) ────────────────────
  // These are the foundation for true per-assistant independence: every
  // module that used to read/write "the active assistant's settings" via
  // SettingsManager can now target ANY assistant by id, which is what lets
  // ProtocolClient/ProvisioningManager/ChatEngine run one fully independent
  // instance per assistant (see SessionManager below) instead of always
  // operating on whichever assistant happens to be visible in the UI.
  function getFlatField(id, flatKey) {
    const a = getById(id);
    if (!a) return undefined;
    if (flatKey === 'assistantName') return a.name;
    const path = FLAT_KEY_MAP[flatKey];
    if (!path) return undefined;
    return a[path[0]][path[1]];
  }

  function setFlatField(id, flatKey, value) {
    const a = getById(id);
    if (!a) return;
    if (flatKey === 'assistantName') {
      a.name = value;
      save();
      notify();
      return;
    }
    const path = FLAT_KEY_MAP[flatKey];
    if (!path) return;
    a[path[0]][path[1]] = value;
    save();
    notify();
  }

  /** Flat snapshot of any assistant by id, same shape as the old
   *  single-assistant SettingsManager.getAll() used to return. */
  function getFlatSnapshot(id) {
    const a = getById(id);
    if (!a) return {};
    const flat = { assistantName: a.name };
    Object.keys(FLAT_KEY_MAP).forEach(flatKey => {
      const path = FLAT_KEY_MAP[flatKey];
      if (path) flat[flatKey] = a[path[0]][path[1]];
    });
    return flat;
  }

  function resetById(id) {
    const a = getById(id);
    if (!a) return;
    const fresh = ASSISTANT_DEFAULTS();
    fresh.device.deviceId = generateMacAddress();
    fresh.device.clientId = generateUUID();
    a.connection = fresh.connection;
    a.pairing = fresh.pairing;
    a.device = fresh.device;
    a.protocol = fresh.protocol;
    a.audio = fresh.audio;
    save();
    notify();
  }

  function clearPairingById(id) {
    const a = getById(id);
    if (!a) return;
    a.pairing.token = '';
    a.pairing.paired = false;
    save();
    notify();
  }

  function isPairedById(id) {
    const a = getById(id);
    return !!a && a.pairing.paired === true && !!a.pairing.token;
  }

  function setConnectionStatus(id, status) {
    const a = getById(id);
    if (!a) return;
    a.connection.status = status;
    save();
    notify();
  }

  /**
   * PHASE 2: Append one finalized chat message onto an assistant's
   * persisted conversationHistory (capped at the last 200 entries so
   * localStorage doesn't grow unbounded). This is how each assistant's
   * chat survives a page refresh — ChatEngine's per-assistant instance
   * calls this after every user/AI message so switching assistants (or
   * reloading the page) always shows the correct, isolated history.
   */
  function appendConversationMessage(id, msg) {
    const a = getById(id);
    if (!a) return;
    if (!Array.isArray(a.conversationHistory)) a.conversationHistory = [];
    a.conversationHistory.push({
      id: msg.id,
      sender: msg.sender,
      text: msg.text,
      timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp,
      status: msg.status || 'sent',
      emotion: msg.emotion || null,
      imageThumb: msg.imageThumb || null,
      imageName: msg.imageName || null,
    });
    // Cap history so storage doesn't grow unbounded across long sessions.
    if (a.conversationHistory.length > 200) {
      a.conversationHistory = a.conversationHistory.slice(-200);
    }
    save();
    // NOTE: no notify() here — appending a message doesn't change anything
    // the sidebar/header render (name/status), and firing on every single
    // chat message would be wasteful. Message rendering itself is handled
    // directly by ChatEngine/UIController, not via the onChange subscription.
  }

  /** Clear an assistant's persisted conversation history (used by "Clear chat"). */
  function clearConversationHistory(id) {
    const a = getById(id);
    if (!a) return;
    a.conversationHistory = [];
    save();
  }

  // ── Active-assistant convenience wrappers (kept for the SettingsManager
  //    shim, which several not-yet-multi-instance call sites still use) ──
  function getActiveFlatField(flatKey)        { return getFlatField(activeId, flatKey); }
  function setActiveFlatField(flatKey, value) { return setFlatField(activeId, flatKey, value); }
  function getActiveFlatSnapshot()            { return getFlatSnapshot(activeId); }
  function resetActive()                      { return resetById(activeId); }
  function clearActivePairing()               { return clearPairingById(activeId); }
  function isActivePaired()                   { return isPairedById(activeId); }
  function setActiveConnectionStatus(status)  { return setConnectionStatus(activeId, status); }

  return {
    load,
    save,
    onChange,
    getAllAssistants,
    getActiveAssistant,
    getActiveId,
    getById,
    setActive,
    createAssistant,
    removeAssistant,
    renameAssistant,
    getActiveFlatField,
    setActiveFlatField,
    getActiveFlatSnapshot,
    resetActive,
    clearActivePairing,
    isActivePaired,
    setActiveConnectionStatus,
    // PHASE 2 — generic by-id accessors (multi-session foundation)
    getFlatField,
    setFlatField,
    getFlatSnapshot,
    resetById,
    clearPairingById,
    isPairedById,
    setConnectionStatus,
    appendConversationMessage,
    clearConversationHistory,
    generateMacAddress,
    generateUUID,
  };
})();

// ================================================================
// MODULE: Settings Manager
// ----------------------------------------------------------------
// PHASE 1 NOTE: This module is now a thin compatibility shim over
// AssistantManager's "active assistant". Every method keeps its
// original signature and behaviour so ProtocolClient, AudioEngine,
// ChatEngine, ProvisioningManager, DeviceEmulator, and UIController
// continue to work completely unchanged — they simply always read
// and write the currently *active* assistant's settings.
// ================================================================
const SettingsManager = (() => {
  function load() {
    AssistantManager.load();
  }

  function save() {
    AssistantManager.save();
  }

  function get(key) {
    return AssistantManager.getActiveFlatField(key);
  }

  function set(key, value) {
    AssistantManager.setActiveFlatField(key, value);
  }

  function getAll() {
    return AssistantManager.getActiveFlatSnapshot();
  }

  function reset() {
    AssistantManager.resetActive();
  }

  function clearPairing() {
    AssistantManager.clearActivePairing();
  }

  function isPaired() {
    return AssistantManager.isActivePaired();
  }

  function generateMacAddress() {
    return AssistantManager.generateMacAddress();
  }

  function generateUUID() {
    return AssistantManager.generateUUID();
  }

  return { load, save, get, set, getAll, reset, clearPairing, isPaired, generateMacAddress, generateUUID };
})();

// ================================================================
// MODULE: DeviceEmulator
// Manages virtual device state machine, mirroring ESP32 behavior
// ----------------------------------------------------------------
// PHASE 2 CHANGE: This module used to be a single global singleton
// (one state machine for "the" device). Since every assistant is now
// its own independent virtual ESP32, DeviceEmulator is rewritten as a
// factory: DeviceEmulator.create(assistantId) returns a brand-new,
// fully independent state machine instance. The STATES enum stays a
// shared static (it's just constant strings, not state) so existing
// code that does `DeviceEmulator.STATES.IDLE` keeps working unchanged.
// ================================================================
const DeviceEmulator = (() => {
  const STATES = {
    UNKNOWN:     'unknown',
    STARTING:    'starting',
    IDLE:        'idle',
    CONNECTING:  'connecting',
    LISTENING:   'listening',
    SPEAKING:    'speaking',
    ERROR:       'error',
  };

  function create(assistantId) {
    let currentState = STATES.UNKNOWN;
    const listeners = [];

    function setState(newState, reason = '') {
      if (newState === currentState) return;
      const prev = currentState;
      currentState = newState;
      Logger.state(`[${assistantId.slice(0, 8)}] ${prev.toUpperCase()} → ${newState.toUpperCase()}${reason ? ' (' + reason + ')' : ''}`);
      listeners.forEach(fn => fn(newState, prev, reason));
    }

    function getState() { return currentState; }

    function onStateChange(fn) { listeners.push(fn); }

    function getIdentityInfo() {
      const s = AssistantManager.getFlatSnapshot(assistantId);
      return {
        'Device-Id':    s.deviceId,
        'Client-Id':    s.clientId,
        'Device Name':  s.deviceName,
        'Pairing':      AssistantManager.isPairedById(assistantId) ? 'Paired' : 'Not paired',
        'WS URL':       s.wsUrl,
        'OTA URL':      s.otaUrl,
        'Protocol Ver': s.protocolVersion,
        'Frame Duration (ms)': s.frameDuration,
      };
    }

    return { STATES, setState, getState, onStateChange, getIdentityInfo };
  }

  return { STATES, create };
})();

// ================================================================
// MODULE: ProvisioningManager
// ESP32-style OTA registration + 6-digit activation flow
// Source: xiaozhi-esp32/main/ota.cc + application.cc
// ----------------------------------------------------------------
// PHASE 2 CHANGE: Rewritten as a factory — ProvisioningManager.create(id)
// returns an independent provisioning/pairing flow bound to ONE assistant
// (by id), reading/writing that assistant's fields directly via
// AssistantManager's by-id accessors rather than always "whichever
// assistant is active". This is what allows one assistant to be paired
// while another is mid-pairing or unpaired, all at the same time, and
// lets us provision a brand-new assistant without first switching the
// visible/active assistant.
//
// `UIController.updatePairingStatus` (pairing modal) only reflects the
// flow for the assistant currently visible in the UI — SessionManager
// (below) guards this by only forwarding modal updates when the
// provisioning target IS the active assistant.
// ================================================================
const ProvisioningManager = (() => {
  const PAIRING_STATES = {
    UNPAIRED:        'unpaired',
    PAIRING_PENDING: 'pairing_pending',
    PAIRED:          'paired',
    FAILED:          'failed',
    EXPIRED:         'expired',
  };

  function create(assistantId) {
    let pairingState = PAIRING_STATES.UNPAIRED;
    let activationCode = '';
    let activationMessage = '';
    let activationChallenge = '';
    let activationTimeoutMs = 300000;
    let pollTimerId = null;
    let pollAbort = false;
    let pollAttempts = 0;
    const MAX_POLL_ATTEMPTS = 100; // ~5 min at 3s intervals
    const stateListeners = [];

    function getState() { return pairingState; }

    function onStateChange(fn) { stateListeners.push(fn); }

    function setState(state) {
      pairingState = state;
      Logger.auth(`[${assistantId.slice(0, 8)}] Pairing state → ${state}`);
      stateListeners.forEach(fn => {
        try { fn(state, activationCode); } catch (e) { /* ignore */ }
      });
    }

    // Local helpers bound to THIS assistant only (never "the active one")
    const get = (key) => AssistantManager.getFlatField(assistantId, key);
    const set = (key, value) => AssistantManager.setFlatField(assistantId, key, value);
    const getAll = () => AssistantManager.getFlatSnapshot(assistantId);

    /** Build the device info JSON body (mirrors ESP32 CheckVersion POST) */
    function buildDeviceInfoPayload() {
      const s = getAll();
      return {
        version: 2,
        language: navigator.language || 'en-US',
        flash_size: 0,
        minimum_free_heap_size: 0,
        mac_address: s.deviceId,
        uuid: s.clientId,
        chip_model_name: 'web-client',
        application: {
          name: 'xiaozhi-web-client',
          version: '1.0.0',
          compile_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
          idf_version: '5.0',
          elf_sha256: '',
        },
        board: {
          type: 'web-client',
          name: s.deviceName || 'Virtual ESP32',
          ip: '127.0.0.1',
          mac: s.deviceId,
        },
      };
    }

    /** Apply websocket config returned by OTA check */
    function applyServerConfig(data) {
      if (data.websocket) {
        if (data.websocket.url) {
          set('wsUrl', data.websocket.url);
          Logger.auth('WebSocket URL from OTA', data.websocket.url);
        }
        if (data.websocket.token) {
          set('token', data.websocket.token);
          Logger.auth('Access token received from OTA');
        }
        if (data.websocket.version) {
          set('protocolVersion', data.websocket.version);
        }
      }
    }

    /** POST /api/ota/check — proxied version of ESP32 Ota::CheckVersion() */
    async function checkVersion() {
      const s = getAll();
      Logger.auth('OTA check starting', { otaUrl: s.otaUrl, deviceId: s.deviceId });

      const res = await fetch('/api/ota/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otaUrl: s.otaUrl,
          deviceId: s.deviceId,
          clientId: s.clientId,
          payload: buildDeviceInfoPayload(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `OTA check failed (${res.status})`);
      }

      Logger.auth('OTA check response', data);
      applyServerConfig(data);

      activationCode = '';
      activationMessage = '';
      activationChallenge = '';

      if (data.activation && typeof data.activation === 'object') {
        if (data.activation.code) activationCode = String(data.activation.code);
        if (data.activation.message) activationMessage = String(data.activation.message);
        if (data.activation.challenge) activationChallenge = String(data.activation.challenge);
        if (data.activation.timeout_ms) activationTimeoutMs = Number(data.activation.timeout_ms);
      }

      return data;
    }

    /** POST /api/ota/activate — proxied version of ESP32 Ota::Activate() */
    async function activateOnce() {
      const s = getAll();
      const res = await fetch('/api/ota/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otaUrl: s.otaUrl,
          deviceId: s.deviceId,
          clientId: s.clientId,
          payload: {},  // Activation-Version 1 (no serial/HMAC)
        }),
      });

      return { status: res.status, data: await res.json().catch(() => ({})) };
    }

    function stopPolling() {
      pollAbort = true;
      if (pollTimerId) {
        clearTimeout(pollTimerId);
        pollTimerId = null;
      }
    }

    /** Poll activate endpoint until paired (HTTP 200) or timeout (HTTP 202) */
    function waitForActivation() {
      return new Promise((resolve, reject) => {
        pollAbort = false;
        pollAttempts = 0;

        async function poll() {
          if (pollAbort) {
            reject(new Error('Pairing cancelled'));
            return;
          }

          pollAttempts++;
          if (pollAttempts > MAX_POLL_ATTEMPTS) {
            setState(PAIRING_STATES.EXPIRED);
            reject(new Error('Activation timed out'));
            return;
          }

          try {
            const { status, data } = await activateOnce();

            if (status === 200) {
              // Activation confirmed by server (HTTP 200).
              // DO NOT set paired=true yet — call checkVersion() one more time
              // (mirrors real ESP32 firmware CheckNewVersion() loop: after Activate()
              // returns ESP_OK, it loops back to call CheckVersion() again to get
              // the final token and confirm the device is registered).
              Logger.auth('Activation HTTP 200 — calling CheckVersion to confirm registration');
              setState(PAIRING_STATES.PAIRING_PENDING);

              try {
                await checkVersion();
                // If OTA now returns NO activation code, device is registered.
                // If it still has activation code, server hasn't processed yet — retry.
                if (!activationCode && !activationChallenge) {
                  Logger.auth('Post-activation OTA confirms device is registered');
                  set('paired', true);
                  setState(PAIRING_STATES.PAIRED);
                  resolve(true);
                } else {
                  // Server hasn't processed yet — wait and retry activation poll
                  Logger.auth('Post-activation OTA still shows activation code — server processing delay, retrying...');
                  pollTimerId = setTimeout(poll, 3000);
                }
              } catch (otaErr) {
                // OTA check failed after activation — still mark as paired since
                // activate returned 200. Use token we already have.
                Logger.warn('Post-activation OTA check failed, proceeding with cached token', otaErr.message);
                set('paired', true);
                setState(PAIRING_STATES.PAIRED);
                resolve(true);
              }
              return;
            }

            if (status === 202) {
              setState(PAIRING_STATES.PAIRING_PENDING);
              pollTimerId = setTimeout(poll, 3000);
              return;
            }

            setState(PAIRING_STATES.FAILED);
            reject(new Error(`Activation failed (HTTP ${status})`));
          } catch (err) {
            setState(PAIRING_STATES.FAILED);
            reject(err);
          }
        }

        poll();
      });
    }

    /**
     * Full provisioning flow — called before first WebSocket connect.
     * Mirrors the real ESP32 firmware CheckNewVersion() outer loop.
     * Returns { needsUserAction: bool, code?: string }
     *
     * @param {boolean} [silent=false] - if true, don't reset pairing state UI
     *        (used when re-checking OTA for an already-paired device)
     */
    async function provision(silent = false) {
      stopPolling();
      if (!silent) {
        setState(PAIRING_STATES.UNPAIRED);
      }

      const data = await checkVersion();

      // Server returned NO activation requirement — device is already registered.
      // (Real firmware: HasActivationCode() == false → break the while loop)
      if (!activationCode && !activationChallenge) {
        if (get('token')) {
          set('paired', true);
          setState(PAIRING_STATES.PAIRED);
          Logger.auth('Device already registered (no activation code in OTA response)');
          return { needsUserAction: false };
        }
        // Has no activation and no token — shouldn't happen but handle gracefully
        Logger.warn('OTA response has no activation block and no token — proceeding anyway');
        set('paired', true);
        setState(PAIRING_STATES.PAIRED);
        return { needsUserAction: false };
      }

      // Server requires activation — show the code to the user.
      // (Real firmware: HasActivationCode() == true → ShowActivationCode())
      if (activationCode) {
        setState(PAIRING_STATES.PAIRING_PENDING);
        Logger.auth(`Activation required. Code: ${activationCode}. Challenge: ${activationChallenge}`);
        return {
          needsUserAction: true,
          code: activationCode,
          message: activationMessage || 'Go to xiaozhi.me and enter this code.',
          timeoutMs: activationTimeoutMs,
        };
      }

      // Has challenge but no code (unusual) — treat as activation needed but no display code
      if (activationChallenge) {
        setState(PAIRING_STATES.PAIRING_PENDING);
        Logger.warn('OTA has activation challenge but no display code — proceeding as paired');
        set('paired', true);
        setState(PAIRING_STATES.PAIRED);
        return { needsUserAction: false };
      }

      // Fallback: should not reach here
      set('paired', true);
      setState(PAIRING_STATES.PAIRED);
      return { needsUserAction: false };
    }

    function cancel() {
      stopPolling();
      setState(PAIRING_STATES.UNPAIRED);
    }

    return {
      PAIRING_STATES,
      getState,
      onStateChange,
      provision,
      waitForActivation,
      cancel,
      stopPolling,
      getActivationCode: () => activationCode,
    };
  }

  return { PAIRING_STATES, create };
})();

// ================================================================
// MODULE: AudioEngine
// Handles microphone capture, REAL Opus encoding via libopus-wasm,
// and TTS playback with Opus decoding.
//
// CRITICAL: The Xiaozhi server requires genuine Opus-encoded frames.
// Sending raw PCM16 data triggers "Error occurred while processing message".
// This module uses libopus-wasm to encode 16kHz mono 60ms frames (960 samples).
// ================================================================
const AudioEngine = (() => {
  let audioContext = null;
  let captureContext = null;   // Separate 16kHz context for capture
  let micStream = null;
  let micSourceNode = null;
  let scriptProcessorNode = null;
  let analyzerNode = null;
  let isCapturing = false;
  let onAudioChunkCallback = null;
  let ttsQueue = [];
  let isTTSPlaying = false;

  // ── PER-ASSISTANT SPEECH VOLUME  [OLIVIA FEATURE] ──────────────────
  // A single GainNode sits between every decoded TTS source and the
  // AudioContext's speaker output. ALL TTS playback (both the libopus
  // decode path and the Web Audio decodeAudioData fallback path) routes
  // through this one node instead of connecting straight to
  // `audioContext.destination`, so changing its gain takes effect
  // instantly on whatever is currently queued/playing — no need to
  // re-decode or restart anything.
  //
  // This node ONLY affects local Olivia playback. It never touches the
  // Xiaozhi WebSocket protocol, the mic-capture pipeline, or anything
  // sent to the server — see VolumeSystem below for the higher-level
  // per-assistant persistence + UI wrapper around this raw gain control.
  let ttsGainNode = null;
  let currentVolume = 1.0;   // 0.0 (silent) .. 1.0 (100%), applied to ttsGainNode.gain

  /** Lazily create the shared gain node once the AudioContext exists,
   *  wired GainNode -> destination. Safe to call repeatedly. */
  function ensureGainNode() {
    if (!audioContext) return null;
    if (!ttsGainNode || ttsGainNode.context !== audioContext) {
      ttsGainNode = audioContext.createGain();
      ttsGainNode.gain.value = currentVolume;
      ttsGainNode.connect(audioContext.destination);
    }
    return ttsGainNode;
  }

  /** Set local TTS playback volume immediately (0.0 - 1.0). Does not
   *  persist anything itself — VolumeSystem owns persistence. */
  function setVolume(vol) {
    currentVolume = Math.max(0, Math.min(1, Number(vol)));
    if (ttsGainNode) {
      // Use setTargetAtTime for a tiny declick ramp instead of an
      // instant step, but effectively "immediate" (25ms time constant).
      try {
        ttsGainNode.gain.setTargetAtTime(currentVolume, audioContext.currentTime, 0.01);
      } catch (e) {
        ttsGainNode.gain.value = currentVolume;
      }
    }
    return currentVolume;
  }

  function getVolume() {
    return currentVolume;
  }

  // Opus encoder/decoder instances (loaded lazily from libopus-wasm)
  let opusEncoder = null;
  let opusDecoder = null;
  let opusLib = null;           // The imported module
  let opusLoading = false;
  let opusLoadCallbacks = [];

  // PCM sample accumulator for chunking into exact 960-sample Opus frames
  let pcmAccumulator = new Float32Array(0);
  // Guard to prevent concurrent flushAccumulator() calls racing on pcmAccumulator
  let flushInProgress = false;
  // Scheduled playback clock for gapless TTS playback
  let ttsNextStartTime = 0;

  // --- Constants ---
  const INPUT_SAMPLE_RATE  = 16000;  // Xiaozhi server expects 16kHz
  const TTS_SAMPLE_RATE    = 24000;  // Server sends 24kHz TTS
  const CHANNELS           = 1;     // Mono
  // 60ms frame at 16kHz = 960 samples (matches OPUS_FRAME_DURATION_MS in firmware)
  const OPUS_FRAME_SAMPLES  = 960;
  const OPUS_FRAME_DURATION = 60;   // ms
  // libopus-wasm CDN URL (ES module, inlines WASM — no second request needed)
  const OPUS_WASM_CDN = 'https://cdn.jsdelivr.net/npm/libopus-wasm@0.2.0/dist/index.js';

  /**
   * Load libopus-wasm once, reuse across captures/playbacks.
   * Returns a promise that resolves when the module is ready.
   */
  function loadOpus() {
    if (opusLib) return Promise.resolve(opusLib);

    return new Promise((resolve, reject) => {
      // If already loading, queue this callback
      if (opusLoading) {
        opusLoadCallbacks.push({ resolve, reject });
        return;
      }

      opusLoading = true;
      opusLoadCallbacks.push({ resolve, reject });

      Logger.audio('Loading libopus-wasm from CDN...');

      import(OPUS_WASM_CDN).then(mod => {
        opusLib = mod;
        Logger.audio('libopus-wasm loaded successfully');
        opusLoading = false;
        opusLoadCallbacks.forEach(cb => cb.resolve(mod));
        opusLoadCallbacks = [];
      }).catch(err => {
        Logger.error('Failed to load libopus-wasm', err.message);
        opusLoading = false;
        opusLoadCallbacks.forEach(cb => cb.reject(err));
        opusLoadCallbacks = [];
      });
    });
  }

  /**
   * Get or create an Opus encoder.
   * Encoder: 16kHz, mono, 60ms frames (960 samples), VoIP application type.
   */
  async function getEncoder() {
    if (opusEncoder) return opusEncoder;
    const lib = await loadOpus();
    // Application.Voip = optimized for speech, matches ESP32 firmware default
    const Application = lib.Application || {};
    opusEncoder = await lib.createEncoder({
      sampleRate: INPUT_SAMPLE_RATE,
      channels:   CHANNELS,
      application: Application.Voip || Application.Audio || 2049,
      frameSize:  OPUS_FRAME_SAMPLES,
      bitrate:    24000,  // 24kbps — good for 16kHz mono voice
    });
    Logger.audio(`Opus encoder created: ${INPUT_SAMPLE_RATE}Hz mono ${OPUS_FRAME_DURATION}ms frames`);
    return opusEncoder;
  }

  /**
   * Get or create an Opus decoder.
   * Decoder: 24kHz for TTS playback (server sends 24kHz).
   */
  async function getDecoder(sampleRate = TTS_SAMPLE_RATE) {
    if (opusDecoder) return opusDecoder;
    const lib = await loadOpus();
    opusDecoder = await lib.createDecoder({
      sampleRate: sampleRate,
      channels:   CHANNELS,
    });
    Logger.audio(`Opus decoder created: ${sampleRate}Hz mono`);
    return opusDecoder;
  }

  /** Initialize AudioContext on first user interaction (for TTS playback) */
  async function ensureAudioContext() {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: TTS_SAMPLE_RATE,
        latencyHint: 'interactive',
      });
      ttsGainNode = null; // force re-creation against the fresh context
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    ensureGainNode();
    return audioContext;
  }

  /**
   * Initialize a separate 16kHz AudioContext for microphone capture.
   * IMPORTANT: The capture context MUST match the encoder sample rate (16kHz).
   * Web Audio will resample the mic to match the context sampleRate.
   */
  async function ensureCaptureContext() {
    if (!captureContext || captureContext.state === 'closed') {
      captureContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: INPUT_SAMPLE_RATE,   // 16kHz — matches Opus encoder
        latencyHint: 'interactive',
      });
    }
    if (captureContext.state === 'suspended') {
      await captureContext.resume();
    }
    return captureContext;
  }

  /**
   * Encode a Float32 PCM frame (exactly 960 samples) to Opus.
   * Returns Uint8Array with the raw Opus packet, or null on error.
   */
  async function encodeFloat32Frame(float32Frame) {
    try {
      const encoder = await getEncoder();
      const packet = encoder.encodeFloat(float32Frame);
      return packet;  // Uint8Array
    } catch (err) {
      Logger.error('Opus encode error', err.message);
      return null;
    }
  }

  /**
   * Process accumulated PCM samples — chunk into exact OPUS_FRAME_SAMPLES (960)
   * frames, encode each, and call onAudioChunkCallback.
   *
   * BUG 3 FIX: Use flushInProgress guard to prevent concurrent calls from the
   * ScriptProcessor onaudioprocess handler racing on the shared pcmAccumulator.
   * Without this, two concurrent flushes both read/write pcmAccumulator simultaneously
   * causing data loss, dropped frames, or corrupt Opus packets — meaning no audio
   * ever reaches the server.
   */
  async function flushAccumulator() {
    // If a flush is already running, do nothing — it will drain the accumulator
    if (flushInProgress) return;
    flushInProgress = true;
    try {
      while (pcmAccumulator.length >= OPUS_FRAME_SAMPLES) {
        // Snapshot the frame before awaiting (pcmAccumulator may be mutated by onaudioprocess)
        const frame = new Float32Array(pcmAccumulator.subarray(0, OPUS_FRAME_SAMPLES));
        // Consume before awaiting to prevent double-consumption
        pcmAccumulator = pcmAccumulator.slice(OPUS_FRAME_SAMPLES);

        const opusPacket = await encodeFloat32Frame(frame);
        if (opusPacket && opusPacket.byteLength > 0) {
          Logger.audio(`→ Opus frame ${opusPacket.byteLength}b (${OPUS_FRAME_SAMPLES} samples → ${OPUS_FRAME_DURATION}ms)`);
          if (onAudioChunkCallback) {
            // Produce a clean, detached ArrayBuffer copy for the callback
            const buf = opusPacket.buffer.slice(
              opusPacket.byteOffset,
              opusPacket.byteOffset + opusPacket.byteLength
            );
            onAudioChunkCallback(buf);
          }
        }
      }
    } finally {
      flushInProgress = false;
    }
  }

  /**
   * Request microphone permission and start capture with REAL Opus encoding.
   * The server expects: binary Opus frames @ 16kHz, mono, 60ms (960 samples/frame).
   */
  async function startCapture(onChunk) {
    if (isCapturing) {
      Logger.audio('Already capturing');
      return true;
    }

    onAudioChunkCallback = onChunk;
    pcmAccumulator = new Float32Array(0);

    try {
      // Pre-load Opus encoder before capture starts (avoids first-frame delay)
      Logger.audio('Pre-loading Opus encoder...');
      await getEncoder();

      await ensureCaptureContext();

      // Request microphone with 16kHz constraint
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount:    CHANNELS,
          sampleRate:      INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        }
      });

      Logger.audio('Microphone acquired');

      micSourceNode = captureContext.createMediaStreamSource(micStream);

      // Analyzer for level meter (connected to captureContext)
      analyzerNode = captureContext.createAnalyser();
      analyzerNode.fftSize = 256;
      micSourceNode.connect(analyzerNode);

      // ScriptProcessor: 4096-sample buffer gives us ~256ms chunks at 16kHz.
      // We accumulate and slice into exact 960-sample Opus frames.
      const bufferSize = 4096;
      scriptProcessorNode = captureContext.createScriptProcessor(bufferSize, 1, 1);
      scriptProcessorNode.onaudioprocess = (e) => {
        if (!isCapturing) return;

        const incoming = e.inputBuffer.getChannelData(0);  // Float32, already at 16kHz

        // Append to accumulator
        const merged = new Float32Array(pcmAccumulator.length + incoming.length);
        merged.set(pcmAccumulator, 0);
        merged.set(incoming, pcmAccumulator.length);
        pcmAccumulator = merged;

        // Flush complete 960-sample frames (async but fire-and-forget is fine here)
        flushAccumulator().catch(err => {
          Logger.error('Audio flush error', err.message);
        });
      };

      micSourceNode.connect(scriptProcessorNode);
      // Connect to destination to keep ScriptProcessor alive (browser quirk)
      scriptProcessorNode.connect(captureContext.destination);

      isCapturing = true;

      // Start level meter animation
      startLevelMeter();

      Logger.audio(`Microphone capture started — Opus encoder ready (${INPUT_SAMPLE_RATE}Hz mono ${OPUS_FRAME_DURATION}ms frames)`);
      return true;

    } catch (err) {
      Logger.error('Failed to start microphone capture', err.message);
      stopCapture();
      return false;
    }
  }

  /** Stop microphone capture */
  function stopCapture() {
    isCapturing = false;
    pcmAccumulator = new Float32Array(0);
    stopLevelMeter();

    if (scriptProcessorNode) {
      scriptProcessorNode.disconnect();
      scriptProcessorNode = null;
    }
    if (micSourceNode) {
      micSourceNode.disconnect();
      micSourceNode = null;
    }
    if (analyzerNode) {
      analyzerNode.disconnect();
      analyzerNode = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }

    // Don't close captureContext — reuse it for next capture
    Logger.audio('Microphone capture stopped');
  }

  /** Level meter animation */
  let levelAnimFrame = null;
  const meterEl = document.getElementById('audioMeterFill');

  function startLevelMeter() {
    if (!analyzerNode || !meterEl) return;
    const dataArray = new Uint8Array(analyzerNode.frequencyBinCount);

    function animate() {
      if (!isCapturing) return;
      analyzerNode.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const pct = Math.min(100, (avg / 255) * 100 * 3);
      meterEl.style.width = pct + '%';
      levelAnimFrame = requestAnimationFrame(animate);
    }
    animate();
  }

  function stopLevelMeter() {
    if (levelAnimFrame) {
      cancelAnimationFrame(levelAnimFrame);
      levelAnimFrame = null;
    }
    if (meterEl) meterEl.style.width = '0%';
  }

  /**
   * Play raw Opus binary data received from server TTS.
   * Uses libopus-wasm decoder to convert Opus → Float32 PCM → Web Audio.
   * Server sends 24kHz mono Opus frames.
   *
   * BUG 4 FIX: Use Web Audio clock scheduling (source.start(ttsNextStartTime))
   * instead of onended callbacks. The onended-chain approach introduces gaps
   * between chunks: each chunk waits for the previous source node's 'ended'
   * event to fire before scheduling the next one. Since 'ended' fires *after*
   * the buffer finishes playing (not when it's about to end), this creates an
   * audible gap / stutter between every Opus frame — producing crackling,
   * slow, and stretched-sounding audio.
   *
   * The fix pre-schedules all decoded frames on the AudioContext timeline, so
   * they play back-to-back with zero gap, exactly as the server intended.
   */
  async function enqueueTTSChunk(opusData) {
    ttsQueue.push(opusData);
    if (!isTTSPlaying) {
      isTTSPlaying = true;
      // Drain the queue asynchronously without blocking the caller
      drainTTSQueue().catch(err => Logger.error('TTS drain error', err.message));
    }
  }

  async function drainTTSQueue() {
    await ensureAudioContext();

    // Lazily initialize the decoder once (reuse across all TTS chunks)
    let decoder = null;
    try {
      decoder = await getDecoder(TTS_SAMPLE_RATE);
    } catch (e) {
      Logger.warn('Opus decoder unavailable, TTS will use Web Audio fallback', e.message);
    }

    // Align scheduling clock to slightly ahead of "now" to avoid underruns
    const BUFFER_AHEAD_S = 0.1;  // 100ms lookahead
    if (ttsNextStartTime < audioContext.currentTime) {
      ttsNextStartTime = audioContext.currentTime + BUFFER_AHEAD_S;
    }

    while (ttsQueue.length > 0) {
      const chunk = ttsQueue.shift();
      let pcmFloat = null;

      // ── Path 1: Opus decode via libopus-wasm ──────────────────────────
      if (decoder) {
        try {
          const packet = new Uint8Array(
            chunk instanceof ArrayBuffer ? chunk : (chunk.buffer || chunk)
          );
          const decoded = decoder.decodeFloat(packet);  // Float32Array in [-1, 1]
          if (decoded && decoded.length > 0) {
            pcmFloat = decoded;
          }
        } catch (opusErr) {
          Logger.audio(`Opus decode failed: ${opusErr.message}, trying Web Audio fallback`);
          decoder = null;  // don't retry libopus on subsequent frames
        }
      }

      // ── Path 2: Web Audio decodeAudioData fallback (OGG/Opus container) ─
      if (!pcmFloat) {
        try {
          const buf = chunk instanceof ArrayBuffer ? chunk : chunk.buffer;
          const audioBuffer = await audioContext.decodeAudioData(buf.slice(0));
          // Schedule this frame back-to-back with the previous one
          const source = audioContext.createBufferSource();
          source.buffer = audioBuffer;
          // OLIVIA FEATURE: route through the per-assistant volume gain
          // node instead of straight to destination, so the slider/NL
          // volume commands affect this fallback path too.
          source.connect(ensureGainNode() || audioContext.destination);
          source.start(ttsNextStartTime);
          ttsNextStartTime += audioBuffer.duration;
          Logger.audio(`TTS (Web Audio fallback): ${audioBuffer.duration.toFixed(3)}s @ t=${ttsNextStartTime.toFixed(3)}`);
          continue;  // next chunk
        } catch (e) {
          Logger.audio(`TTS frame undecodable (${chunk.byteLength || 0}b), skipping`);
          continue;
        }
      }

      // ── Schedule PCM via AudioContext clock ───────────────────────────
      const frameDurationS = pcmFloat.length / TTS_SAMPLE_RATE;
      const audioBuffer = audioContext.createBuffer(CHANNELS, pcmFloat.length, TTS_SAMPLE_RATE);
      audioBuffer.copyToChannel(pcmFloat, 0);
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      // OLIVIA FEATURE: route through the shared per-assistant volume
      // gain node (see ensureGainNode / setVolume above) instead of
      // connecting straight to destination.
      source.connect(ensureGainNode() || audioContext.destination);
      source.start(ttsNextStartTime);
      ttsNextStartTime += frameDurationS;
      Logger.audio(`TTS chunk: ${pcmFloat.length} samples (${(frameDurationS * 1000).toFixed(0)}ms) @ t=${ttsNextStartTime.toFixed(3)}`);
    }

    isTTSPlaying = false;
  }

  async function processTTSQueue() {
    // Kept for backward compat — delegates to drainTTSQueue
    if (!isTTSPlaying) {
      isTTSPlaying = true;
      drainTTSQueue().catch(err => Logger.error('TTS drain error', err.message));
    }
  }

  function clearTTSQueue() {
    ttsQueue = [];
    isTTSPlaying = false;
    // Reset the scheduling clock so the next TTS starts immediately
    ttsNextStartTime = 0;
  }

  function checkMicPermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.resolve({ state: 'unavailable' });
    }
    if (navigator.permissions && navigator.permissions.query) {
      return navigator.permissions.query({ name: 'microphone' });
    }
    return Promise.resolve({ state: 'unknown' });
  }

  return {
    startCapture,
    stopCapture,
    enqueueTTSChunk,
    clearTTSQueue,
    isCapturing: () => isCapturing,
    checkMicPermission,
    ensureAudioContext,
    loadOpus,           // expose so AppController can pre-warm
    INPUT_SAMPLE_RATE,
    TTS_SAMPLE_RATE,
    // OLIVIA FEATURE: per-assistant local speech volume control.
    // setVolume() takes effect immediately on the shared TTS gain node —
    // it does NOT touch the Xiaozhi protocol, mic capture, or anything
    // sent to the server. VolumeSystem (below) is the higher-level
    // wrapper that persists this value per-assistant and calls setVolume()
    // whenever the active assistant changes or the user adjusts it.
    setVolume,
    getVolume,
  };
})();

// ================================================================
// MODULE: VisionCapability
// Stores the Xiaozhi Vision URL and token received during MCP initialize.
// The server advertises: capabilities.vision.url and capabilities.vision.token
// in the MCP initialize message. This mirrors ParseCapabilities() in
// mcp_server.cc from the official xiaozhi-esp32 firmware.
//
// IMPORTANT: The server sends the vision URL as http:// (not https://).
// Example: http://api.xiaozhi.me/vision/explain
// The Hono proxy normalises this to https:// before forwarding.
//
// PHASE 2 CHANGE: Rewritten as a factory (one vision capability holder
// per assistant/session) since each assistant has its own MCP session
// with the server and may or may not have vision enabled independently.
// ================================================================
const VisionCapability = (() => {
  function create(assistantId) {
    let visionUrl   = '';
    let visionToken = '';

    function setUrl(url, token) {
      visionUrl   = url;
      visionToken = token || '';
      // ── VERBOSE VISION LOGGING ──
      Logger.mcp('=== VISION CAPABILITY RECEIVED ===');
      Logger.mcp(`[${assistantId.slice(0, 8)}] Vision URL: ${url}`);
      Logger.mcp(`Vision token present: ${!!token}`);
      Logger.mcp(`Vision token value: ${token ? ('...' + String(token).slice(-8)) : '(none)'}`);
      Logger.mcp('==================================');
    }

    function getUrl()   { return visionUrl; }
    function getToken() { return visionToken; }
    function isAvailable() { return !!visionUrl; }

    return { setUrl, getUrl, getToken, isAvailable };
  }

  return { create };
})();

// ================================================================
// MODULE: ProtocolClient
// Core ESP32 WebSocket protocol implementation
// This is the heart of the device emulator.
// ----------------------------------------------------------------
// PHASE 2 CHANGE: Rewritten as a factory — ProtocolClient.create(id, deps)
// returns an INDEPENDENT WebSocket connection + protocol state machine
// bound to ONE assistant. This is the central piece that makes "every
// assistant is its own virtual ESP32" real: two assistants can now hold
// two live `ws` connections simultaneously, each with its own sessionId,
// hello handshake, reconnect counter, etc. Switching the active assistant
// in the UI never touches any of these — see SessionManager below, which
// owns one { deviceEmulator, provisioning, vision, protocol, chat } bundle
// per assistant and never tears one down just because the UI stopped
// showing it.
//
// `deps.deviceEmulator` / `deps.vision` are THIS assistant's own
// DeviceEmulator / VisionCapability instances. `deps.chat` is wired in
// after creation via setChatEngine() (see SessionManager) to break the
// circular dependency: ChatEngine needs a ProtocolClient instance to send
// messages, and ProtocolClient needs a ChatEngine instance to render the
// vision (take_photo) tool-call result into the chat bubble.
//
// Fixes an inherited bug: the take_photo MCP handler used to call bare
// `beginAIResponse(null)` / `appendAIResponseSentence(...)` /
// `finalizeAIResponse()` — identifiers that only exist inside ChatEngine's
// closure, not ProtocolClient's, so this threw a ReferenceError any time
// vision-via-MCP actually fired. Now correctly routed through `chat.`.
// ================================================================
const ProtocolClient = (() => {

  function create(assistantId, deps) {
  const { deviceEmulator, vision } = deps;
  let chat = null; // wired in by setChatEngine() after ChatEngine.create()
  function setChatEngine(chatInstance) { chat = chatInstance; }

  /** True only when this assistant is the one currently shown on screen.
   *  Used to gate the handful of UI/hardware side-effects that must only
   *  ever apply to the assistant the user is actually looking at (typing
   *  indicator, TTS audio playback, take_photo image lookup). */
  function isActive() { return assistantId === AssistantManager.getActiveId(); }

  /** Snapshot of THIS assistant's flat settings — replaces the old
   *  SettingsManager.getAll() (which always read the active assistant). */
  const getSettings = () => AssistantManager.getFlatSnapshot(assistantId);
  const getSetting  = (key) => AssistantManager.getFlatField(assistantId, key);

  let ws = null;
  let sessionId = '';
  let helloReceived = false;
  let helloTimeoutId = null;
  let reconnectAttempts = 0;
  let maxReconnectAttempts = 5;
  let autoReconnect = false;
  let isIntentionalClose = false;

  // Callbacks
  const callbacks = {
    onConnected:    null,
    onDisconnected: null,
    onError:        null,
    onHello:        null,
    onSTT:          null,
    onLLM:          null,
    onTTSStart:     null,
    onTTSSentence:  null,
    onTTSStop:      null,
    onAudio:        null,  // Binary audio from server
    onSystem:       null,
    onAlert:        null,
    onMCP:          null,
    onCustom:       null,
    onRawMessage:   null,  // Called for every message (for debug)
  };

  function on(event, fn) {
    // Try exact camelCase key first: 'on' + capitalize(event)
    // Then fall back to case-insensitive search so ALL-CAPS abbreviations
    // like 'STT', 'LLM', 'TTSStart', 'TTSSentence', 'TTSStop' work correctly.
    // Previously, capitalize('ttsStart') produced 'onTtsStart' but the callbacks
    // object has 'onTTSStart' — causing those callbacks to silently never register,
    // which is why AI bubbles, STT transcripts, and typing indicator removal all failed.
    const exactKey = 'on' + capitalize(event);
    if (callbacks.hasOwnProperty(exactKey)) {
      callbacks[exactKey] = fn;
      return;
    }
    // Case-insensitive fallback
    const lowerTarget = ('on' + event).toLowerCase();
    const matchedKey = Object.keys(callbacks).find(k => k.toLowerCase() === lowerTarget);
    if (matchedKey) {
      callbacks[matchedKey] = fn;
    } else {
      console.warn('[ProtocolClient.on] Unknown event:', event);
    }
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Open a WebSocket connection to the Xiaozhi server.
   * This mimics ESP32 WebsocketProtocol::OpenAudioChannel()
   */
  async function connect() {
    const s = getSettings();

    if (!s.wsUrl) {
      Logger.error('No WebSocket URL configured');
      return false;
    }
    if (!s.token) {
      // No token at all — refuse connection (device hasn't been provisioned)
      Logger.error('No access token — device must be provisioned first');
      return false;
    }

    // Note: 'test-token' IS the valid auth token for the Xiaozhi cloud.
    // The server authenticates the device primarily via Device-Id (MAC address) and Client-Id (UUID).
    // The token "test-token" is returned by the OTA endpoint and accepted by the WebSocket server
    // as the Authorization Bearer value — as long as:
    //   1. The device is registered (paired via activation code)
    //   2. Device-Id is LOWERCASE (firmware uses %02x in snprintf, e.g. "aa:bb:cc:dd:ee:ff")
    //      CRITICAL: The server rejects uppercase Device-Id with an immediate close frame!
    Logger.auth(`[${assistantId.slice(0,8)}] Using token: ${s.token === 'test-token' ? 'test-token (Xiaozhi cloud token)' : '***' + s.token.slice(-8)}`);

    isIntentionalClose = false;
    deviceEmulator.setState(deviceEmulator.STATES.CONNECTING);

    Logger.ws(`Connecting to: ${s.wsUrl}`);
    Logger.auth(`Device-Id: ${s.deviceId}, Client-Id: ${s.clientId}`);

    try {
      // Browser WebSocket cannot set Authorization / Device-Id / Client-Id / Protocol-Version
      // headers. Route through our Hono proxy which injects them like ESP32 firmware and
      // xiaozhi-web-client/proxy.py do on upstream connect.
      const proxyUrl = new URL('/api/ws', window.location.origin);
      proxyUrl.searchParams.set('url', s.wsUrl);
      proxyUrl.searchParams.set('device_id', s.deviceId);
      proxyUrl.searchParams.set('client_id', s.clientId);
      proxyUrl.searchParams.set('token', s.token);
      proxyUrl.searchParams.set('protocol_version', String(s.protocolVersion || 1));

      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const finalUrl = `${wsProtocol}//${window.location.host}${proxyUrl.pathname}${proxyUrl.search}`;

      Logger.ws(`Connecting via auth proxy → ${s.wsUrl}`);

      ws = new WebSocket(finalUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = handleOpen;
      ws.onmessage = handleMessage;
      ws.onerror = handleError;
      ws.onclose = handleClose;

      return true;

    } catch (err) {
      Logger.error('Failed to create WebSocket', err.message);
      deviceEmulator.setState(deviceEmulator.STATES.ERROR, err.message);
      if (callbacks.onError) callbacks.onError(err.message);
      return false;
    }
  }

  /** Handle WebSocket open event */
  function handleOpen() {
    Logger.ws('WebSocket connected. Sending hello...');

    // Send the hello message exactly as the ESP32 firmware does
    const s = getSettings();
    const hello = {
      type: 'hello',
      version: s.protocolVersion || 1,
      features: {
        mcp: true,
        // aec: false,  // We don't do echo cancellation in browser
      },
      transport: 'websocket',
      audio_params: {
        format: 'opus',
        sample_rate: AudioEngine.INPUT_SAMPLE_RATE,  // 16000
        channels: 1,
        frame_duration: s.frameDuration || 60,
      }
    };

    Logger.proto('→ hello', hello);
    sendText(hello);

    // Set timeout waiting for server hello (10 seconds, matching ESP32 firmware)
    helloTimeoutId = setTimeout(() => {
      if (!helloReceived) {
        Logger.error('Server hello timeout (10s)');
        const msg = 'Server did not respond to hello within 10 seconds';
        if (callbacks.onError) callbacks.onError(msg);
        forceClose();
      }
    }, 10000);
  }

  /** Handle incoming WebSocket messages */
  function handleMessage(event) {
    if (event.data instanceof ArrayBuffer) {
      // Binary message = Opus audio from server
      handleBinaryMessage(event.data);
    } else {
      // Text message = JSON
      handleTextMessage(event.data);
    }
  }

  /** Handle binary (audio) messages from server */
  function handleBinaryMessage(buffer) {
    const version = getSetting('protocolVersion') || 1;
    let opusPayload = buffer;

    if (version === 2 && buffer.byteLength >= 16) {
      // Parse BinaryProtocol2 header
      const view = new DataView(buffer);
      // Skip header (2+2+4+4+4 = 16 bytes), extract payload
      const payloadSize = view.getUint32(12, false); // big-endian
      opusPayload = buffer.slice(16, 16 + payloadSize);
    } else if (version === 3 && buffer.byteLength >= 4) {
      // Parse BinaryProtocol3 header (1+1+2 = 4 bytes)
      const view = new DataView(buffer);
      const payloadSize = view.getUint16(2, false); // big-endian
      opusPayload = buffer.slice(4, 4 + payloadSize);
    }
    // version 1 = raw Opus, no header

    Logger.audio(`← Binary audio ${opusPayload.byteLength}b (proto v${version})`);

    if (callbacks.onAudio) {
      callbacks.onAudio(opusPayload);
    }

    // AudioEngine's speaker output is a single shared hardware resource
    // (see AudioEngine module notes) — only the assistant currently on
    // screen is allowed to play TTS audio through it. A background
    // assistant's audio is still fully tracked (state, messages) — it
    // just doesn't make sound until the user switches to it.
    if (isActive() && getSetting('ttsPlayback')) {
      AudioEngine.enqueueTTSChunk(opusPayload);
    }
  }

  /** Handle text (JSON) messages from server */
  function handleTextMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      Logger.error('Failed to parse JSON message', text);
      return;
    }

    const type = msg.type;
    Logger.proto(`← ${type || '?'}`, msg);

    if (callbacks.onRawMessage) callbacks.onRawMessage(msg);

    switch (type) {
      case 'hello':
        handleServerHello(msg);
        break;

      case 'stt':
        handleSTT(msg);
        break;

      case 'llm':
        handleLLM(msg);
        break;

      case 'tts':
        handleTTS(msg);
        break;

      case 'system':
        handleSystem(msg);
        break;

      case 'alert':
        handleAlert(msg);
        break;

      case 'mcp':
        handleMCP(msg);
        break;

      case 'custom':
        if (callbacks.onCustom) callbacks.onCustom(msg);
        break;

      default:
        Logger.warn(`Unknown message type: ${type}`, msg);
    }
  }

  /** Handle server hello handshake response */
  function handleServerHello(msg) {
    if (helloTimeoutId) {
      clearTimeout(helloTimeoutId);
      helloTimeoutId = null;
    }

    if (msg.transport !== 'websocket') {
      Logger.error(`Unexpected transport: ${msg.transport}`);
      return;
    }

    helloReceived = true;
    sessionId = msg.session_id || '';
    reconnectAttempts = 0;

    Logger.ws(`Server hello received. Session: ${sessionId}`);
    Logger.auth(`Server audio params: ${JSON.stringify(msg.audio_params || {})}`);

    deviceEmulator.setState(deviceEmulator.STATES.IDLE);

    if (callbacks.onConnected) callbacks.onConnected(sessionId, msg);
    if (callbacks.onHello) callbacks.onHello(msg);
  }

  /** Handle STT (speech-to-text result) */
  function handleSTT(msg) {
    Logger.chat(`STT: "${msg.text}"`);
    if (callbacks.onSTT) callbacks.onSTT(msg.text, msg.session_id);
  }

  /** Handle LLM emotion/expression update */
  function handleLLM(msg) {
    Logger.chat(`LLM emotion: ${msg.emotion || 'neutral'}, text: ${msg.text || ''}`);
    if (callbacks.onLLM) callbacks.onLLM(msg.emotion, msg.text, msg.session_id);
  }

  /** Handle TTS (text-to-speech) state changes */
  function handleTTS(msg) {
    const state = msg.state;
    Logger.chat(`TTS ${state}: ${msg.text || ''}`);

    if (state === 'start') {
      deviceEmulator.setState(deviceEmulator.STATES.SPEAKING);
      if (callbacks.onTTSStart) callbacks.onTTSStart(msg.session_id);
    } else if (state === 'sentence_start') {
      if (callbacks.onTTSSentence) callbacks.onTTSSentence(msg.text, msg.session_id);
    } else if (state === 'stop') {
      deviceEmulator.setState(deviceEmulator.STATES.IDLE);
      if (callbacks.onTTSStop) callbacks.onTTSStop(msg.session_id);
    }
  }

  /** Handle system commands */
  function handleSystem(msg) {
    Logger.warn(`System command: ${msg.command}`, msg);
    if (callbacks.onSystem) callbacks.onSystem(msg.command, msg);
  }

  /** Handle alert messages */
  function handleAlert(msg) {
    Logger.warn(`Alert: [${msg.status}] ${msg.message}`);
    if (callbacks.onAlert) callbacks.onAlert(msg.status, msg.message, msg.emotion);
  }

  /** Handle MCP (Model Context Protocol) messages */
  function handleMCP(msg) {
    Logger.mcp('MCP message received', msg.payload);
    if (callbacks.onMCP) callbacks.onMCP(msg.payload, msg.session_id);

    // ── Handle MCP initialize from server ──────────────────────────────────
    // The server sends:
    //   { type:"mcp", payload:{ jsonrpc:"2.0", id:1, method:"initialize",
    //       params:{ capabilities:{ vision:{ url:"...", token:"..." } }, ... }}}
    // We parse capabilities.vision here, exactly like Esp32Camera::ParseCapabilities()
    // in the official firmware mcp_server.cc.
    if (msg.payload && msg.payload.method === 'initialize') {
      const params = msg.payload.params;
      if (params && params.capabilities) {
        const visionCap = params.capabilities.vision;
        if (visionCap && visionCap.url) {
          Logger.mcp('Vision capability received', { url: visionCap.url, hasToken: !!visionCap.token });
          // Store on THIS assistant's own VisionCapability instance.
          vision.setUrl(visionCap.url, visionCap.token || '');
        }
      }
      // Respond to initialize — mirrors ESP32 firmware ParseCapabilities/ReplyResult
      const response = {
        session_id: sessionId,
        type: 'mcp',
        payload: {
          jsonrpc: '2.0',
          id: msg.payload.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'xiaozhi-web-client', version: '1.0.0' }
          }
        }
      };
      sendText(response);
      Logger.mcp('→ MCP initialize response sent', null);
      return;
    }

    // Auto-respond to MCP capability queries (tools/list, etc.)
    if (msg.payload && msg.payload.method === 'tools/list') {
      // ── Official firmware reference: McpServer::AddCommonTools()  ──────────
      // mcp_server.cc lines 100–121: the firmware registers self.camera.take_photo
      // when a Camera is present.  We advertise the same tool here so the
      // Xiaozhi server knows it can call us with vision tool-call requests,
      // exactly as it would a real ESP32 with a camera attached.
      // ─────────────────────────────────────────────────────────────────────
      const cameraTools = vision.isAvailable() ? [
        {
          name: 'self.camera.take_photo',
          description:
            'Always remember you have a camera. If the user asks you to see something, ' +
            'use this tool to take a photo and then explain it.\n' +
            'Args:\n  `question`: The question that you want to ask about the photo.\n' +
            'Return:\n  A JSON object that provides the photo information.',
          inputSchema: {
            type: 'object',
            properties: {
              question: { type: 'string' }
            },
            required: ['question']
          }
        }
      ] : [];

      const response = {
        session_id: sessionId,
        type: 'mcp',
        payload: {
          jsonrpc: '2.0',
          id: msg.payload.id,
          result: {
            tools: cameraTools,
          }
        }
      };
      sendText(response);
      Logger.mcp(`→ MCP tools/list response (${cameraTools.length} tool(s))`, null);
    } else if (msg.payload && msg.payload.method === 'tools/call') {
      // ── Official firmware reference: McpServer::DoToolCall() ────────────
      // mcp_server.cc lines 508–559: firmware dispatches tools/call to the
      // registered callback, wraps the return value in a JSON-RPC result, and
      // sends it back via Protocol::SendMcpMessage() → WebSocket.
      //
      // self.camera.take_photo callback (mcp_server.cc lines 111–119):
      //   camera->Capture(); return camera->Explain(question);
      //
      // McpTool::Call() (mcp_server.h lines 272–311) wraps the std::string
      // returned by Explain() as:
      //   { content: [{type:"text", text:"<description>"}], isError: false }
      //
      // We replicate that exact wrapping here, using ImageInput.getPendingBlob()
      // to get the user-selected image that is waiting in the UI.
      // ─────────────────────────────────────────────────────────────────────
      const toolName = msg.payload.params?.name;
      const toolArgs = msg.payload.params?.arguments || {};
      const toolId   = msg.payload.id;

      if (toolName === 'self.camera.take_photo') {
        Logger.mcp(`→ tools/call self.camera.take_photo received, question: "${toolArgs.question}"`);

        // Retrieve the image blob the user attached in the UI.
        const pendingBlob = ImageInput.getPendingBlob();

        if (!pendingBlob) {
          // No image attached — the server called take_photo but the user hasn't
          // selected an image yet.  Return a graceful error so the LLM knows.
          const errResp = {
            session_id: sessionId,
            type: 'mcp',
            payload: {
              jsonrpc: '2.0',
              id: toolId,
              result: {
                content: [{ type: 'text', text: 'No image available. The user has not attached a photo yet.' }],
                isError: true
              }
            }
          };
          sendText(errResp);
          Logger.mcp('→ tools/call take_photo: no blob available, sent isError result');
          return;
        }

        // Execute vision upload asynchronously (mirrors firmware's async Capture+Explain).
        // We cannot block the WebSocket message loop, so we fire-and-forget and
        // send the MCP result when the HTTP upload completes.
        (async () => {
          try {
            const question = (toolArgs.question && toolArgs.question.trim()) || 'Please describe this image.';
            Logger.mcp(`Executing take_photo: uploading image, question="${question}"`);

            // ── Replicate Esp32Camera::Explain() ──────────────────────────
            // esp32_camera.cc lines 155–321:
            //   1. Encode frame to JPEG (we already have a browser File/Blob)
            //   2. POST multipart/form-data to explain_url_ with question + file
            //   3. Return http->ReadAll() as std::string
            // ─────────────────────────────────────────────────────────────
            let jpegBlob = pendingBlob;
            if (!pendingBlob.type.includes('jpeg') && !pendingBlob.type.includes('jpg')) {
              jpegBlob = await convertToJpeg(pendingBlob);
            }

            const boundary = '----XiaozhiWebClientBoundary' + Date.now().toString(16);
            const enc = new TextEncoder();

            const questionPart = enc.encode(
              '--' + boundary + '\r\n' +
              'Content-Disposition: form-data; name="question"\r\n' +
              '\r\n' +
              question + '\r\n'
            );
            const fileHeader = enc.encode(
              '--' + boundary + '\r\n' +
              'Content-Disposition: form-data; name="file"; filename="camera.jpg"\r\n' +
              'Content-Type: image/jpeg\r\n' +
              '\r\n'
            );
            const fileFooter = enc.encode('\r\n--' + boundary + '--\r\n');
            const jpegBytes  = await jpegBlob.arrayBuffer();

            const totalLen = questionPart.length + fileHeader.length + jpegBytes.byteLength + fileFooter.length;
            const body = new Uint8Array(totalLen);
            let off = 0;
            body.set(questionPart, off); off += questionPart.length;
            body.set(fileHeader, off);   off += fileHeader.length;
            body.set(new Uint8Array(jpegBytes), off); off += jpegBytes.byteLength;
            body.set(fileFooter, off);

            const resp = await fetch('/api/vision/explain', {
              method: 'POST',
              headers: {
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'X-Vision-Url':   vision.getUrl(),
                'X-Vision-Token': vision.getToken(),
                'X-Device-Id':    getSetting('deviceId'),
                'X-Client-Id':    getSetting('clientId'),
              },
              body: body.buffer,
            });

            const rawBody = await resp.text();
            Logger.vision(`take_photo HTTP ${resp.status}, body: ${rawBody.slice(0, 200)}`);

            // Extract the description text (response may be JSON or plain text)
            let visionText = rawBody.trim();
            try {
              const parsed = JSON.parse(rawBody);
              if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) {
                visionText = parsed.text.trim();
              }
            } catch (_e) { /* plain text — use as-is */ }

            if (!resp.ok) {
              // Vision HTTP error — send isError result back to server
              const errResp = {
                session_id: sessionId,
                type: 'mcp',
                payload: {
                  jsonrpc: '2.0',
                  id: toolId,
                  result: {
                    content: [{ type: 'text', text: `Vision upload failed (HTTP ${resp.status}): ${visionText}` }],
                    isError: true
                  }
                }
              };
              sendText(errResp);
              Logger.mcp(`→ tools/call take_photo: HTTP ${resp.status} error sent to server`);
              return;
            }

            // ── Replicate McpTool::Call() result wrapping ─────────────────
            // mcp_server.h lines 285–305: wraps std::string return value as
            //   { content:[{type:"text",text:"..."}], isError:false }
            // then McpServer::ReplyResult() wraps in jsonrpc 2.0 result
            // then Protocol::SendMcpMessage() adds session_id + type:"mcp"
            // ─────────────────────────────────────────────────────────────
            const mcpResult = {
              session_id: sessionId,
              type: 'mcp',
              payload: {
                jsonrpc: '2.0',
                id: toolId,
                result: {
                  content: [{ type: 'text', text: visionText }],
                  isError: false
                }
              }
            };
            sendText(mcpResult);
            Logger.mcp(`→ tools/call take_photo: MCP result sent to server (${visionText.length} chars)`);
            Logger.vision(`Vision description delivered to LLM via MCP tool result: "${visionText.slice(0, 100)}..."`);

            // ── Local UI update (mirrors firmware display behavior) ────────
            // The firmware calls display->SetChatMessage("assistant", text) for
            // sentence_start events.  We render the vision description into the
            // chat immediately so the user sees it before server TTS arrives.
            // We do NOT call finalizeAIResponse() here — the server will send
            // proper tts/sentence_start events once the LLM uses the tool result.
            //
            // PHASE 2 FIX: this used to call the bare identifiers
            // beginAIResponse()/appendAIResponseSentence()/finalizeAIResponse(),
            // which only exist inside ChatEngine's closure — NOT ProtocolClient's
            // — so this threw "beginAIResponse is not defined" and silently broke
            // vision-via-MCP any time it fired. Now routed through `chat` (this
            // assistant's own ChatEngine instance). ChatEngine's own functions
            // internally gate all DOM/UIController calls on isActive(), so a
            // background assistant's vision message is still recorded in its
            // message history without touching the screen.
            if (chat) {
              if (isActive()) UIController.hideTypingIndicator();
              chat.beginAIResponse(null);
              chat.appendAIResponseSentence(visionText);
              chat.finalizeAIResponse();
            }

          } catch (err) {
            Logger.error('take_photo tool execution failed', err.message);
            // Send error result back to server so LLM knows something went wrong
            const errResp = {
              session_id: sessionId,
              type: 'mcp',
              payload: {
                jsonrpc: '2.0',
                id: toolId,
                result: {
                  content: [{ type: 'text', text: `Vision error: ${err.message}` }],
                  isError: true
                }
              }
            };
            sendText(errResp);
            Logger.mcp('→ tools/call take_photo: exception result sent to server');
          }
        })();

      } else {
        // Unknown tool — reply with JSON-RPC error (unchanged behavior for other tools)
        const response = {
          session_id: sessionId,
          type: 'mcp',
          payload: {
            jsonrpc: '2.0',
            id: toolId,
            error: {
              code: -32601,
              message: 'Tool not found on virtual device'
            }
          }
        };
        sendText(response);
        Logger.mcp(`→ MCP tools/call error (tool: ${toolName})`, null);
      }
    }
  }

  /** Handle WebSocket error */
  function handleError(event) {
    Logger.error('WebSocket error', event);
    if (callbacks.onError) callbacks.onError('WebSocket error');
  }

  /** Handle WebSocket close */
  function handleClose(event) {
    Logger.ws(`WebSocket closed: code=${event.code} reason="${event.reason}" clean=${event.wasClean}`);

    if (helloTimeoutId) {
      clearTimeout(helloTimeoutId);
      helloTimeoutId = null;
    }

    helloReceived = false;
    deviceEmulator.setState(deviceEmulator.STATES.IDLE);

    // Detect authentication failure: server closes with 1008 (policy violation) or
    // 4xxx codes. If this happens, the device likely needs to re-provision.
    // DO NOT auto-clear pairing — let the user decide. Just warn them.
    const authFailureCodes = [1008, 4001, 4002, 4003, 4401, 4403];
    const isAuthFailure = authFailureCodes.includes(event.code) ||
                          (event.reason && /auth|token|unauthorized|forbidden/i.test(event.reason));
    if (isAuthFailure && !isIntentionalClose) {
      Logger.warn(`WebSocket closed with auth error (code=${event.code}). Device may need to re-pair.`);
      if (callbacks.onError) callbacks.onError(`Authentication failed (${event.code}): ${event.reason || 'Server rejected connection'}. Try resetting pairing in Settings.`);
      return;
    }

    if (callbacks.onDisconnected) callbacks.onDisconnected(event.code, event.reason);

    // Auto-reconnect logic (disabled by default)
    if (!isIntentionalClose && autoReconnect && reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      const delay = Math.min(reconnectAttempts * 2000, 30000);
      Logger.warn(`Auto-reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
      setTimeout(connect, delay);
    }
  }

  /** Gracefully disconnect */
  function disconnect() {
    isIntentionalClose = true;
    helloReceived = false;
    sessionId = '';
    if (ws) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'User disconnect');
      }
      ws = null;
    }
    Logger.ws('Disconnected');
  }

  function forceClose() {
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  /** Send a JSON text message */
  function sendText(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      Logger.warn('Cannot send: WebSocket not open');
      return false;
    }
    const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
    ws.send(json);
    return true;
  }

  /** Send binary audio data */
  function sendAudio(buffer) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const version = getSetting('protocolVersion') || 1;

    let data;
    if (version === 2) {
      // Build BinaryProtocol2 header
      const header = new ArrayBuffer(16);
      const view = new DataView(header);
      view.setUint16(0, 2, false);   // version = 2
      view.setUint16(2, 0, false);   // type = 0 (OPUS)
      view.setUint32(4, 0, false);   // reserved
      view.setUint32(8, Date.now() & 0xFFFFFFFF, false); // timestamp
      view.setUint32(12, buffer.byteLength, false);       // payload_size
      data = appendBuffers(header, buffer);
    } else if (version === 3) {
      // Build BinaryProtocol3 header
      const header = new ArrayBuffer(4);
      const view = new DataView(header);
      view.setUint8(0, 0);  // type = 0 (OPUS)
      view.setUint8(1, 0);  // reserved
      view.setUint16(2, buffer.byteLength, false); // payload_size
      data = appendBuffers(header, buffer);
    } else {
      // Version 1: raw Opus, no header
      data = buffer;
    }

    ws.send(data);
    return true;
  }

  function appendBuffers(a, b) {
    const tmp = new Uint8Array(a.byteLength + b.byteLength);
    tmp.set(new Uint8Array(a), 0);
    tmp.set(new Uint8Array(b), a.byteLength);
    return tmp.buffer;
  }

  /** Send listen start message — signals server to expect incoming audio stream */
  function sendListenStart(mode = 'manual') {
    const msg = {
      session_id: sessionId,
      type: 'listen',
      state: 'start',
      mode: mode,
    };
    Logger.proto('→ listen start', msg);
    deviceEmulator.setState(deviceEmulator.STATES.LISTENING);
    return sendText(msg);
  }

  /** Send listen stop message */
  function sendListenStop() {
    const msg = {
      session_id: sessionId,
      type: 'listen',
      state: 'stop',
    };
    Logger.proto('→ listen stop', msg);
    return sendText(msg);
  }

  /**
   * Send listen detect message — TEXT MODE bypass.
   *
   * CRITICAL: This is the ONLY correct way to send text to the server without audio.
   * The server's ListenTextMessageHandler reads msg_json["text"] ONLY when state="detect"
   * and routes it directly to startToChat() (bypassing ASR entirely).
   *
   * state="start" with text field is IGNORED by the server.
   * state="stop" with no audio causes "no audio to process" (no response).
   * state="detect" with text field → LLM gets the text directly → AI responds.
   *
   * This mirrors the firmware's SendWakeWordDetected() behavior.
   */
  function sendListenDetect(text) {
    const msg = {
      session_id: sessionId,
      type: 'listen',
      state: 'detect',
      text: text,
    };
    Logger.proto('→ listen detect (text bypass)', msg);
    deviceEmulator.setState(deviceEmulator.STATES.LISTENING);
    return sendText(msg);
  }

  /** Send abort message */
  function sendAbort(reason = 'user_interruption') {
    const msg = {
      session_id: sessionId,
      type: 'abort',
      reason: reason,
    };
    Logger.proto('→ abort', msg);
    deviceEmulator.setState(deviceEmulator.STATES.IDLE);
    AudioEngine.clearTTSQueue();
    return sendText(msg);
  }

  function isConnected() {
    return ws !== null && ws.readyState === WebSocket.OPEN && helloReceived;
  }

  function isConnecting() {
    return ws !== null && (ws.readyState === WebSocket.CONNECTING || !helloReceived);
  }

  function getSessionId() { return sessionId; }

  // PHASE 2 FIX: close the create(assistantId, deps) factory function body
  // (previous session left this unclosed, causing "Unexpected )" — the
  // trailing })() below is the IIFE wrapper for the ProtocolClient module
  // itself, one level up, and must stay). Also expose setChatEngine so
  // SessionManager can complete the circular chat<->protocol wiring.
  return {
    setChatEngine,
    connect,
    disconnect,
    sendText,
    sendAudio,
    sendListenStart,
    sendListenStop,
    sendListenDetect,
    sendAbort,
    isConnected,
    isConnecting,
    getSessionId,
    isActive,
    on,
    setAutoReconnect: (v) => { autoReconnect = v; },
  };
  } // end create()

  return { create };
})();

// ================================================================
// MODULE: ChatEngine
// Manages chat state, message history, and text interaction
// ----------------------------------------------------------------
// PHASE 2 CHANGE: Rewritten as a factory — ChatEngine.create(assistantId,
// deps) returns an independent chat engine bound to ONE assistant, with
// its own in-memory `messages` array (seeded from and persisted back to
// that assistant's `conversationHistory` field via AssistantManager, so
// chat history survives page refresh, per assistant).
//
// Every DOM-touching function (renderMessage, showTypingIndicator, etc.)
// is guarded by isActive() — it only paints the screen when THIS
// assistant is the one currently visible/active. This is what gives us
// "switching assistants never disconnects, and message history never
// mixes": a background assistant's ChatEngine instance keeps receiving
// and storing STT/LLM/TTS-derived messages exactly as before, it just
// doesn't touch the DOM until the user switches back to it — at which
// point SessionManager.renderActiveSession() replays its full message
// list into the chat pane.
//
// `deps.protocol` / `deps.vision` are THIS assistant's own ProtocolClient
// / VisionCapability instances (see SessionManager) — never the globally
// "active" ones, so sendTextMessage()/sendImageMessage() always talk to
// the correct independent WebSocket connection even if the user has since
// switched to viewing a different assistant.
// ================================================================
const ChatEngine = (() => {

  function create(assistantId, deps) {
  const { protocol, vision } = deps;
  const messages = [];
  let pendingUserMessage = null;  // User's typed message, awaiting AI response
  let pendingAIMessage = null;    // AI message being built incrementally
  let lastSender = null;
  let conversationCount = 0;

  /** True only when this assistant is the one currently shown on screen. */
  function isActive() {
    return assistantId === AssistantManager.getActiveId();
  }

  // ── Seed message history from persisted storage (survives refresh) ──
  (function loadPersistedHistory() {
    const a = AssistantManager.getById(assistantId);
    if (!a || !Array.isArray(a.conversationHistory)) return;
    a.conversationHistory.forEach(m => {
      messages.push({ ...m, timestamp: new Date(m.timestamp) });
      lastSender = m.sender;
    });
  })();

  /** Persist a finalized message onto the assistant record (trims to last 200). */
  function persistMessage(msg) {
    AssistantManager.appendConversationMessage(assistantId, msg);
  }

  /**
   * Send a text message to the AI using the CORRECT Xiaozhi protocol.
   *
   * CRITICAL PROTOCOL FIX (discovered from xinnan-tech/xiaozhi-esp32-server source):
   *
   * The server's ListenTextMessageHandler processes states differently:
   *   - "start": just resets audio buffers, does NOT read "text" field
   *   - "stop": triggers ASR on accumulated audio (no audio = no response)
   *   - "detect": reads the "text" field and calls startToChat() directly!
   *              This bypasses ASR entirely and sends text straight to LLM.
   *
   * Therefore text-only mode MUST use state="detect", NOT state="start".
   *
   * Correct protocol for text mode:
   *   { "session_id":"...", "type":"listen", "state":"detect", "text":"hello" }
   *
   * This is what the firmware sends for wake-word-triggered text:
   *   { "session_id":"...", "type":"listen", "state":"detect", "text":"Hi XiaoZhi" }
   */
  async function sendTextMessage(text) {
    if (!protocol.isConnected()) {
      Logger.warn('Cannot send message: not connected');
      showToast('Not connected to server', 'error');
      return false;
    }

    if (!text || !text.trim()) return false;

    const trimmedText = text.trim();
    pendingUserMessage = trimmedText;

    // Add user message to chat
    addMessage('user', trimmedText);
    conversationCount++;

    Logger.chat(`→ Sending text via listen{detect}: "${trimmedText}"`);

    // Show typing indicator
    if (isActive()) UIController.showTypingIndicator('Sending to AI...');

    // BUG #2 FIX: Long typed messages were rejected by the server with:
    // "Detect is only for wake words, do not send long texts."
    //
    // Root cause: listen{state:"detect"} is the wake-word channel.
    // The Xiaozhi server enforces a text-length limit (~80 chars) on
    // this channel — anything longer is rejected as "not a wake word".
    //
    // Fix: Split messages that exceed the server limit at natural
    // sentence/clause boundaries and send each chunk via detect.
    // All chunks are sent before the server starts processing, so the
    // LLM receives the full message context and replies coherently.
    //
    // Short messages (≤ 80 chars) go through unchanged — no behaviour change.
    const MAX_DETECT_LEN = 80;

    if (trimmedText.length <= MAX_DETECT_LEN) {
      // Short message — send directly, same as before
      protocol.sendListenDetect(trimmedText);
    } else {
      // Long message — split into ≤ 80-char chunks at sentence boundaries,
      // then send all chunks. The last chunk triggers the AI response.
      const chunks = splitTextIntoChunks(trimmedText, MAX_DETECT_LEN);
      Logger.chat(`Long message split into ${chunks.length} chunks`);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        Logger.chat(`→ Chunk ${i + 1}/${chunks.length}: "${chunk}"`);
        protocol.sendListenDetect(chunk);
        // Small delay between chunks so server can queue them correctly
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 80));
        }
      }
    }

    return true;
  }

  /**
   * Split a long string into chunks of at most maxLen characters,
   * breaking at sentence-end punctuation, then at whitespace.
   * Ensures no chunk exceeds maxLen so server's wake-word validator passes.
   */
  function splitTextIntoChunks(text, maxLen) {
    if (text.length <= maxLen) return [text];

    const chunks = [];
    let remaining = text.trim();

    while (remaining.length > maxLen) {
      // Try to break at sentence-ending punctuation within the limit
      let breakAt = -1;
      const window = remaining.slice(0, maxLen);

      // Prefer: . ! ? followed by space or end-of-window
      const sentenceEnd = window.search(/[.!?。！？][\s]|[.!?。！？]$/);
      if (sentenceEnd !== -1) {
        breakAt = sentenceEnd + 1; // include the punctuation
      }

      // Fallback: last whitespace in window
      if (breakAt === -1) {
        const lastSpace = window.lastIndexOf(' ');
        if (lastSpace > 0) {
          breakAt = lastSpace;
        }
      }

      // Last resort: hard cut at maxLen
      if (breakAt === -1 || breakAt === 0) {
        breakAt = maxLen;
      }

      chunks.push(remaining.slice(0, breakAt).trim());
      remaining = remaining.slice(breakAt).trim();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks.filter(c => c.length > 0);
  }

  /**
   * Start voice recording and stream REAL Opus audio to server.
   *
   * Protocol order (matches firmware):
   * 1. Send listen{start, mode} — server begins accepting audio
   * 2. Start microphone capture with Opus encoding
   * 3. Each encoded Opus frame → sendAudio() → binary WebSocket frame
   * 4. When done: stopVoiceInput() sends listen{stop}
   */
  async function startVoiceInput(mode = 'auto') {
    if (!protocol.isConnected()) {
      showToast('Not connected to server', 'error');
      return false;
    }

    if (!AssistantManager.getFlatField(assistantId, 'audioEnabled')) {
      showToast('Audio disabled in settings', 'warning');
      return false;
    }

    // BUG #1 FIX: Start microphone capture FIRST, THEN send listen{start}.
    //
    // Previously sendListenStart() was called before startCapture() — meaning
    // the server entered listen state before the browser AudioContext was running.
    // After the closeMobileSidebar() DOM mutation added in the latest commit,
    // the AudioContext is sometimes left in 'suspended' state when the
    // startCapture() call arrives inside a setTimeout callback.
    // A suspended AudioContext never fires onaudioprocess, so zero Opus frames
    // reach the server even though listen/start was already sent.
    //
    // Correct order (mirrors firmware: hardware mic is always ready before
    // the device signals listen/start):
    //   1. Start capture + encoder — ensure audio pipeline is live
    //   2. THEN send listen{start} — server knows audio is already flowing
    //   3. Each Opus frame → sendAudio()
    //   4. stopVoiceInput() → sendListenStop()

    // 1. Start microphone capture — each callback delivers a real Opus frame
    const started = await AudioEngine.startCapture((opusBuffer) => {
      // opusBuffer is an ArrayBuffer containing a raw Opus packet
      Logger.audio(`→ Sending Opus frame ${opusBuffer.byteLength}b`);
      protocol.sendAudio(opusBuffer);
    });

    if (!started) {
      showToast('Could not access microphone. Check browser permissions.', 'error');
      return false;
    }

    // 2. Capture is live — NOW tell server to start accepting audio
    protocol.sendListenStart(mode);

    // Show audio meter
    document.getElementById('audioMeterSection').style.display = 'block';

    Logger.chat(`Voice input started — streaming Opus @ ${AudioEngine.INPUT_SAMPLE_RATE}Hz`);
    return true;
  }

  function stopVoiceInput() {
    AudioEngine.stopCapture();
    document.getElementById('audioMeterSection').style.display = 'none';
    protocol.sendListenStop();
    Logger.chat('Voice input stopped');
  }

  function addMessage(sender, text, options = {}) {
    const now = new Date();
    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      sender,       // 'user' | 'ai' | 'system'
      text,
      timestamp: now,
      status: options.status || 'sent',
      emotion: options.emotion || null,
      grouped: false,
      imageThumb: options.imageThumb || null,   // data URL for thumbnail
      imageName:  options.imageName  || null,   // filename for alt text
    };

    messages.push(msg);
    // PHASE 2: only paint the DOM when this assistant is the one on screen.
    // A background assistant's message is still recorded (messages array +
    // persisted history below) so switching back to it replays the full,
    // uninterrupted conversation.
    if (isActive()) {
      UIController.renderMessage(msg, lastSender);
      updateConversationPreview(text, now);
    }
    lastSender = sender;
    persistMessage(msg);

    return msg;
  }

  function updateConversationPreview(text, time) {
    const previewEl = document.getElementById('convPreview');
    const timeEl    = document.getElementById('convTime');
    if (previewEl) previewEl.textContent = text.length > 50 ? text.slice(0, 47) + '...' : text;
    if (timeEl) timeEl.textContent = formatTime(time);
  }

  function formatTime(date) {
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff/60000) + 'm';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Clear in-memory + persisted history and (if active) the on-screen chat pane. */
  function clearMessages() {
    messages.length = 0;
    pendingUserMessage = null;
    pendingAIMessage = null;
    lastSender = null;
    AssistantManager.clearConversationHistory(assistantId);
    if (isActive()) UIController.clearMessages();
  }

  /**
   * PHASE 2: Replay this assistant's full message history into the chat
   * pane. Called by SessionManager.switchTo() right after making this
   * assistant active — this is what makes switching assistants feel like
   * switching Discord/Slack channels: the whole conversation reappears
   * instantly, scroll position included (UIController scrolls to bottom).
   */
  function renderHistory() {
    UIController.clearMessages();
    messages.forEach((msg, idx) => {
      UIController.renderMessage(msg, idx > 0 ? messages[idx - 1].sender : null);
    });
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      updateConversationPreview(last.text, last.timestamp);
    }
  }

  // Build AI message incrementally from TTS sentence events
  let aiMessageEl = null;
  let aiMessageText = '';

  /**
   * BUG #2 FIX: resetAIResponse() — called by the llm event handler.
   * Resets internal state WITHOUT touching the DOM (no element creation).
   * The DOM element is created lazily when the first sentence arrives.
   */
  function resetAIResponse() {
    // If there's a dangling element from a previous response that never got
    // finalized, clean it up first.
    if (aiMessageEl && !document.getElementById(aiMessageEl.id)?.isConnected) {
      // element was never appended — just discard
    } else if (aiMessageEl) {
      aiMessageEl.remove();
    }
    aiMessageText = '';
    aiMessageEl = null;
  }

  function beginAIResponse(emotion) {
    aiMessageText = '';
    // BUG #2 FIX: beginStreamingMessage no longer appends to DOM.
    // The element stays in memory until updateStreamingMessage appends it.
    // PHASE 2: created unconditionally (cheap, detached DOM node) even for a
    // background assistant so aiMessageEl/aiMessageText bookkeeping below
    // stays consistent; updateStreamingMessage/finalizeStreamingMessage are
    // themselves gated on isActive() so a background stream never becomes
    // visible or touches the live #messagesContainer.
    aiMessageEl = UIController.beginStreamingMessage('ai', emotion);
  }

  /**
   * Ensure an AI response bubble has been prepared.
   * Called from ttsStart to handle the case where no LLM event preceded it.
   * If beginAIResponse() (or resetAIResponse()) was already called, this is a no-op.
   */
  function ensureAIResponseStarted() {
    if (!aiMessageEl) {
      beginAIResponse(null);
    }
  }

  function appendAIResponseSentence(sentence) {
    // Lazy init: if neither llm nor ttsStart created the element yet, do it now.
    if (!aiMessageEl) {
      beginAIResponse(null);
    }
    aiMessageText += (aiMessageText ? ' ' : '') + sentence;
    if (aiMessageEl && isActive()) {
      UIController.updateStreamingMessage(aiMessageEl, aiMessageText);
    }
    Logger.chat(`[${assistantId.slice(0,8)}] AI sentence: "${sentence}"`);
  }

  function finalizeAIResponse() {
    if (aiMessageText && aiMessageEl) {
      if (isActive()) {
        UIController.finalizeStreamingMessage(aiMessageEl, aiMessageText);
        updateConversationPreview(aiMessageText, new Date());
      }
      // Store in message history (always — even for a background assistant —
      // so persisted conversationHistory and renderHistory() replay stay complete).
      const finalMsg = {
        id: 'ai_' + Date.now(),
        sender: 'ai',
        text: aiMessageText,
        timestamp: new Date(),
        status: 'delivered',
      };
      messages.push(finalMsg);
      persistMessage(finalMsg);
      lastSender = 'ai';
    } else if (aiMessageEl && !aiMessageText) {
      // TTS ended but no sentence text was received — element was never appended
      // (lazy approach), so nothing to remove from DOM.  Just discard it.
      // If somehow it was appended, clean it up.
      const container = document.getElementById('messagesContainer');
      if (container && container.contains(aiMessageEl)) {
        aiMessageEl.remove();
      }
    }
    aiMessageText = '';
    aiMessageEl = null;
  }

  /**
   * BUG #1 FIX — deduplicate typed messages.
   *
   * sendTextMessage() immediately renders the user's message and stores the
   * trimmed text in pendingUserMessage.  When the server echoes it back as an
   * STT event the stt callback calls this function.  If the incoming text
   * matches what we already rendered we clear the pending marker and return
   * true (= "already rendered, skip").  Otherwise we return false (= "this is
   * a voice-transcribed message, add it normally").
   */
  function consumePendingUserMessage(text) {
    if (pendingUserMessage !== null && pendingUserMessage === text) {
      pendingUserMessage = null;
      return true;
    }
    return false;
  }

  /**
   * Send an image + optional text question to Xiaozhi Vision.
   *
   * ══════════════════════════════════════════════════════════
   * PROTOCOL (reverse-engineered from Esp32Camera::Explain()
   * in xiaozhi-esp32/main/boards/common/esp32_camera.cc)
   * ══════════════════════════════════════════════════════════
   *
   * The official firmware:
   *   1. Gets vision URL + token from MCP initialize capabilities
   *      (capabilities.vision.url / capabilities.vision.token)
   *   2. POSTs multipart/form-data to that URL with:
   *        --<boundary>
   *        Content-Disposition: form-data; name="question"
   *
   *        <text question>
   *        --<boundary>
   *        Content-Disposition: form-data; name="file"; filename="camera.jpg"
   *        Content-Type: image/jpeg
   *
   *        <jpeg bytes>
   *        --<boundary>--
   *   3. Request headers: Authorization: Bearer <token>, Device-Id, Client-Id
   *   4. Response: plain text AI description
   *   5. Description is then used as context for the LLM (sent via listen{detect})
   *
   * IMPORTANT NOTES:
   *   - The server sends the URL as http:// but it's an https:// endpoint.
   *     The Hono proxy normalises http:// → https:// when forwarding.
   *   - The "Vision URL host is not allowed" error was caused by the proxy
   *     rejecting http:// URLs. This is now fixed in src/index.tsx.
   *   - Upload is NOT through WebSocket — it's a separate HTTP request.
   *   - Upload is NOT through MCP tool calls.
   *   - The image is NOT base64 — it's raw binary JPEG in multipart form.
   *   - There is no signed URL pre-step — direct POST to vision endpoint.
   *
   * @param {File|Blob} imageFile - The image to analyze
   * @param {string} [promptText] - Optional user question
   * @param {string} [displayName] - Filename for display in chat bubble
   * @param {string} [dataUrl] - Data URL for thumbnail display in chat bubble
   */
  async function sendImageMessage(imageFile, promptText, displayName, dataUrl) {
    if (!protocol.isConnected()) {
      Logger.warn('Cannot send image: not connected');
      showToast('Not connected to server', 'error');
      return false;
    }

    const question = (promptText && promptText.trim()) || 'Please describe this image.';
    const filename  = displayName || 'photo.jpg';

    // ── VERBOSE VISION LOGGING ──────────────────────────────────────
    Logger.chat('=== VISION IMAGE SEND START ===');
    Logger.chat(`Question: "${question}"`);
    Logger.chat(`Filename: ${filename}`);
    Logger.chat(`Image size: ${Math.round(imageFile.size / 1024)} KB (${imageFile.size} bytes)`);
    Logger.chat(`Image type: ${imageFile.type}`);
    Logger.chat(`Vision capability available: ${vision.isAvailable()}`);
    Logger.chat(`Vision URL: ${vision.getUrl() || '(not set)'}`);
    Logger.chat(`Vision token: ${vision.getToken() ? ('...' + vision.getToken().slice(-8)) : '(none)'}`);

    // Show user message with thumbnail immediately
    const userMsgText = question;
    pendingUserMessage = userMsgText;
    addMessage('user', userMsgText, { imageThumb: dataUrl, imageName: filename });
    conversationCount++;

    if (isActive()) UIController.showTypingIndicator('Sending to AI...');

    if (!vision.isAvailable()) {
      Logger.warn('Vision URL not available — server has not advertised vision capability yet');
      Logger.warn('Make sure you are connected and the server sent an MCP initialize with vision capabilities');
      if (isActive()) UIController.hideTypingIndicator();
      showToast('Vision not available. Connect to server first.', 'error');
      return false;
    }

    // ══════════════════════════════════════════════════════════════════════
    // OFFICIAL FIRMWARE FLOW — User-initiated image send
    // ══════════════════════════════════════════════════════════════════════
    //
    // Reference: mcp_server.cc + protocol.cc + application.cc
    //
    // The official ESP32 firmware does NOT upload images on user initiative.
    // It NEVER directly calls Explain() from user-space.
    //
    // The correct flow is:
    //   1. Device advertises self.camera.take_photo in tools/list response.
    //      (McpServer::AddCommonTools(), mcp_server.cc lines 100–121)
    //
    //   2. The server decides WHEN to call the tool based on LLM reasoning.
    //      It sends: {"type":"mcp","payload":{"method":"tools/call",...}}
    //
    //   3. The device executes Capture() + Explain(), wraps result in
    //      JSON-RPC result, sends back via Protocol::SendMcpMessage()
    //      → {"type":"mcp","payload":{"result":{...}}}
    //
    //   4. The server injects the tool result into the LLM conversation
    //      and generates the TTS response.
    //
    // Therefore, when the user attaches an image and clicks Send, we:
    //   1. Keep the blob in ImageInput (getPendingBlob() returns it).
    //   2. Send the user's question via listen{detect} — this triggers
    //      the LLM to decide it needs vision and calls self.camera.take_photo.
    //   3. The tools/call handler (handleMCP → tools/call branch above)
    //      picks up the blob, uploads it, and sends the MCP result back.
    //   4. The server feeds the result to the LLM and sends TTS events.
    //
    // The blob must REMAIN in ImageInput until the tools/call arrives.
    // clearAttachment() is called AFTER the tool call completes or on error.
    // ══════════════════════════════════════════════════════════════════════

    Logger.vision('Image attached — sending question via listen{detect} to trigger tools/call');
    Logger.vision(`Question: "${question}" | Blob size: ${imageFile.size} bytes`);

    // The blob is already stored in ImageInput.pendingAttachment by the time
    // this function is called (handleSendClick calls ImageInput.clearAttachment()
    // after calling sendImageMessage — we need the blob to persist until tools/call).
    // We keep the reference alive by re-storing it here just in case.
    // (ImageInput.clearAttachment was NOT called yet at this point because
    //  handleSendClick calls it before sendImageMessage — but we have imageFile.)
    //
    // We store the blob back so getPendingBlob() can access it during tools/call.
    // This is safe because handleSendClick already cleared the UI attachment bar.
    ImageInput._storePendingBlobForToolCall(imageFile);

    // Send the question text via the standard text channel.
    // The LLM will recognize it has vision capability (from tools/list) and
    // issue a tools/call for self.camera.take_photo.
    protocol.sendListenDetect(question.slice(0, 80));

    return true;
  }

  /**
   * Convert any image Blob to a JPEG Blob using an offscreen canvas.
   */
  async function convertToJpeg(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(jpegBlob => {
          if (jpegBlob) resolve(jpegBlob);
          else reject(new Error('Canvas toBlob failed'));
        }, 'image/jpeg', 0.85);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image for conversion'));
      };
      img.src = url;
    });
  }

  return {
    sendTextMessage,
    sendImageMessage,
    startVoiceInput,
    stopVoiceInput,
    addMessage,
    clearMessages,
    renderHistory,
    beginAIResponse,
    resetAIResponse,
    ensureAIResponseStarted,
    appendAIResponseSentence,
    finalizeAIResponse,
    consumePendingUserMessage,
    getMessages: () => [...messages],
  };
  } // end create()

  return { create };
})();

// ================================================================
// MODULE: SessionManager                                  [PHASE 2]
// ----------------------------------------------------------------
// The missing orchestrator. Every other module below this point
// (DeviceEmulator, ProvisioningManager, VisionCapability, ProtocolClient,
// ChatEngine) was already converted to a `create(assistantId, deps)`
// factory by the time this session picked up the work — but nothing
// was actually calling `.create()` or wiring the instances together.
// AppController/UIController still called them as bare global
// singletons (`ProtocolClient.on(...)`, `DeviceEmulator.setState(...)`),
// which throws at runtime now that those modules only export `{ create }`.
//
// SessionManager fixes this: it owns one FULL session bundle per
// assistant —
//   { deviceEmulator, provisioning, vision, protocol, chat }
// — created lazily and kept alive for the assistant's entire lifetime
// (until the assistant is deleted), regardless of whether that
// assistant is the one currently shown on screen. This is what makes
// "switch away, connection stays alive" possible: switching only
// changes which session's DOM updates are allowed through; it never
// tears down or recreates a session.
//
// Ownership rules enforced here:
//   - AssistantManager.setConnectionStatus(id, status) is ALWAYS called
//     for every session, active or not, so the sidebar status dot for
//     EVERY assistant is always live and correct.
//   - UIController.setConnectionState()/updateSessionId()/etc (the
//     functions that touch the on-screen chat panel/header) are ONLY
//     called when the event's assistant === the currently active one.
//   - AudioEngine playback (a shared hardware resource — see AudioEngine
//     module notes) is already gated inside ProtocolClient/ChatEngine
//     via their own isActive() checks, so SessionManager doesn't need
//     to gate that itself.
// ================================================================
const SessionManager = (() => {
  /** assistantId -> { deviceEmulator, provisioning, vision, protocol, chat } */
  const sessions = new Map();

  /** Human-readable connection-status labels, mapped from DeviceEmulator
   *  states — mirrors what AppController.handleDeviceStateChange() used
   *  to compute per-singleton. Kept local since only SessionManager now
   *  decides an assistant's persisted connection.status. */
  function deviceStateToConnectionStatus(deviceState, protocolConnected) {
    const S = DeviceEmulator.STATES;
    switch (deviceState) {
      case S.CONNECTING: return 'connecting';
      case S.LISTENING:   return 'listening';
      case S.SPEAKING:    return 'speaking';
      case S.ERROR:       return 'disconnected';
      case S.IDLE:        return protocolConnected ? 'connected' : 'disconnected';
      default:            return 'disconnected';
    }
  }

  /** True only when `id` is the assistant currently shown on screen. */
  function isActiveId(id) { return id === AssistantManager.getActiveId(); }

  /**
   * Build (or return the existing) full session bundle for one assistant.
   * Safe to call repeatedly — a second call for the same id is a no-op
   * that just returns the already-built bundle.
   */
  function getOrCreateSession(assistantId) {
    if (sessions.has(assistantId)) return sessions.get(assistantId);

    const deviceEmulator = DeviceEmulator.create(assistantId);
    const provisioning   = ProvisioningManager.create(assistantId);
    const vision         = VisionCapability.create(assistantId);
    const protocol       = ProtocolClient.create(assistantId, { deviceEmulator, vision });
    const chat           = ChatEngine.create(assistantId, { protocol, vision });
    // Complete the circular wiring: ProtocolClient needs to call back
    // into ChatEngine (consumePendingUserMessage / addMessage / etc.)
    // but ChatEngine also needs `protocol` — so ChatEngine is built
    // second and handed to ProtocolClient afterwards.
    protocol.setChatEngine(chat);

    const session = { assistantId, deviceEmulator, provisioning, vision, protocol, chat };
    sessions.set(assistantId, session);

    wireDeviceState(session);
    wireProtocolCallbacks(session);

    return session;
  }

  /** DeviceEmulator state changes -> persisted status + (if active) UI */
  function wireDeviceState(session) {
    const { assistantId, deviceEmulator, protocol } = session;
    deviceEmulator.onStateChange((newState, prevState, reason) => {
      const status = deviceStateToConnectionStatus(newState, protocol.isConnected());
      AssistantManager.setConnectionStatus(assistantId, status);
      if (isActiveId(assistantId)) {
        UIController.setConnectionState(status);
      }
    });
  }

  /** ProtocolClient events -> persisted status/session-id + (if active) UI/chat */
  function wireProtocolCallbacks(session) {
    const { assistantId, deviceEmulator, protocol, chat } = session;

    protocol.on('connected', (sessionId, helloMsg) => {
      Logger.ws(`[${assistantId.slice(0, 8)}] Connected! Session ID: ${sessionId}`);
      AssistantManager.setConnectionStatus(assistantId, 'connected');
      if (isActiveId(assistantId)) {
        UIController.setConnectionState('connected');
        UIController.updateSessionId(sessionId);
        UIController.addSystemMessage(
          `Connected to Xiaozhi server. Session: ${sessionId || '(no session id)'}`,
          'fa-plug-circle-check'
        );
        showToast('Connected to Xiaozhi server!', 'success', 'Connected');
      }
    });

    protocol.on('disconnected', (code, reason) => {
      Logger.ws(`[${assistantId.slice(0, 8)}] Disconnected: ${code} ${reason}`);
      AssistantManager.setConnectionStatus(assistantId, 'disconnected');
      AudioEngine.clearTTSQueue();
      if (isActiveId(assistantId)) {
        UIController.setConnectionState('disconnected');
        UIController.updateSessionId('');
        UIController.hideTypingIndicator();
        if (!reason || reason === 'User disconnect') {
          UIController.addSystemMessage('Disconnected from server.', 'fa-plug-circle-xmark');
        } else {
          UIController.addSystemMessage(`Disconnected: ${reason || 'Connection lost'}`, 'fa-exclamation-circle');
          showToast(`Disconnected: ${reason || 'Connection lost'}`, 'error', 'Disconnected');
        }
      }
    });

    protocol.on('error', (message) => {
      Logger.error(`[${assistantId.slice(0, 8)}] Protocol error`, message);
      AssistantManager.setConnectionStatus(assistantId, 'disconnected');
      if (isActiveId(assistantId)) {
        UIController.setConnectionState('disconnected');
        UIController.hideTypingIndicator();
        showToast(message, 'error', 'Connection Error');
        UIController.addSystemMessage(`Error: ${message}`, 'fa-circle-exclamation');
      }
    });

    protocol.on('stt', (text, sessionId) => {
      Logger.chat(`[${assistantId.slice(0, 8)}] STT received: "${text}"`);
      if (isActiveId(assistantId)) UIController.hideSTTPreview();

      if (text && text.trim()) {
        if (chat.consumePendingUserMessage(text.trim())) {
          Logger.chat('STT matches pending typed message — skipping duplicate render');
        } else {
          chat.addMessage('user', text.trim());
        }
      }
      if (isActiveId(assistantId)) UIController.showTypingIndicator('AI is thinking...');
    });

    protocol.on('llm', (emotion, text, sessionId) => {
      if (isActiveId(assistantId)) UIController.hideTypingIndicator();
      chat.resetAIResponse();
    });

    protocol.on('ttsStart', (sessionId) => {
      Logger.chat(`[${assistantId.slice(0, 8)}] TTS started`);
      if (isActiveId(assistantId)) {
        UIController.hideTypingIndicator();
        UIController.setConnectionState('speaking');
      }
      chat.ensureAIResponseStarted();
    });

    protocol.on('ttsSentence', (text, sessionId) => {
      if (text) {
        Logger.chat(`[${assistantId.slice(0, 8)}] TTS sentence: "${text}"`);
        chat.appendAIResponseSentence(text);
      }
    });

    protocol.on('ttsStop', (sessionId) => {
      Logger.chat(`[${assistantId.slice(0, 8)}] TTS stopped`);
      if (isActiveId(assistantId)) {
        UIController.hideTypingIndicator();
        UIController.setConnectionState('connected');
      }
      chat.finalizeAIResponse();

      // Auto-listen mode: restart listening after AI speaks. Only makes
      // sense for the assistant whose mic is actually capturing — that
      // can only ever be the active assistant (AudioEngine mic capture
      // is a single shared hardware resource, same as TTS playback).
      if (isActiveId(assistantId) &&
          AssistantManager.getFlatField(assistantId, 'listeningMode') === 'auto' &&
          AudioEngine.isCapturing()) {
        protocol.sendListenStart('auto');
      }
    });

    protocol.on('audio', (buffer) => {
      // Already handled by binary message dispatcher + AudioEngine inside
      // ProtocolClient itself (gated by ProtocolClient's own isActive()).
    });

    protocol.on('system', (command, msg) => {
      Logger.warn(`[${assistantId.slice(0, 8)}] System command received: ${command}`);
      if (isActiveId(assistantId)) {
        UIController.addSystemMessage(`System: ${command}`, 'fa-gear');
        if (command === 'reboot') {
          showToast('Server requested reboot', 'warning', 'System');
          setTimeout(() => {
            UIController.addSystemMessage('Virtual reboot complete.', 'fa-rotate-right');
          }, 1000);
        }
      }
    });

    protocol.on('alert', (status, message, emotion) => {
      Logger.warn(`[${assistantId.slice(0, 8)}] Alert: [${status}] ${message}`);
      if (isActiveId(assistantId)) {
        showToast(`${message}`, 'warning', status);
        UIController.addSystemMessage(`⚠️ ${status}: ${message}`, 'fa-triangle-exclamation');
      }
    });

    protocol.on('mcp', (payload, sessionId) => {
      Logger.mcp(`[${assistantId.slice(0, 8)}] MCP message`, payload);
    });
  }

  /**
   * Switch the active assistant: updates AssistantManager's activeId
   * (which fires onChange -> sidebar/header re-render, see UIController),
   * ensures that assistant's session bundle exists, replays its chat
   * history into the now-visible chat panel, and syncs the connection
   * UI to reflect THAT session's actual live state — all WITHOUT
   * touching any other session's connection.
   */
  function switchTo(assistantId) {
    const switched = AssistantManager.setActive(assistantId);
    if (!switched) return false;

    const session = getOrCreateSession(assistantId);

    // Replay this assistant's isolated chat history into the chat panel.
    session.chat.renderHistory();

    // Sync connection UI to this session's real current state (it may be
    // mid-connect, connected, listening, speaking, or disconnected —
    // completely independent of whatever the previously active assistant
    // was doing).
    const status = deviceStateToConnectionStatus(
      session.deviceEmulator.getState(),
      session.protocol.isConnected()
    );
    UIController.setConnectionState(status);
    UIController.updateSessionId(session.protocol.getSessionId());

    // PHASE 4: refresh avatar displays for the newly active assistant
    try { AvatarSystem.refreshAllAvatarDisplays(); } catch(e) { /* non-fatal */ }

    // OLIVIA FEATURE: restore THIS assistant's own saved volume onto the
    // shared TTS gain node + repaint the slider/icon in the header.
    try { VolumeSystem.refreshActiveVolume(); } catch(e) { /* non-fatal */ }

    return true;
  }

  /** User clicks Connect for a specific assistant (defaults to active). */
  async function connectAssistant(assistantId) {
    const id = assistantId || AssistantManager.getActiveId();
    const session = getOrCreateSession(id);
    const { deviceEmulator, provisioning, protocol } = session;

    if (protocol.isConnected() || protocol.isConnecting()) {
      if (isActiveId(id)) showToast('Already connected or connecting', 'warning');
      return;
    }

    const wsUrl = AssistantManager.getFlatField(id, 'wsUrl');
    if (!wsUrl) {
      if (isActiveId(id)) showToast('Please configure the WebSocket URL in Settings', 'error');
      return;
    }

    Logger.ws(`[${id.slice(0, 8)}] User initiated connection...`);
    deviceEmulator.setState(deviceEmulator.STATES.CONNECTING);

    try {
      // Step 1: Provision device if not yet paired (ESP32 activation flow).
      if (!AssistantManager.isPairedById(id)) {
        Logger.auth(`[${id.slice(0, 8)}] Device unpaired — starting OTA provisioning...`);
        if (isActiveId(id)) {
          UIController.addSystemMessage('Registering virtual device with Xiaozhi server...', 'fa-link');
        }

        const result = await provisioning.provision();

        if (result.needsUserAction) {
          if (isActiveId(id)) {
            UIController.showPairingModal(result.code, result.message);
            UIController.addSystemMessage(
              `Activation code: ${result.code} — enter at xiaozhi.me`,
              'fa-key'
            );
          }

          await provisioning.waitForActivation();

          if (isActiveId(id)) {
            UIController.hidePairingModal();
            UIController.addSystemMessage('Device paired successfully!', 'fa-circle-check');
            showToast('Device paired!', 'success', 'Activation Complete');
          }
        }
      } else {
        // Device was previously paired. Refresh OTA to get latest token/URL.
        Logger.auth(`[${id.slice(0, 8)}] Device previously paired — refreshing OTA config before connecting...`);
        try {
          const refreshResult = await provisioning.provision(true); // silent=true
          if (refreshResult.needsUserAction) {
            Logger.warn(`[${id.slice(0, 8)}] Previously paired device now requires re-activation`);
            AssistantManager.clearPairingById(id);
            if (isActiveId(id)) {
              UIController.showPairingModal(refreshResult.code, refreshResult.message);
              UIController.addSystemMessage(
                `Re-activation required: ${refreshResult.code} — enter at xiaozhi.me`,
                'fa-key'
              );
            }
            await provisioning.waitForActivation();
            if (isActiveId(id)) {
              UIController.hidePairingModal();
              UIController.addSystemMessage('Device re-paired successfully!', 'fa-circle-check');
            }
          } else {
            Logger.auth(`[${id.slice(0, 8)}] OTA refresh complete — device still registered`);
          }
        } catch (otaErr) {
          Logger.warn(`[${id.slice(0, 8)}] OTA refresh failed, proceeding with cached settings`, otaErr.message);
        }
      }

      // Step 2: Connect WebSocket with token from OTA.
      const token = AssistantManager.getFlatField(id, 'token');
      Logger.auth(`[${id.slice(0, 8)}] Connecting with token: ${token ? '***' + token.slice(-4) : '(none)'}`);
      const ok = await protocol.connect();
      if (!ok) {
        deviceEmulator.setState(deviceEmulator.STATES.ERROR, 'connect failed');
        AssistantManager.setConnectionStatus(id, 'disconnected');
        if (isActiveId(id)) {
          UIController.setConnectionState('disconnected');
          showToast('Failed to connect. Check server settings.', 'error', 'Connection Failed');
        }
      }
    } catch (err) {
      Logger.error(`[${id.slice(0, 8)}] Connect/provision failed`, err.message);
      provisioning.cancel();
      deviceEmulator.setState(deviceEmulator.STATES.ERROR, 'provisioning failed');
      AssistantManager.setConnectionStatus(id, 'disconnected');
      if (isActiveId(id)) {
        UIController.hidePairingModal();
        UIController.setConnectionState('disconnected');
        showToast(err.message || 'Provisioning failed', 'error', 'Activation Failed');
        UIController.addSystemMessage(`Activation error: ${err.message}`, 'fa-circle-exclamation');
      }
    }
  }

  /** User clicks Disconnect for a specific assistant (defaults to active). */
  function disconnectAssistant(assistantId) {
    const id = assistantId || AssistantManager.getActiveId();
    const session = sessions.get(id);
    if (!session) return;

    session.protocol.sendAbort('user_interruption');
    session.protocol.disconnect();
    session.deviceEmulator.setState(session.deviceEmulator.STATES.IDLE, 'user disconnect');
    AssistantManager.setConnectionStatus(id, 'disconnected');

    if (isActiveId(id)) {
      AudioEngine.stopCapture();
      AudioEngine.clearTTSQueue();
      UIController.hideTypingIndicator();
      UIController.updateMicButtonState(false);
      UIController.setConnectionState('disconnected');
    }
    Logger.ws(`[${id.slice(0, 8)}] User disconnected`);
  }

  /** Create a brand-new assistant, build its session, and switch to it. */
  function createAssistant(name) {
    const created = AssistantManager.createAssistant(name);
    getOrCreateSession(created.id);
    switchTo(created.id);
    return created;
  }

  /**
   * Delete an assistant: disconnect its session (if connected), tear the
   * bundle out of the Map, then delegate the actual removal (including
   * the "never delete the last assistant" guard and activeId re-pointing)
   * to AssistantManager.removeAssistant(). On success, switch the UI to
   * whichever assistant AssistantManager auto-selected as the new active
   * one so the chat panel/header refresh immediately.
   */
  function deleteAssistant(id) {
    const session = sessions.get(id);
    if (session) {
      try {
        session.protocol.disconnect();
      } catch (e) { /* already disconnected */ }
      sessions.delete(id);
    }

    // PHASE 4: remove avatar from storage when deleting an assistant
    try { AvatarStorage.remove(id); } catch(e) { /* non-fatal */ }

    // OLIVIA FEATURE: remove this assistant's saved volume too, so
    // localStorage doesn't accumulate orphaned entries for deleted assistants.
    try { VolumeStorage.remove(id); } catch(e) { /* non-fatal */ }

    const removed = AssistantManager.removeAssistant(id);
    if (!removed) return false;

    // AssistantManager already re-pointed activeId if we deleted the
    // active assistant. Refresh the chat/connection UI to match.
    switchTo(AssistantManager.getActiveId());
    return true;
  }

  /** Rename an assistant (name is UI-label only, no session impact). */
  function renameAssistant(id, name) {
    return AssistantManager.renameAssistant(id, name);
  }

  /**
   * Called once at boot: build a session for every persisted assistant
   * (so background-connected state, once implemented, can be restored)
   * and ensure the active one's chat history is rendered.
   */
  function initAll() {
    AssistantManager.getAllAssistants().forEach(a => getOrCreateSession(a.id));
    const activeId = AssistantManager.getActiveId();
    if (activeId) {
      const session = sessions.get(activeId);
      session.chat.renderHistory();
      const status = deviceStateToConnectionStatus(
        session.deviceEmulator.getState(),
        session.protocol.isConnected()
      );
      UIController.setConnectionState(status);
    }
  }

  function getSession(id) { return sessions.get(id || AssistantManager.getActiveId()); }
  function getActiveSession() { return sessions.get(AssistantManager.getActiveId()); }

  return {
    initAll,
    getOrCreateSession,
    getSession,
    getActiveSession,
    switchTo,
    connectAssistant,
    disconnectAssistant,
    createAssistant,
    deleteAssistant,
    renameAssistant,
  };
})();

// ================================================================
// MODULE: UIController
// All DOM manipulation, rendering, and UI state management
// ================================================================
const UIController = (() => {
  // Element references
  const els = {};
  function el(id) {
    if (!els[id]) els[id] = document.getElementById(id);
    return els[id];
  }

  // PHASE 2: which assistant's fields the Settings panel currently shows.
  // Defaults to the active assistant but can be re-targeted to ANY
  // assistant via the per-item gear icon in the sidebar list, so users
  // can rename/reconfigure/delete a background assistant without first
  // switching to it. All settings read/write functions below resolve
  // this id via getSettingsTargetId() rather than assuming "active".
  let settingsTargetId = null;
  function getSettingsTargetId() {
    return settingsTargetId || AssistantManager.getActiveId();
  }

  /** Initialize UI bindings */
  function init() {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Settings panel — gear in the sidebar profile card always targets
    // the currently ACTIVE assistant (see openSettings()). Per-item gear
    // icons in the AI Assistants list target THAT specific assistant
    // (see openSettingsFor(), wired inside renderAssistantList()).
    el('settingsToggleBtn').addEventListener('click', openSettings);
    el('closeSettingsBtn').addEventListener('click', closeSettings);
    el('saveSettingsBtn').addEventListener('click', saveSettings);
    el('resetSettingsBtn').addEventListener('click', resetSettings);
    el('resetPairingBtn').addEventListener('click', resetPairing);

    // PHASE 2: Assistant-level actions inside the Settings panel — all
    // target getSettingsTargetId(), NOT necessarily the active assistant.
    if (el('settingsReconnectBtn')) {
      el('settingsReconnectBtn').addEventListener('click', () => {
        SessionManager.connectAssistant(getSettingsTargetId());
      });
    }
    if (el('settingsDisconnectBtn')) {
      el('settingsDisconnectBtn').addEventListener('click', () => {
        SessionManager.disconnectAssistant(getSettingsTargetId());
      });
    }
    if (el('deleteAssistantBtn')) {
      el('deleteAssistantBtn').addEventListener('click', handleDeleteAssistantClick);
    }
    if (el('assistantNameInput')) {
      // Renaming saves immediately on blur (not gated behind the main
      // "Save Settings" button) so it feels the same as renaming a
      // channel/conversation in Discord/Slack-style apps.
      el('assistantNameInput').addEventListener('blur', () => {
        const id = getSettingsTargetId();
        const newName = el('assistantNameInput').value.trim();
        if (newName && SessionManager.renameAssistant(id, newName)) {
          Logger.info(`Assistant ${id.slice(0, 8)} renamed to "${newName}"`);
        } else {
          // Reject empty name — restore the current value.
          el('assistantNameInput').value = AssistantManager.getById(id)?.name || '';
        }
      });
    }

    // Pairing modal
    el('copyPairingCodeBtn').addEventListener('click', copyPairingCode);
    el('cancelPairingBtn').addEventListener('click', cancelPairing);

    // Connection buttons
    el('connectBtn').addEventListener('click', () => AppController.connect());
    el('disconnectBtn').addEventListener('click', () => AppController.disconnect());

    // Clear chat — targets the active assistant's session.
    el('clearChatBtn').addEventListener('click', () => {
      const session = SessionManager.getActiveSession();
      if (session) session.chat.clearMessages();
      showToast('Chat cleared', 'info');
    });

    // Message input
    el('messageInput').addEventListener('keydown', handleInputKeydown);
    el('messageInput').addEventListener('input', handleInputChange);
    // BUG #4 FIX: close mobile sidebar when user taps/focuses the message box
    el('messageInput').addEventListener('focus', () => closeMobileSidebar());
    el('sendBtn').addEventListener('click', handleSendClick);

    // Mic button
    el('micBtn').addEventListener('click', handleMicClick);
    el('micBtn').addEventListener('mousedown', handleMicMouseDown);
    el('micBtn').addEventListener('mouseup', handleMicMouseUp);
    el('micBtn').addEventListener('touchstart', handleMicMouseDown, { passive: true });
    el('micBtn').addEventListener('touchend', handleMicMouseUp, { passive: true });

    // Image / Plus button
    ImageInput.init();

    // Mobile sidebar toggle
    el('sidebarToggleMobile').addEventListener('click', () => {
      el('sidebar').classList.toggle('mobile-open');
    });

    // BUG #4 FIX: Close mobile sidebar when tapping outside it.
    // On desktop (> 768 px) the sidebar is always visible — the isMobile()
    // guard ensures we only close it in the slide-in mobile state.
    document.addEventListener('click', (e) => {
      if (!isMobileSidebarOpen()) return;
      const sidebar = el('sidebar');
      const toggleBtn = el('sidebarToggleMobile');
      // Ignore clicks that originated inside the sidebar or on the toggle button
      if (sidebar.contains(e.target) || toggleBtn.contains(e.target)) return;
      closeMobileSidebar();
    });

    // Also close on touch-based scroll-start outside the sidebar
    document.addEventListener('touchstart', (e) => {
      if (!isMobileSidebarOpen()) return;
      const sidebar = el('sidebar');
      const toggleBtn = el('sidebarToggleMobile');
      if (sidebar.contains(e.target) || toggleBtn.contains(e.target)) return;
      closeMobileSidebar();
    }, { passive: true });

    // Debug console
    el('clearDebugBtn').addEventListener('click', () => {
      el('debugLog').innerHTML = '';
    });
    el('copyDebugBtn').addEventListener('click', () => {
      const text = el('debugLog').innerText;
      navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard', 'success'));
    });

    // ── PHASE 2: AI Assistants sidebar — real "Add Assistant" ────────
    // Creates a brand-new, fully independent assistant (own device
    // identity, own pairing/connection, own chat history) and switches
    // to it immediately. Every other assistant's live connection is
    // completely untouched — see SessionManager.createAssistant().
    const addAssistantBtn = el('addAssistantBtn');
    if (addAssistantBtn) {
      addAssistantBtn.addEventListener('click', () => {
        const name = prompt('Name your new assistant:', 'New Assistant');
        if (name === null) return; // user cancelled
        const created = SessionManager.createAssistant(name.trim() || 'New Assistant');
        showToast(`"${created.name}" created`, 'success', 'Assistant Added');
      });
    }

    // Initial render of the assistant list + header from AssistantManager.
    renderAssistantList();
    renderActiveAssistantHeader();

    // Keep the sidebar/header in sync with any AssistantManager change
    // (switching active assistant, connection-status updates, etc.)
    AssistantManager.onChange(() => {
      renderAssistantList();
      renderActiveAssistantHeader();
    });

    // Load settings into form
    loadSettingsIntoForm();

    // PHASE 4: Initialize the avatar upload system (non-blocking, catches all errors)
    try {
      AvatarSystem.init();
    } catch (e) {
      Logger.warn('[AvatarSystem] init failed non-fatally', e && e.message);
    }

    // OLIVIA FEATURE: Initialize per-assistant speech volume system
    // (Speaker button + slider popup + live gain wiring). Non-blocking,
    // catches all errors — a bug here must never prevent boot.
    try {
      VolumeSystem.init();
    } catch (e) {
      Logger.warn('[VolumeSystem] init failed non-fatally', e && e.message);
    }
  }

  /** BUG #4 FIX: Close the mobile sidebar (no-op on desktop). */
  function closeMobileSidebar() {
    el('sidebar').classList.remove('mobile-open');
  }

  /** Returns true only when the sidebar is open in mobile slide-in mode. */
  function isMobileSidebarOpen() {
    return el('sidebar').classList.contains('mobile-open') &&
           window.innerWidth <= 768;
  }

  let micHolding = false;
  let micClickTimeout = null;
  let micToggled = false;

  // PHASE 2 NOTE: mic capture (AudioEngine) is a single shared hardware
  // resource, so voice input always targets the CURRENTLY ACTIVE
  // assistant's session — there is no concept of "background" voice input.
  function handleMicMouseDown(e) {
    const session = SessionManager.getActiveSession();
    if (!session || !session.protocol.isConnected()) return;
    micClickTimeout = setTimeout(() => {
      micHolding = true;
      Logger.audio('PTT (push-to-talk) start');
      // BUG #4 FIX: Close mobile sidebar when voice input starts
      closeMobileSidebar();
      session.chat.startVoiceInput('manual');
      updateMicButtonState(true);
    }, 300);
  }

  function handleMicMouseUp(e) {
    if (micClickTimeout) clearTimeout(micClickTimeout);
    if (micHolding) {
      micHolding = false;
      const session = SessionManager.getActiveSession();
      if (session) session.chat.stopVoiceInput();
      updateMicButtonState(false);
      Logger.audio('PTT stop');
    }
  }

  function handleMicClick(e) {
    const session = SessionManager.getActiveSession();
    if (!session || !session.protocol.isConnected()) {
      showToast('Connect to server first', 'warning');
      return;
    }
    // Click (not hold) toggles auto-mode
    if (!micHolding) {
      if (!micToggled) {
        micToggled = true;
        // BUG #4 FIX: Close mobile sidebar when voice input starts
        closeMobileSidebar();
        session.chat.startVoiceInput('auto');
        updateMicButtonState(true);
        showToast('Listening... (click again to stop)', 'info');
      } else {
        micToggled = false;
        session.chat.stopVoiceInput();
        updateMicButtonState(false);
      }
    }
  }

  function updateMicButtonState(active) {
    const btn = el('micBtn');
    const icon = el('micIcon');
    if (active) {
      btn.classList.add('active');
      icon.className = 'fas fa-stop';
    } else {
      btn.classList.remove('active');
      icon.className = 'fas fa-microphone';
      micToggled = false;
    }
  }

  function handleInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendClick();
    }
  }

  function handleInputChange() {
    const input = el('messageInput');
    const text = input.value;

    // Auto-resize
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';

    // BUG #3 FIX: removed maxlength restriction — char count now shown without limit
    const charCountEl = el('charCount');
    if (charCountEl) charCountEl.textContent = text.length > 0 ? `${text.length}` : '';
  }

  function handleSendClick() {
    const input = el('messageInput');
    const text = input.value.trim();

    // Check if there's a pending image attachment
    const attachment = ImageInput.getAttachment();

    if (!attachment && !text) return;

    // OLIVIA FEATURE: intercept local natural-language volume commands
    // BEFORE anything is sent to Xiaozhi. Only plain text messages (no
    // image attachment) are checked — an image caption like "turn your
    // volume up" alongside a photo is still ambiguous chat content, so
    // it is intentionally left to normal vision/chat handling.
    // VolumeSystem.tryHandleLocalCommand() returns true only when it
    // fully recognized + applied the command (updated volume, painted
    // the slider, and shown a local confirmation) — in that case the
    // message must NOT reach ChatEngine.sendTextMessage()/Xiaozhi at all.
    if (!attachment && text && VolumeSystem.tryHandleLocalCommand(text)) {
      input.value = '';
      input.style.height = 'auto';
      const charCountEl2 = el('charCount');
      if (charCountEl2) charCountEl2.textContent = '';
      closeMobileSidebar();
      ImageInput.closePopup();
      return;
    }

    input.value = '';
    input.style.height = 'auto';
    const charCountEl = el('charCount');
    if (charCountEl) charCountEl.textContent = '';

    // BUG #4 FIX: Close mobile sidebar when user sends a message
    closeMobileSidebar();

    // Close plus popup if open
    ImageInput.closePopup();

    const session = SessionManager.getActiveSession();
    if (!session) return;

    if (attachment) {
      // Image message: upload via vision API, then send text prompt
      const promptText = text || 'Please describe this image.';
      ImageInput.clearAttachment();  // Remove the preview bar
      session.chat.sendImageMessage(attachment.blob, promptText, attachment.name, attachment.dataUrl);
    } else {
      // Text-only message — unchanged behavior
      session.chat.sendTextMessage(text);
    }
  }

  function switchTab(tab) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Show/hide panels
    const debugPanel = el('debugPanel');
    const infoPanel  = el('infoPanel');
    const chatArea   = document.querySelector('.chat-area');

    debugPanel.style.display = 'none';
    infoPanel.style.display  = 'none';

    if (tab === 'debug') {
      debugPanel.style.display = 'flex';
      // Scroll to bottom
      setTimeout(() => {
        const log = el('debugLog');
        log.scrollTop = log.scrollHeight;
      }, 50);
    } else if (tab === 'info') {
      infoPanel.style.display = 'block';
      updateIdentityDisplay();
    }
  }

  function updateIdentityDisplay() {
    const display = el('identityDisplay');
    if (!display) return;
    const activeSession = SessionManager.getActiveSession();
    const info = activeSession ? activeSession.deviceEmulator.getIdentityInfo() : {};
    display.innerHTML = Object.entries(info)
      .map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`)
      .join('');
  }

  /** Open Settings scoped to the currently ACTIVE assistant (sidebar
   *  profile gear). */
  function openSettings() {
    settingsTargetId = AssistantManager.getActiveId();
    loadSettingsIntoForm();
    el('settingsPanel').classList.add('open');
  }

  /** Open Settings scoped to a SPECIFIC assistant (per-item gear icon
   *  in the AI Assistants sidebar list) — works for background
   *  assistants too, without switching to them first. */
  function openSettingsFor(assistantId) {
    settingsTargetId = assistantId;
    loadSettingsIntoForm();
    el('settingsPanel').classList.add('open');
  }

  function closeSettings() {
    el('settingsPanel').classList.remove('open');
    // Revert to "always follow the active assistant" once the panel closes.
    settingsTargetId = null;
  }

  function loadSettingsIntoForm() {
    const id = getSettingsTargetId();
    const s  = AssistantManager.getFlatSnapshot(id);
    if (el('assistantNameInput')) el('assistantNameInput').value = s.assistantName || '';
    el('wsUrlInput').value           = s.wsUrl || '';
    if (el('otaUrlInput')) el('otaUrlInput').value = s.otaUrl || '';
    // PHASE 4: deviceNameInput is now hidden — still set it for protocol use
    if (el('deviceNameInput')) el('deviceNameInput').value = 'O.L.I.V.I.A.';
    el('deviceIdInput').value         = s.deviceId || '';
    el('clientIdInput').value         = s.clientId || '';
    el('protocolVersionInput').value  = String(s.protocolVersion || 1);
    el('frameDurationInput').value    = String(s.frameDuration || 60);
    el('listeningModeInput').value    = s.listeningMode || 'auto';
    el('audioEnabled').checked        = s.audioEnabled !== false;
    el('ttsPlayback').checked         = s.ttsPlayback !== false;
    updatePairingStatusDisplay();
    updateSettingsConnectionStatusDisplay();

    // PHASE 4: load avatar for the assistant being edited
    try { AvatarSystem.loadSettingsAvatar(id); } catch(e) { /* non-fatal */ }

    // Never allow deleting the last remaining assistant — mirrors the
    // hard backstop in AssistantManager.removeAssistant().
    if (el('deleteAssistantBtn')) {
      el('deleteAssistantBtn').disabled = AssistantManager.getAllAssistants().length <= 1;
    }
  }

  /** Connection-status line inside the Settings panel — reflects
   *  whichever assistant the panel is currently scoped to (which may
   *  be a background assistant, not necessarily the one on screen). */
  function updateSettingsConnectionStatusDisplay() {
    const display = el('assistantConnectionStatusDisplay');
    if (!display) return;
    const id = getSettingsTargetId();
    const a  = AssistantManager.getById(id);
    const status = a ? a.connection.status : 'disconnected';
    const info = ASSISTANT_STATUS_LABELS[status] || ASSISTANT_STATUS_LABELS.disconnected;
    display.textContent = info.label;
    display.className = 'pairing-status-display ' + (status === 'connected' || status === 'listening' || status === 'speaking' ? 'paired' : 'unpaired');
  }

  function updatePairingStatusDisplay() {
    const display = el('pairingStatusDisplay');
    if (!display) return;
    if (AssistantManager.isPairedById(getSettingsTargetId())) {
      display.textContent = 'Paired ✓';
      display.className = 'pairing-status-display paired';
    } else {
      display.textContent = 'Not paired — click Connect to activate';
      display.className = 'pairing-status-display unpaired';
    }
  }

  function updatePairingStatus(state, code) {
    updatePairingStatusDisplay();
    const statusText = el('pairingStatusText');
    const statusIcon = el('pairingStatusIcon');
    if (!statusText) return;

    const labels = {
      unpaired:        'Registering device...',
      pairing_pending: 'Waiting for you to enter code at xiaozhi.me...',
      paired:          'Paired successfully!',
      failed:          'Pairing failed',
      expired:         'Activation code expired',
    };
    statusText.textContent = labels[state] || state;

    if (statusIcon) {
      if (state === 'paired') {
        statusIcon.className = 'fas fa-circle-check';
      } else if (state === 'failed' || state === 'expired') {
        statusIcon.className = 'fas fa-circle-xmark';
      } else {
        statusIcon.className = 'fas fa-circle-notch fa-spin';
      }
    }

    if (code && el('pairingCodeDisplay')) {
      el('pairingCodeDisplay').textContent = code;
    }
  }

  function showPairingModal(code, message) {
    const overlay = el('pairingOverlay');
    if (!overlay) return;

    if (el('pairingCodeDisplay')) el('pairingCodeDisplay').textContent = code || '------';
    if (el('pairingMessage') && message) {
      el('pairingMessage').innerHTML =
        escapeHtml(message).replace(/\n/g, '<br>') +
        '<br>Go to <a href="https://xiaozhi.me" target="_blank" rel="noopener">xiaozhi.me</a> and enter this code.';
    }
    updatePairingStatus(ProvisioningManager.PAIRING_STATES.PAIRING_PENDING, code);
    overlay.style.display = 'flex';
  }

  function hidePairingModal() {
    const overlay = el('pairingOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  function copyPairingCode() {
    const code = el('pairingCodeDisplay')?.textContent?.trim();
    if (!code || code === '------') return;
    navigator.clipboard.writeText(code).then(() => showToast('Code copied', 'success'));
  }

  function cancelPairing() {
    const session = SessionManager.getActiveSession();
    if (session) session.provisioning.cancel();
    hidePairingModal();
    setConnectionState('disconnected');
    showToast('Pairing cancelled', 'info');
  }

  function resetPairing() {
    if (!confirm('Reset pairing? You will need to activate again at xiaozhi.me.')) return;
    AssistantManager.clearPairingById(getSettingsTargetId());
    updatePairingStatusDisplay();
    showToast('Pairing reset', 'info');
    Logger.auth('Pairing cleared by user');
  }

  /** Delete the assistant the Settings panel currently targets — with
   *  confirmation and the "never delete last one" guard surfaced as a
   *  toast (the hard backstop itself lives in AssistantManager). */
  function handleDeleteAssistantClick() {
    const id = getSettingsTargetId();
    const a = AssistantManager.getById(id);
    if (!a) return;

    if (AssistantManager.getAllAssistants().length <= 1) {
      showToast('Cannot delete the last remaining assistant', 'error');
      return;
    }

    if (!confirm(`Delete "${a.name}"? This disconnects it and permanently removes its chat history, pairing, and settings.`)) {
      return;
    }

    const deleted = SessionManager.deleteAssistant(id);
    if (deleted) {
      closeSettings();
      showToast(`"${a.name}" deleted`, 'info');
    } else {
      showToast('Could not delete assistant', 'error');
    }
  }

  function saveSettings() {
    const id = getSettingsTargetId();
    const wsUrl = el('wsUrlInput').value.trim();
    if (!wsUrl) {
      showToast('WebSocket URL is required', 'error');
      return;
    }

    if (el('assistantNameInput')) {
      const newName = el('assistantNameInput').value.trim();
      if (newName) AssistantManager.renameAssistant(id, newName);
    }

    AssistantManager.setFlatField(id, 'wsUrl',           wsUrl);
    if (el('otaUrlInput')) {
      const otaUrl = el('otaUrlInput').value.trim();
      if (otaUrl) AssistantManager.setFlatField(id, 'otaUrl', otaUrl);
    }
    // PHASE 4: Device Name is always O.L.I.V.I.A. — not user-editable
    AssistantManager.setFlatField(id, 'deviceName', 'O.L.I.V.I.A.');
    AssistantManager.setFlatField(id, 'protocolVersion', parseInt(el('protocolVersionInput').value) || 1);
    AssistantManager.setFlatField(id, 'frameDuration',   parseInt(el('frameDurationInput').value) || 60);
    AssistantManager.setFlatField(id, 'listeningMode',   el('listeningModeInput').value);
    AssistantManager.setFlatField(id, 'audioEnabled',    el('audioEnabled').checked);
    AssistantManager.setFlatField(id, 'ttsPlayback',     el('ttsPlayback').checked);

    // Update device ID / client ID only if user entered a value
    // Normalize deviceId to lowercase to match firmware format (required by server)
    const newDeviceId = el('deviceIdInput').value.trim();
    if (newDeviceId) AssistantManager.setFlatField(id, 'deviceId', newDeviceId.toLowerCase());

    const newClientId = el('clientIdInput').value.trim();
    if (newClientId) AssistantManager.setFlatField(id, 'clientId', newClientId);

    // PHASE 4: Sidebar device name display is always "O.L.I.V.I.A."
    if (el('deviceNameDisplay')) el('deviceNameDisplay').textContent = 'O.L.I.V.I.A.';

    closeSettings();
    showToast('Settings saved', 'success');
    Logger.info('Settings updated');
  }

  function resetSettings() {
    if (!confirm('Reset all settings to defaults? This will generate new device IDs.')) return;
    AssistantManager.resetById(getSettingsTargetId());
    loadSettingsIntoForm();
    showToast('Settings reset to defaults', 'info');
    Logger.info('Settings reset');
  }

  /** Update connection status indicators */
  function setConnectionState(state, message = '') {
    // PHASE 2 CHANGE: persisting connection status onto the assistant
    // record now happens in SessionManager (which knows which assistant
    // an event belongs to, active or not, and always calls
    // AssistantManager.setConnectionStatus(id, status) so the sidebar
    // reflects every assistant's live status independently). This
    // function is now ONLY invoked by SessionManager when the event's
    // assistant IS the one currently on screen, so it stays pure DOM/UI
    // update — it no longer silently overwrites a background
    // assistant's status with the active tab's status like the old
    // AssistantManager.setActiveConnectionStatus() call used to.
    const statusDot     = el('statusDot');
    const statusText    = el('statusText');
    const connectionLabel = el('connectionLabel');
    const connectionIcon  = el('connectionIcon');
    const connectionIconOff = el('connectionIconOff');
    const stateChip     = el('deviceStateChip');
    const stateChipText = el('stateChipText');
    const stateChipIcon = el('stateChipIcon');
    const connectBtn    = el('connectBtn');
    const disconnectBtn = el('disconnectBtn');
    const chatSubtitle  = el('chatSubtitle');
    const sessionInfo   = el('sessionInfo');
    const deviceAvatar  = el('deviceAvatar');
    const inputHint     = el('inputHint');

    // Remove all state classes
    stateChip.className = 'device-state-chip';
    deviceAvatar.className = 'device-avatar';

    switch (state) {
      case 'connecting':
        statusDot.className = 'status-dot connecting';
        statusText.textContent = 'Connecting...';
        connectionLabel.textContent = 'Connecting...';
        connectionIcon.style.display = 'inline';
        connectionIconOff.style.display = 'none';
        stateChip.classList.add('connecting');
        stateChipText.textContent = 'CONNECTING';
        stateChipIcon.className = 'fas fa-circle-notch fa-spin';
        chatSubtitle.textContent = 'Powered by Olivia \u2014 Connecting...';
        connectBtn.style.display = 'none';
        disconnectBtn.style.display = 'flex';
        inputHint.textContent = 'Connecting...';
        break;

      case 'connected':
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online';
        connectionLabel.textContent = 'Connected';
        connectionIcon.style.display = 'none';
        connectionIconOff.style.display = 'none';
        stateChip.classList.add('connected');
        stateChipText.textContent = 'IDLE';
        stateChipIcon.className = 'fas fa-circle';
        chatSubtitle.textContent = 'Powered by Olivia \u2014 Connected';
        connectBtn.style.display = 'none';
        disconnectBtn.style.display = 'flex';
        deviceAvatar.classList.add('connected');
        sessionInfo.style.display = 'block';
        inputHint.textContent = 'Type a message or press the mic button to speak';
        break;

      case 'listening':
        statusDot.className = 'status-dot listening';
        statusText.textContent = 'Listening';
        stateChip.classList.add('listening');
        stateChipText.textContent = 'LISTENING';
        stateChipIcon.className = 'fas fa-microphone';
        chatSubtitle.textContent = 'Powered by Olivia \u2014 Listening';
        deviceAvatar.classList.add('listening');
        break;

      case 'speaking':
        statusDot.className = 'status-dot speaking';
        statusText.textContent = 'Speaking';
        stateChip.classList.add('speaking');
        stateChipText.textContent = 'SPEAKING';
        stateChipIcon.className = 'fas fa-volume-high';
        chatSubtitle.textContent = 'Powered by Olivia \u2014 Speaking';
        deviceAvatar.classList.add('speaking');
        break;

      case 'disconnected':
      default:
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
        connectionLabel.textContent = 'Not Connected';
        connectionIcon.style.display = 'none';
        connectionIconOff.style.display = 'inline';
        stateChip.classList.add('idle');
        stateChipText.textContent = 'IDLE';
        stateChipIcon.className = 'fas fa-circle';
        chatSubtitle.textContent = 'Powered by Olivia \u2014 Disconnected';
        connectBtn.style.display = 'flex';
        disconnectBtn.style.display = 'none';
        sessionInfo.style.display = 'none';
        inputHint.textContent = 'Connect to server to start chatting';
        break;
    }
  }

  function updateSessionId(sessionId) {
    const sessionIdDisplay = el('sessionIdDisplay');
    if (sessionIdDisplay) {
      sessionIdDisplay.textContent = sessionId || '—';
      sessionIdDisplay.title = sessionId;
    }
  }

  /** Render a chat message bubble */
  function renderMessage(msg, prevSender = null) {
    const container = el('messagesContainer');

    // Remove welcome message on first real message
    const welcomeMsg = el('welcomeMsg');
    if (welcomeMsg) welcomeMsg.remove();

    const msgEl = document.createElement('div');
    const isOutgoing = msg.sender === 'user';
    const isSystem   = msg.sender === 'system';

    if (isSystem) {
      msgEl.className = 'system-message';
      msgEl.innerHTML = `<i class="fas fa-info-circle"></i><span>${escapeHtml(msg.text)}</span>`;
      container.appendChild(msgEl);
      scrollToBottom(container);
      return msgEl;
    }

    msgEl.id = msg.id;
    msgEl.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}${msg.imageThumb ? ' has-image' : ''}`;

    const isGrouped = prevSender === msg.sender;
    if (isGrouped) {
      msgEl.classList.add('grouped-message');
    }

    // PHASE 4: Use assistant avatar image for AI messages
    const activeAssistantId = AssistantManager.getActiveId();
    const aiAvatarSrc = AvatarSystem.getAvatarDataUrl(activeAssistantId) || '/static/olivia-avatar-default.svg';
    const avatar = isOutgoing ? '' : `
      <div class="message-avatar has-avatar">
        <img class="assistant-avatar-img" src="${escapeHtml(aiAvatarSrc)}" alt="AI" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" />
      </div>
    `;

    const timeStr = msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Build image thumbnail HTML for messages that include an image
    let imageHtml = '';
    if (msg.imageThumb) {
      imageHtml = `
        <div class="message-image-thumb">
          <img src="${escapeHtml(msg.imageThumb)}" alt="${escapeHtml(msg.imageName || 'image')}" />
        </div>
      `;
    }

    // When an image thumbnail is present, wrap the caption text in its own
    // element so the bubble can shrink-wrap the image while still applying
    // proper padding around any accompanying caption text.
    const textHtml = msg.imageThumb
      ? (msg.text ? `<div class="message-caption-text">${escapeHtml(msg.text)}</div>` : '')
      : escapeHtml(msg.text);

    msgEl.innerHTML = `
      ${avatar}
      <div class="message-content">
        <div class="message-bubble">${imageHtml}${textHtml}</div>
        <div class="message-meta">
          <span class="message-time">${timeStr}</span>
          ${isOutgoing ? '<span class="message-status"><i class="fas fa-check-double"></i></span>' : ''}
        </div>
      </div>
    `;

    container.appendChild(msgEl);
    scrollToBottom(container);
    return msgEl;
  }

  /** Create a streaming AI message element (NOT yet appended to DOM).
   *  BUG #2 FIX: The element is held in memory until the first sentence arrives
   *  so we never show a blank bubble in the chat window.
   */
  function beginStreamingMessage(sender, emotion) {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${sender === 'user' ? 'outgoing' : 'incoming'} streaming`;
    msgEl.id = 'streaming_msg_' + Date.now();

    // PHASE 4: Use assistant avatar image for streaming AI messages
    const activeAssistantId = AssistantManager.getActiveId();
    const aiAvatarSrc = AvatarSystem.getAvatarDataUrl(activeAssistantId) || '/static/olivia-avatar-default.svg';
    msgEl.innerHTML = `
      <div class="message-avatar has-avatar">
        <img class="assistant-avatar-img" src="${escapeHtml(aiAvatarSrc)}" alt="AI" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" />
      </div>
      <div class="message-content">
        <div class="message-bubble"></div>
        <div class="message-meta">
          <span class="message-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
        </div>
      </div>
    `;

    // NOTE: intentionally NOT appended here — updateStreamingMessage appends it
    // on the first call so no empty bubble is ever visible.
    return msgEl;
  }

  function updateStreamingMessage(msgEl, text) {
    if (!msgEl) return;
    // BUG #2 FIX: Lazy-append — only insert into DOM when we actually have text.
    const container = el('messagesContainer');
    if (!container.contains(msgEl)) {
      container.appendChild(msgEl);
    }
    const bubble = msgEl.querySelector('.message-bubble');
    if (bubble) {
      bubble.innerHTML = escapeHtml(text) + '<span class="cursor-blink">▋</span>';
    }
    scrollToBottom(container);
  }

  function finalizeStreamingMessage(msgEl, text) {
    if (!msgEl) return;
    const bubble = msgEl.querySelector('.message-bubble');
    if (bubble) {
      bubble.textContent = text;
    }
    msgEl.classList.remove('streaming');
  }

  function showTypingIndicator(status = 'AI is thinking...') {
    const indicator = el('typingIndicator');
    const statusEl  = el('typingStatus');
    if (indicator) indicator.style.display = 'flex';
    if (statusEl)  statusEl.textContent = status;
    // PHASE 4: refresh typing indicator avatar
    try {
      const typingImg = el('typingAvatarImg');
      if (typingImg) {
        const activeId = AssistantManager.getActiveId();
        const dataUrl  = AvatarSystem.getAvatarDataUrl(activeId);
        typingImg.src = dataUrl || AvatarSystem.DEFAULT_AVATAR;
      }
    } catch(e) { /* non-fatal */ }
    scrollToBottom(el('messagesContainer'));
  }

  function hideTypingIndicator() {
    const indicator = el('typingIndicator');
    if (indicator) indicator.style.display = 'none';
  }

  function showSTTPreview(text) {
    hideSTTPreview();
    const container = el('messagesContainer');
    const preview = document.createElement('div');
    preview.id = 'stt_preview';
    preview.className = 'stt-preview';
    preview.innerHTML = `<i class="fas fa-microphone-alt"></i> "${escapeHtml(text)}"`;
    container.appendChild(preview);
    scrollToBottom(container);
  }

  function hideSTTPreview() {
    const existing = document.getElementById('stt_preview');
    if (existing) existing.remove();
  }

  function showEmotionBadge(emotion, text) {
    if (!emotion) return;
    const container = el('messagesContainer');
    const badge = document.createElement('div');
    badge.className = 'emotion-badge';
    const emojiMap = {
      happy: '😊', sad: '😢', angry: '😠', surprised: '😮',
      neutral: '😐', excited: '🎉', thinking: '🤔', confused: '😕',
    };
    const emoji = emojiMap[emotion] || '💬';
    badge.innerHTML = `<span>${emoji}</span><span>${emotion}${text ? ' — ' + escapeHtml(text) : ''}</span>`;
    container.appendChild(badge);
    scrollToBottom(container);
  }

  function clearMessages() {
    const container = el('messagesContainer');
    container.innerHTML = `
      <div class="system-message" id="welcomeMsg">
        <i class="fas fa-microchip"></i>
        <span>O.L.I.V.I.A. initialized. Click Connect to register and pair via xiaozhi.me.</span>
      </div>
    `;
  }

  function addSystemMessage(text, icon = 'fa-info-circle') {
    const container = el('messagesContainer');
    const msgEl = document.createElement('div');
    msgEl.className = 'system-message';
    msgEl.innerHTML = `<i class="fas ${icon}"></i><span>${escapeHtml(text)}</span>`;
    container.appendChild(msgEl);
    scrollToBottom(container);
    return msgEl;
  }

  function scrollToBottom(container) {
    if (!container) return;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  function hideLoadingOverlay() {
    const overlay = el('loadingOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
      setTimeout(() => overlay.remove(), 400);
    }
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') str = String(str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ================================================================
  // PHASE 1 — Multi-Assistant Sidebar & Header Rendering
  // ----------------------------------------------------------------
  // Renders the "AI Assistants" list (replacing "Recent Conversations")
  // and the chat header's active-assistant name, purely from
  // AssistantManager's stored state. Selecting an assistant ONLY
  // switches which assistant is active in the UI/state layer — it
  // never reconnects, disconnects, or triggers pairing. Those flows
  // are out of scope for this phase.
  // ================================================================

  /** Human-readable label + status-dot CSS class for a connection status */
  const ASSISTANT_STATUS_LABELS = {
    connected:    { label: 'Connected',    dot: 'online' },
    connecting:   { label: 'Connecting…',  dot: 'connecting' },
    listening:    { label: 'Listening',    dot: 'listening' },
    speaking:     { label: 'Speaking',     dot: 'speaking' },
    error:        { label: 'Error',        dot: 'error' },
    disconnected: { label: 'Not connected', dot: 'offline' },
  };

  /** Render the "AI Assistants" sidebar list from AssistantManager state */
  function renderAssistantList() {
    const container = el('assistantListItems');
    if (!container) return;

    const assistants = AssistantManager.getAllAssistants();
    const activeId = AssistantManager.getActiveId();

    container.innerHTML = assistants.map(a => {
      const statusInfo = ASSISTANT_STATUS_LABELS[a.connection.status] || ASSISTANT_STATUS_LABELS.disconnected;
      const isActive = a.id === activeId;
      // PHASE 4: Use assistant avatar image if available, fall back to default
      const avatarSrc = AvatarSystem.getAvatarDataUrl(a.id) || '/static/olivia-avatar-default.svg';
      return `
        <div class="conv-item assistant-item${isActive ? ' active' : ''}" data-assistant-id="${escapeHtml(a.id)}" role="button" tabindex="0">
          <div class="conv-avatar has-avatar assistant-avatar-clickable" data-avatar-for="${escapeHtml(a.id)}" title="Change avatar for ${escapeHtml(a.name)}">
            <img class="assistant-avatar-img" src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(a.name)} avatar" />
          </div>
          <div class="conv-meta">
            <div class="conv-name">${escapeHtml(a.name)}</div>
            <div class="conv-preview assistant-status-line">
              <span class="status-dot ${statusInfo.dot}"></span>
              ${escapeHtml(statusInfo.label)}
            </div>
          </div>
          <button class="assistant-gear-btn" type="button" title="Settings for ${escapeHtml(a.name)}" aria-label="Settings for ${escapeHtml(a.name)}">
            <i class="fas fa-gear"></i>
          </button>
        </div>
      `;
    }).join('');

    // Wire up selection — switches which assistant's chat/connection UI
    // is shown WITHOUT touching any assistant's live connection.
    // PHASE 2 CHANGE: was AssistantManager.setActive(id) directly, which
    // only flips activeId (no chat replay, no connection UI sync). Now
    // routed through SessionManager.switchTo(), which does both AND
    // guarantees the target assistant's session bundle exists.
    container.querySelectorAll('.assistant-item').forEach(item => {
      const handleSelect = () => {
        const id = item.dataset.assistantId;
        if (id === AssistantManager.getActiveId()) return;
        SessionManager.switchTo(id);
        // switchTo() -> AssistantManager.setActive() triggers onChange,
        // which re-renders both the list and the header (see init()),
        // and switchTo() itself replays chat history + syncs connection UI.
      };
      item.addEventListener('click', handleSelect);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelect(); }
      });

      // Gear icon — opens Settings scoped to THIS assistant (not
      // necessarily the active one), so users can configure a
      // background assistant without switching to it first.
      const gearBtn = item.querySelector('.assistant-gear-btn');
      if (gearBtn) {
        gearBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // don't also trigger handleSelect()
          openSettingsFor(item.dataset.assistantId);
        });
      }

      // PHASE 4: Avatar click in sidebar opens upload dialog for that assistant.
      const avatarEl = item.querySelector('.conv-avatar.assistant-avatar-clickable');
      if (avatarEl) {
        avatarEl.addEventListener('click', (e) => {
          e.stopPropagation(); // don't also trigger handleSelect()
          const targetId = avatarEl.dataset.avatarFor;
          if (targetId) AvatarSystem.openUploadDialog(targetId);
        });
      }
    });
  }

  /**
   * Sync the chat header title to the active assistant's Assistant Name.
   * NOTE: this is deliberately distinct from #deviceNameDisplay in the
   * sidebar profile card, which shows the active assistant's ESP32
   * "Device Name" (already kept in sync per-assistant automatically via
   * the SettingsManager shim over AssistantManager — see
   * AppController.init() and saveSettings()). Assistant Name and Device
   * Name are two separate fields on the Assistant model.
   */
  function renderActiveAssistantHeader() {
    const active = AssistantManager.getActiveAssistant();
    if (!active) return;

    const headerName = el('activeAssistantName');
    if (headerName) headerName.textContent = active.name;

    // PHASE 4: Sidebar always shows "O.L.I.V.I.A." — the website identity.
    // Device Name concept is hidden from UI entirely.
    const sidebarDeviceName = el('deviceNameDisplay');
    if (sidebarDeviceName) sidebarDeviceName.textContent = 'O.L.I.V.I.A.';

    // PHASE 4: Update chat header avatar and sidebar avatar for active assistant.
    AvatarSystem.refreshAllAvatarDisplays();

    // OLIVIA FEATURE: keep the volume slider/icon in sync with whichever
    // assistant is active (covers onChange firing from rename/status
    // updates, not just an explicit switchTo()). Idempotent + cheap.
    try { VolumeSystem.refreshActiveVolume(); } catch (e) { /* non-fatal */ }
  }

  return {
    init,
    setConnectionState,
    updateSessionId,
    renderMessage,
    beginStreamingMessage,
    updateStreamingMessage,
    finalizeStreamingMessage,
    showTypingIndicator,
    hideTypingIndicator,
    showSTTPreview,
    hideSTTPreview,
    showEmotionBadge,
    clearMessages,
    addSystemMessage,
    hideLoadingOverlay,
    updateMicButtonState,
    showPairingModal,
    hidePairingModal,
    updatePairingStatus,
    updatePairingStatusDisplay,
    renderAssistantList,
    renderActiveAssistantHeader,
    // PHASE 4: expose the current settings target id for AvatarSystem
    getSettingsTargetIdPublic: () => getSettingsTargetId(),
  };
})();

// ================================================================
// GLOBAL: Toast notification
// ================================================================
function showToast(message, type = 'info', title = null, duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const icons = {
    info:    'fa-circle-info',
    success: 'fa-circle-check',
    error:   'fa-circle-xmark',
    warning: 'fa-triangle-exclamation',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fas ${icons[type] || icons.info} toast-icon"></i>
    <div class="toast-body">
      ${title ? `<div class="toast-title">${title}</div>` : ''}
      <div class="toast-desc">${message}</div>
    </div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ================================================================
// MODULE: ImageInput
// Manages the + button, camera, photo gallery, and image attachment.
//
// Architecture mirrors the official Esp32Camera firmware:
//   1. User selects image (camera or gallery)
//   2. Image is previewed — NOT sent yet
//   3. User optionally types a question
//   4. On Send: ImageFile + question → ChatEngine.sendImageMessage()
//      which POSTs multipart to /api/vision/explain (proxy)
//      parses the JSON response, extracts the .text field,
//      builds a single conversational prompt, and sends it via
//      the standard sendTextMessage chunked-detect path
// ================================================================
const ImageInput = (() => {

  // ── State ────────────────────────────────────────────────────────
  let pendingAttachment = null;  // { blob, name, dataUrl }
  let cameraStream      = null;
  let facingMode        = 'environment';  // 'user' = front, 'environment' = rear

  // ── Helper ───────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  // ── Init — wire up all DOM events ────────────────────────────────
  function init() {
    const plusBtn          = el('plusBtn');
    const plusPopup        = el('plusPopup');
    const menuCameraBtn    = el('menuCameraBtn');
    const menuPhotosBtn    = el('menuPhotosBtn');
    const galleryFileInput = el('galleryFileInput');
    const attachRemoveBtn  = el('attachmentRemoveBtn');
    const cameraCaptureBtn = el('cameraCaptureBtn');
    const cameraRetakeBtn  = el('cameraRetakeBtn');
    const cameraUsephotoBtn = el('cameraUsephotoBtn');
    const cameraSwitchBtn  = el('cameraSwitchBtn');
    const cameraCloseBtn   = el('cameraCloseBtn');
    const cameraModalOverlay = el('cameraModalOverlay');

    if (!plusBtn) return;  // Elements not in DOM yet — skip

    // ── Plus button toggles popup ──────────────────────────────────
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = el('plusPopup');
      const isOpen = popup.style.display !== 'none';
      if (isOpen) closePopup();
      else openPopup();
    });

    // ── Close popup when clicking outside ─────────────────────────
    document.addEventListener('click', (e) => {
      const wrapper = el('plusBtnWrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        closePopup();
      }
    });

    // ── Camera option ─────────────────────────────────────────────
    if (menuCameraBtn) {
      menuCameraBtn.addEventListener('click', () => {
        closePopup();
        openCamera();
      });
    }

    // ── Photos / Gallery option ───────────────────────────────────
    if (menuPhotosBtn) {
      menuPhotosBtn.addEventListener('click', () => {
        closePopup();
        galleryFileInput && galleryFileInput.click();
      });
    }

    // ── Gallery file selected ─────────────────────────────────────
    if (galleryFileInput) {
      galleryFileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        galleryFileInput.value = '';  // Reset so same file can be re-selected
        setAttachmentFromFile(file);
      });
    }

    // ── Remove attachment ─────────────────────────────────────────
    if (attachRemoveBtn) {
      attachRemoveBtn.addEventListener('click', () => {
        clearAttachment();
      });
    }

    // ── Camera: Capture button ────────────────────────────────────
    if (cameraCaptureBtn) {
      cameraCaptureBtn.addEventListener('click', capturePhoto);
    }

    // ── Camera: Retake ────────────────────────────────────────────
    if (cameraRetakeBtn) {
      cameraRetakeBtn.addEventListener('click', () => {
        showCameraViewfinder();
      });
    }

    // ── Camera: Use photo ─────────────────────────────────────────
    if (cameraUsephotoBtn) {
      cameraUsephotoBtn.addEventListener('click', () => {
        useCapturedPhoto();
      });
    }

    // ── Camera: Switch front/rear ─────────────────────────────────
    if (cameraSwitchBtn) {
      cameraSwitchBtn.addEventListener('click', () => {
        facingMode = (facingMode === 'environment') ? 'user' : 'environment';
        restartCamera();
      });
    }

    // ── Camera: Close modal ───────────────────────────────────────
    if (cameraCloseBtn) {
      cameraCloseBtn.addEventListener('click', closeCamera);
    }
    if (cameraModalOverlay) {
      cameraModalOverlay.addEventListener('click', closeCamera);
    }
  }

  // ── Plus popup ───────────────────────────────────────────────────
  function openPopup() {
    const popup = el('plusPopup');
    if (popup) popup.style.display = 'block';
  }

  function closePopup() {
    const popup = el('plusPopup');
    if (popup) popup.style.display = 'none';
  }

  // ── Image attachment ─────────────────────────────────────────────
  /**
   * Show the attachment preview bar above the text input.
   * @param {Blob}   blob    - The image blob
   * @param {string} name    - Display filename
   * @param {string} dataUrl - Data URL for <img> thumbnail
   */
  function setAttachment(blob, name, dataUrl) {
    pendingAttachment = { blob, name, dataUrl };

    const bar       = el('imageAttachmentBar');
    const thumb     = el('attachmentThumb');
    const nameEl    = el('attachmentName');

    if (bar)    bar.style.display    = 'block';
    if (thumb)  thumb.src            = dataUrl;
    if (nameEl) nameEl.textContent   = name;
  }

  function clearAttachment() {
    pendingAttachment = null;

    const bar = el('imageAttachmentBar');
    if (bar) bar.style.display = 'none';

    const thumb  = el('attachmentThumb');
    const nameEl = el('attachmentName');
    if (thumb)  thumb.src          = '';
    if (nameEl) nameEl.textContent = '';
  }

  function getAttachment() {
    return pendingAttachment;
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function setAttachmentFromFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      setAttachment(file, file.name || 'photo.jpg', ev.target.result);
    };
    reader.readAsDataURL(file);
  }

  // ── Camera ───────────────────────────────────────────────────────
  async function openCamera() {
    const modal = el('cameraModal');
    if (!modal) return;

    modal.style.display = 'flex';
    showCameraViewfinder();
    await startCamera();
  }

  async function startCamera() {
    try {
      if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
      }

      const constraints = {
        video: {
          facingMode,
          width:  { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      const video = el('cameraVideo');
      if (video) {
        video.srcObject = cameraStream;
      }

      // Show switch button only if multiple cameras available
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter(d => d.kind === 'videoinput');
        const switchBtn = el('cameraSwitchBtn');
        if (switchBtn) {
          switchBtn.style.display = cameras.length > 1 ? 'flex' : 'none';
        }
      } catch { /* ignore */ }

    } catch (err) {
      Logger.error('Camera access failed', err.message);
      closeCamera();
      showToast('Camera access denied or unavailable.', 'error');
    }
  }

  async function restartCamera() {
    await startCamera();
  }

  function closeCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }

    const video = el('cameraVideo');
    if (video) {
      video.srcObject = null;
    }

    const modal = el('cameraModal');
    if (modal) modal.style.display = 'none';

    showCameraViewfinder();  // Reset to viewfinder for next time
  }

  function capturePhoto() {
    const video  = el('cameraVideo');
    const canvas = el('cameraCanvas');
    if (!video || !canvas) return;

    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);

    // Show preview
    const previewImg = el('cameraPreviewImg');
    if (previewImg) previewImg.src = dataUrl;

    showCameraPreview();
  }

  function useCapturedPhoto() {
    const canvas = el('cameraCanvas');
    if (!canvas) { closeCamera(); return; }

    canvas.toBlob((blob) => {
      if (!blob) { closeCamera(); return; }
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      setAttachment(blob, 'Camera Photo.jpg', dataUrl);
      closeCamera();
    }, 'image/jpeg', 0.9);
  }

  function showCameraViewfinder() {
    const viewfinder = el('cameraViewfinder');
    const preview    = el('cameraPreview');
    if (viewfinder) viewfinder.style.display = 'flex';
    if (preview)    preview.style.display    = 'none';
  }

  function showCameraPreview() {
    const viewfinder = el('cameraViewfinder');
    const preview    = el('cameraPreview');
    if (viewfinder) viewfinder.style.display = 'none';
    if (preview)    preview.style.display    = 'flex';
  }

  /**
   * Return just the pending blob (used by the MCP tools/call handler to fetch
   * the image the user has attached but not yet sent).
   * Returns null if no image is attached.
   *
   * Official firmware reference: mcp_server.cc line 115 — camera->Capture()
   * is called synchronously before Explain().  In the browser the user has
   * already "captured" by selecting from camera/gallery, so the blob is the
   * equivalent of a captured camera frame.
   */
  function getPendingBlob() {
    return pendingAttachment ? pendingAttachment.blob : null;
  }

  /**
   * Store a blob reference for use by the MCP tools/call handler.
   * Called by ChatEngine.sendImageMessage() after the UI attachment has
   * already been cleared (the user clicked Send).
   *
   * The blob must remain available until the server issues a tools/call
   * for self.camera.take_photo.  This function keeps it alive without
   * re-showing the attachment bar UI.
   *
   * Official firmware reference: Esp32Camera maintains current_fb_ (the
   * captured frame buffer) as a member variable, keeping it alive between
   * Capture() and Explain().  This mirrors that pattern in browser-land.
   */
  function _storePendingBlobForToolCall(blob) {
    if (blob) {
      // Preserve any existing name/dataUrl but update the blob
      if (pendingAttachment) {
        pendingAttachment.blob = blob;
      } else {
        pendingAttachment = { blob, name: 'photo.jpg', dataUrl: null };
      }
      Logger.vision(`Blob stored for tools/call: ${blob.size} bytes`);
    }
  }

  return {
    init,
    openPopup,
    closePopup,
    getAttachment,
    clearAttachment,
    getPendingBlob,
    _storePendingBlobForToolCall,
  };
})();

// ================================================================
// ================================================================
// MODULE: ThemeManager
// Manages light/dark theme preference independently of system setting.
// Persists to localStorage so choice survives page reload.
// Applies via data-theme attribute on <html> element, which overrides
// the @media (prefers-color-scheme) rule in style.css.
// ================================================================
const ThemeManager = (() => {
  const STORAGE_KEY = 'olivia_theme_preference';
  const DARK  = 'dark';
  const LIGHT = 'light';

  /** Returns the currently effective theme: 'dark' or 'light'. */
  function getCurrent() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === DARK || stored === LIGHT) return stored;
    // Fall back to system preference
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? DARK : LIGHT;
  }

  /** Apply the given theme to the document. */
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Update the toggle button icon title
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.title = theme === DARK ? 'Switch to light theme' : 'Switch to dark theme';
    }
  }

  /** Toggle between dark and light, persist the choice. */
  function toggle() {
    const next = getCurrent() === DARK ? LIGHT : DARK;
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  }

  /** Initialize: apply saved/system preference and wire toggle button. */
  function init() {
    apply(getCurrent());
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.addEventListener('click', toggle);
  }

  return { init, toggle, getCurrent };
})();

// MODULE: AppController
// Coordinates all modules. Entry point for user actions.
// ================================================================
const AppController = (() => {

  /**
   * Initialize the application.
   * ------------------------------------------------------------------
   * PHASE 2 CHANGE: AppController no longer owns any protocol/device
   * wiring or connect/disconnect logic — all of that moved into
   * SessionManager, which builds one full, independent session bundle
   * PER ASSISTANT ({deviceEmulator, provisioning, vision, protocol,
   * chat}) instead of the old single set of global singletons.
   * AppController.init() now just boots AssistantManager + UIController,
   * then hands off to SessionManager.initAll() to build every persisted
   * assistant's session and render the active one.
   */
  async function init() {
    Logger.boot('Initializing virtual device...');

    // Apply saved theme preference before rendering anything
    ThemeManager.init();

    // Load all persisted assistants (was: SettingsManager.load(), which
    // is itself now just a thin shim over AssistantManager.load()).
    AssistantManager.load();

    // PHASE 4: Sidebar always shows "O.L.I.V.I.A." — not the device name field
    const deviceNameDisplay = document.getElementById('deviceNameDisplay');
    if (deviceNameDisplay) {
      deviceNameDisplay.textContent = 'O.L.I.V.I.A.';
    }

    // Initialize UI (renders sidebar/header, wires all button handlers)
    UIController.init();

    // Build a full session bundle for every persisted assistant, and
    // render the active assistant's chat history + connection state.
    SessionManager.initAll();

    // Check microphone availability
    const micPerm = await AudioEngine.checkMicPermission();
    if (micPerm.state === 'denied') {
      Logger.warn('Microphone permission denied');
      showToast('Microphone access denied. Text mode only.', 'warning');
    } else if (micPerm.state === 'unavailable') {
      Logger.warn('getUserMedia not available');
      document.getElementById('micBtn').disabled = true;
    }

    // Pre-warm libopus-wasm in background (don't block init)
    AudioEngine.loadOpus().then(() => {
      Logger.boot('Opus WASM engine ready — real Opus encoding available');
    }).catch(err => {
      Logger.warn('Opus WASM pre-load failed (will retry on use)', err.message);
    });

    // Hide loading overlay
    setTimeout(() => {
      UIController.hideLoadingOverlay();
      Logger.boot('Virtual device ready');
      Logger.boot(`Active assistant Device-Id: ${AssistantManager.getActiveFlatField('deviceId')}`);
      Logger.boot(`Active assistant Client-Id: ${AssistantManager.getActiveFlatField('clientId')}`);
      Logger.boot(`Active assistant WS URL: ${AssistantManager.getActiveFlatField('wsUrl')}`);
      Logger.boot('Text mode: listen{detect} protocol (correct server bypass)');
      Logger.boot('Voice mode: real Opus encoding @ 16kHz mono 60ms frames');
    }, 800);
  }

  /** User clicks Connect button — always targets the active assistant. */
  async function connect() {
    await SessionManager.connectAssistant(AssistantManager.getActiveId());
  }

  /** User clicks Disconnect button — always targets the active assistant. */
  function disconnect() {
    SessionManager.disconnectAssistant(AssistantManager.getActiveId());
  }

  return { init, connect, disconnect };
})();


// ================================================================
// APPLICATION ENTRY POINT
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Small delay to let CSS animations settle
  setTimeout(() => {
    AppController.init().catch(err => {
      console.error('[BOOT] Critical initialization error:', err);
    });
  }, 100);
});

// Handle page unload - clean disconnect
// PHASE 2 CHANGE: disconnect EVERY assistant's live session on unload,
// not just "the" singleton connection — each assistant's ProtocolClient
// instance is an independent WebSocket that needs its own clean close.
window.addEventListener('beforeunload', () => {
  AssistantManager.getAllAssistants().forEach(a => {
    const session = SessionManager.getSession(a.id);
    if (session && session.protocol.isConnected()) {
      session.protocol.disconnect();
    }
  });
});

// Expose to browser console for debugging.
// PHASE 2 CHANGE: ProtocolClient/ProvisioningManager/DeviceEmulator/
// VisionCapability/ChatEngine are now factories with no single instance —
// `protocol`/`chat`/`device`/`provisioning` below always resolve to the
// CURRENTLY ACTIVE assistant's session bundle at call-time (via getters),
// so `XiaozhiDebug.protocol.isConnected()` still works exactly as before
// for whichever assistant is on screen when you call it.
window.XiaozhiDebug = {
  sessionManager: SessionManager,
  assistants:     AssistantManager,
  settings:       SettingsManager,
  audio:          AudioEngine,
  ui:             UIController,
  app:            AppController,
  theme:          ThemeManager,
  logger:         Logger,
  get protocol()     { return SessionManager.getActiveSession()?.protocol; },
  get provisioning() { return SessionManager.getActiveSession()?.provisioning; },
  get device()       { return SessionManager.getActiveSession()?.deviceEmulator; },
  get chat()         { return SessionManager.getActiveSession()?.chat; },
  quickTest: async (message) => {
    await AppController.connect();
    if (message) {
      setTimeout(() => SessionManager.getActiveSession()?.chat.sendTextMessage(message), 2000);
    }
  },
  // Direct protocol test — bypasses ChatEngine UI. Targets active assistant.
  sendDetect: (text) => SessionManager.getActiveSession()?.protocol.sendListenDetect(text),
  // Check opus status
  opusStatus: () => AudioEngine.loadOpus().then(m => ({ loaded: true, version: m.version })).catch(e => ({ loaded: false, error: e.message })),
};

console.log('%c[Xiaozhi Web Client]', 'color: #0084ff; font-weight: bold; font-size: 14px;',
  '\nVirtual ESP32 device loaded. Use XiaozhiDebug in console for debugging.');
console.log('%c Usage: XiaozhiDebug.quickTest("Hello!")',
  'color: #22c55e; font-size: 12px;');
