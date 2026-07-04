/**
 * ============================================================
 * Xiaozhi ESP32 Web Client - Hono Backend
 * ============================================================
 * This serves the complete HTML/CSS/JS web application that
 * emulates an ESP32 device connecting to a Xiaozhi server.
 *
 * Architecture:
 *  - Hono serves static files and the main HTML shell
 *  - All ESP32 protocol logic runs in the browser (JS)
 *  - WebSocket auth headers are injected by /api/ws proxy (browser cannot set them)
 *  - Audio via WebAudio API + PCM-to-Opus (libopus WASM) if available
 * ============================================================
 */

import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { cors } from 'hono/cors'

const app = new Hono()

// Enable CORS for any API routes
app.use('/api/*', cors())

/** Allowed OTA hostnames (mirrors official Xiaozhi ESP32 firmware endpoints) */
const ALLOWED_OTA_HOSTS = new Set([
  'api.tenclass.net',
  'xiaozhi.me',
  'www.xiaozhi.me',
  'api.xiaozhi.me',
])

function isAllowedOtaUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_OTA_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

function buildOtaHeaders(deviceId: string, clientId: string): Record<string, string> {
  return {
    'Activation-Version': '1',
    'Device-Id': deviceId,
    'Client-Id': clientId,
    'User-Agent': 'xiaozhi-web-client/1.0.0',
    'Accept-Language': 'en-US',
    'Content-Type': 'application/json',
  }
}

function isAllowedWsUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'wss:') return false
    return ALLOWED_OTA_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/** Match ESP32 WebsocketProtocol::OpenAudioChannel() Bearer prefix logic */
function formatBearerToken(token: string): string {
  return token.includes(' ') ? token : `Bearer ${token}`
}

/**
 * WebSocket proxy — injects auth headers the browser cannot set.
 * Mirrors xiaozhi-web-client/proxy.py extra_headers on upstream connect.
 *
 * CRITICAL CLOUDFLARE WORKERS NOTES:
 * 1. fetch() for WS upgrade MUST use https:// URL, NOT wss://
 *    The Workers runtime handles the protocol upgrade internally.
 *    Passing wss:// to fetch() results in webSocket being null.
 *
 * 2. Binary frames arrive as Blob (not ArrayBuffer) on compat dates >= 2026-03-17.
 *    We must set upstream.binaryType = 'arraybuffer' BEFORE accept() to ensure
 *    binary audio frames (Opus) are forwarded correctly to the browser.
 *
 * 3. allowHalfOpen: true is required on accept() for both sockets when proxying,
 *    so we can coordinate close frames between both sides independently.
 */
app.get('/api/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426)
  }

  const targetUrl = c.req.query('url')?.trim() ?? ''
  const deviceId = c.req.query('device_id')?.trim() ?? ''
  const clientId = c.req.query('client_id')?.trim() ?? ''
  const token = c.req.query('token')?.trim() ?? ''
  const protocolVersion = c.req.query('protocol_version')?.trim() || '1'

  if (!targetUrl || !deviceId || !clientId || !token) {
    return c.text('url, device_id, client_id, and token are required', 400)
  }
  if (!isAllowedWsUrl(targetUrl)) {
    return c.text('WebSocket URL host is not allowed', 400)
  }

  // Convert wss:// → https:// for Cloudflare Workers fetch-based WebSocket client.
  // The Workers runtime REQUIRES https:// when using fetch() to initiate a WS upgrade.
  // Passing wss:// causes the webSocket property on the response to be null/undefined.
  const fetchUrl = targetUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')

  const pair = new WebSocketPair()
  const browserSocket = pair[0]
  const localSocket = pair[1]
  // allowHalfOpen: true — needed for proxying so we coordinate close on both ends
  localSocket.accept({ allowHalfOpen: true })

  const pending: (string | ArrayBuffer | Blob)[] = []
  let upstream: WebSocket | null = null
  let upstreamClosed = false
  let localClosed = false

  const flushPending = async () => {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return
    for (const message of pending) {
      if (message instanceof Blob) {
        // Convert Blob → ArrayBuffer before forwarding to preserve binary integrity
        upstream.send(await message.arrayBuffer())
      } else {
        upstream.send(message)
      }
    }
    pending.length = 0
  }

  const closeLocal = (code = 1011, reason = 'Upstream connection closed') => {
    if (localClosed) return
    localClosed = true
    try {
      localSocket.close(code, reason)
    } catch {
      /* already closed */
    }
  }

  const closeUpstream = (code = 1000, reason = 'Client disconnected') => {
    if (upstreamClosed || !upstream) return
    upstreamClosed = true
    try {
      upstream.close(code, reason)
    } catch {
      /* already closed */
    }
  }

  localSocket.addEventListener('message', async (event) => {
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      if (event.data instanceof Blob) {
        // Convert Blob → ArrayBuffer so audio frames are passed correctly
        upstream.send(await event.data.arrayBuffer())
      } else {
        upstream.send(event.data)
      }
    } else {
      pending.push(event.data)
    }
  })

  localSocket.addEventListener('close', (event) => {
    closeUpstream(event.code || 1000, event.reason || 'Client disconnected')
  })

  ;(async () => {
    try {
      // IMPORTANT: Use https:// (not wss://) for Cloudflare Workers fetch WebSocket upgrade
      const upstreamResponse = await fetch(fetchUrl, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Authorization: formatBearerToken(token),
          'Protocol-Version': protocolVersion,
          'Device-Id': deviceId,
          'Client-Id': clientId,
        },
      })

      const upstreamSocket = upstreamResponse.webSocket
      if (!upstreamSocket) {
        // Log the response status to aid debugging
        const statusHint = `HTTP ${upstreamResponse.status} — webSocket property is null`
        closeLocal(1011, `Upstream WebSocket upgrade failed (${statusHint})`)
        return
      }

      upstream = upstreamSocket

      // CRITICAL: Set binaryType to 'arraybuffer' BEFORE accept().
      // On compat dates >= 2026-03-17 the default is 'blob'.
      // We need ArrayBuffer so binary Opus audio frames can be forwarded as-is.
      upstream.binaryType = 'arraybuffer'

      // allowHalfOpen: true — coordinate close frames independently on both sides
      upstream.accept({ allowHalfOpen: true })

      await flushPending()

      upstream.addEventListener('message', async (event) => {
        if (localSocket.readyState === WebSocket.OPEN) {
          if (event.data instanceof Blob) {
            localSocket.send(await event.data.arrayBuffer())
          } else {
            localSocket.send(event.data)
          }
        }
      })

      upstream.addEventListener('close', (event) => {
        closeLocal(event.code || 1000, event.reason || 'Upstream closed')
      })

      upstream.addEventListener('error', (event) => {
        closeLocal(1011, 'Upstream WebSocket error')
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      closeLocal(1011, `Failed to connect upstream: ${msg}`)
    }
  })()

  return new Response(null, { status: 101, webSocket: browserSocket })
})

/** Proxy OTA version check — same POST the ESP32 sends on boot */
app.post('/api/ota/check', async (c) => {
  const body = await c.req.json<{
    otaUrl?: string
    deviceId?: string
    clientId?: string
    payload?: Record<string, unknown>
  }>()

  const otaUrl = body.otaUrl?.trim()
  const deviceId = body.deviceId?.trim()
  const clientId = body.clientId?.trim()

  if (!otaUrl || !deviceId || !clientId) {
    return c.json({ error: 'otaUrl, deviceId, and clientId are required' }, 400)
  }
  if (!isAllowedOtaUrl(otaUrl)) {
    return c.json({ error: 'OTA URL host is not allowed' }, 400)
  }

  const upstream = await fetch(otaUrl, {
    method: 'POST',
    headers: buildOtaHeaders(deviceId, clientId),
    body: JSON.stringify(body.payload ?? {}),
  })

  const text = await upstream.text()
  let data: unknown = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }

  return c.json(data, upstream.status as 200)
})

/** Proxy OTA activate polling — POST {otaUrl}/activate like ESP32 firmware */
app.post('/api/ota/activate', async (c) => {
  const body = await c.req.json<{
    otaUrl?: string
    deviceId?: string
    clientId?: string
    payload?: Record<string, unknown>
  }>()

  const otaUrl = body.otaUrl?.trim()
  const deviceId = body.deviceId?.trim()
  const clientId = body.clientId?.trim()

  if (!otaUrl || !deviceId || !clientId) {
    return c.json({ error: 'otaUrl, deviceId, and clientId are required' }, 400)
  }
  if (!isAllowedOtaUrl(otaUrl)) {
    return c.json({ error: 'OTA URL host is not allowed' }, 400)
  }

  const activateUrl = otaUrl.endsWith('/') ? `${otaUrl}activate` : `${otaUrl}/activate`

  const upstream = await fetch(activateUrl, {
    method: 'POST',
    headers: buildOtaHeaders(deviceId, clientId),
    body: JSON.stringify(body.payload ?? {}),
  })

  const text = await upstream.text()
  let data: unknown = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }

  return c.json(data, upstream.status as 200)
})

// Serve static assets (JS, CSS, audio worklets, etc.)
app.use('/static/*', serveStatic({ root: './public' }))

// Serve favicon inline
app.get('/favicon.svg', (c) => {
  return c.body(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0084ff"/><text x="32" y="46" font-size="36" text-anchor="middle" fill="white">⚙</text></svg>`,
    200,
    { 'Content-Type': 'image/svg+xml' }
  )
})

// ── Main application HTML ────────────────────────────────────────────────────
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>Xiaozhi Virtual Device — Web Client</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />

  <!-- Icons -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.1/css/all.min.css" />

  <!-- Our CSS -->
  <link rel="stylesheet" href="/static/style.css" />
</head>
<body>

<!-- ╔══════════════════════════════════════════════════════════╗
     ║              APP ROOT CONTAINER                         ║
     ╚══════════════════════════════════════════════════════════╝ -->
<div id="app" class="app-container">

  <!-- ── LEFT SIDEBAR ─────────────────────────────────────── -->
  <aside class="sidebar" id="sidebar">

    <!-- Profile / Device Section -->
    <div class="sidebar-header">
      <div class="device-avatar" id="deviceAvatar">
        <i class="fas fa-microchip"></i>
      </div>
      <div class="device-info">
        <h3 class="device-name" id="deviceNameDisplay">Virtual ESP32</h3>
        <div class="device-status" id="deviceStatusBadge">
          <span class="status-dot offline" id="statusDot"></span>
          <span id="statusText">Offline</span>
        </div>
      </div>
      <button class="sidebar-settings-btn" id="settingsToggleBtn" title="Settings">
        <i class="fas fa-cog"></i>
      </button>
    </div>

    <!-- Navigation Tabs -->
    <div class="sidebar-tabs">
      <button class="tab-btn active" data-tab="chat">
        <i class="fas fa-comment-dots"></i>
        <span>Chat</span>
      </button>
      <button class="tab-btn" data-tab="debug">
        <i class="fas fa-terminal"></i>
        <span>Debug</span>
      </button>
      <button class="tab-btn" data-tab="info">
        <i class="fas fa-info-circle"></i>
        <span>Info</span>
      </button>
    </div>

    <!-- Connection Status Card -->
    <div class="connection-card" id="connectionCard">
      <div class="connection-state" id="connectionState">
        <i class="fas fa-circle-notch fa-spin" id="connectionIcon" style="display:none;"></i>
        <i class="fas fa-plug-circle-xmark" id="connectionIconOff"></i>
        <span id="connectionLabel">Not Connected</span>
      </div>
      <div class="session-info" id="sessionInfo" style="display:none;">
        <small>Session: <code id="sessionIdDisplay">—</code></small>
      </div>
    </div>

    <!-- Conversation List -->
    <div class="conversation-list" id="conversationList">
      <div class="conv-list-header">Recent Conversations</div>
      <div class="conv-item active">
        <div class="conv-avatar"><i class="fas fa-robot"></i></div>
        <div class="conv-meta">
          <div class="conv-name">Xiaozhi AI</div>
          <div class="conv-preview" id="convPreview">Start a conversation...</div>
        </div>
        <div class="conv-time" id="convTime">Now</div>
      </div>
    </div>

    <!-- Audio Level Meter -->
    <div class="audio-meter-section" id="audioMeterSection" style="display:none;">
      <div class="audio-meter-label"><i class="fas fa-microphone"></i> Input Level</div>
      <div class="audio-meter-bar">
        <div class="audio-meter-fill" id="audioMeterFill"></div>
      </div>
    </div>

  </aside>

  <!-- ── SETTINGS PANEL (slides in) ──────────────────────── -->
  <div class="settings-panel" id="settingsPanel">
    <div class="settings-header">
      <h2><i class="fas fa-cog"></i> Device Settings</h2>
      <button class="close-settings-btn" id="closeSettingsBtn"><i class="fas fa-times"></i></button>
    </div>
    <div class="settings-body">

      <div class="settings-section">
        <h3>Connection</h3>
        <div class="form-group">
          <label for="wsUrlInput">WebSocket URL</label>
          <input type="text" id="wsUrlInput" placeholder="wss://api.xiaozhi.me/xiaozhi/v1/"
                 value="wss://api.xiaozhi.me/xiaozhi/v1/" />
          <small>Official server: wss://api.xiaozhi.me/xiaozhi/v1/</small>
        </div>
        <div class="form-group">
          <label for="otaUrlInput">OTA / Provisioning URL</label>
          <input type="text" id="otaUrlInput" placeholder="https://api.tenclass.net/xiaozhi/ota/"
                 value="https://api.tenclass.net/xiaozhi/ota/" />
          <small>Device registration endpoint (same as ESP32 firmware)</small>
        </div>
        <div class="form-group">
          <label>Pairing Status</label>
          <div class="pairing-status-display" id="pairingStatusDisplay">Not paired</div>
          <small>Devices pair automatically via 6-digit code at xiaozhi.me</small>
        </div>
        <div class="form-group">
          <button class="btn-secondary btn-block" type="button" id="resetPairingBtn">
            <i class="fas fa-unlink"></i> Reset Pairing
          </button>
        </div>
      </div>

      <div class="settings-section">
        <h3>Virtual Device Identity</h3>
        <div class="form-group">
          <label for="deviceNameInput">Device Name</label>
          <input type="text" id="deviceNameInput" placeholder="My Virtual ESP32" value="My Virtual ESP32" />
        </div>
        <div class="form-group">
          <label for="deviceIdInput">Device-Id (MAC Address)</label>
          <input type="text" id="deviceIdInput" placeholder="Auto-generated" />
          <small>Leave blank to auto-generate persistent MAC-style ID</small>
        </div>
        <div class="form-group">
          <label for="clientIdInput">Client-Id (UUID)</label>
          <input type="text" id="clientIdInput" placeholder="Auto-generated UUID" />
          <small>Leave blank to auto-generate persistent UUID</small>
        </div>
      </div>

      <div class="settings-section">
        <h3>Protocol Settings</h3>
        <div class="form-group">
          <label for="protocolVersionInput">Protocol Version</label>
          <select id="protocolVersionInput">
            <option value="1" selected>Version 1 (Raw Opus)</option>
            <option value="2">Version 2 (Timestamped)</option>
            <option value="3">Version 3 (Lightweight Header)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="frameDurationInput">Frame Duration (ms)</label>
          <select id="frameDurationInput">
            <option value="20">20ms (Low Latency)</option>
            <option value="40">40ms</option>
            <option value="60" selected>60ms (Standard)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="listeningModeInput">Listening Mode</label>
          <select id="listeningModeInput">
            <option value="auto" selected>Auto (VAD stop)</option>
            <option value="manual">Manual</option>
            <option value="realtime">Realtime</option>
          </select>
        </div>
      </div>

      <div class="settings-section">
        <h3>Audio</h3>
        <div class="form-group checkbox-group">
          <label>
            <input type="checkbox" id="audioEnabled" checked />
            <span>Enable Microphone (voice mode)</span>
          </label>
        </div>
        <div class="form-group checkbox-group">
          <label>
            <input type="checkbox" id="ttsPlayback" checked />
            <span>Play TTS audio from server</span>
          </label>
        </div>
      </div>

      <div class="settings-actions">
        <button class="btn-primary" id="saveSettingsBtn">
          <i class="fas fa-save"></i> Save Settings
        </button>
        <button class="btn-secondary" id="resetSettingsBtn">
          <i class="fas fa-rotate-left"></i> Reset to Defaults
        </button>
      </div>

    </div>
  </div>

  <!-- ── MAIN CHAT AREA ────────────────────────────────────── -->
  <main class="chat-area">

    <!-- Top Bar -->
    <header class="chat-header">
      <button class="sidebar-toggle-mobile" id="sidebarToggleMobile">
        <i class="fas fa-bars"></i>
      </button>
      <div class="chat-header-info">
        <div class="chat-avatar"><i class="fas fa-robot"></i></div>
        <div class="chat-title-block">
          <h2>Xiaozhi AI</h2>
          <div class="chat-subtitle" id="chatSubtitle">Virtual ESP32 Device</div>
        </div>
      </div>
      <div class="chat-header-actions">
        <div class="device-state-chip" id="deviceStateChip">
          <i class="fas fa-circle" id="stateChipIcon"></i>
          <span id="stateChipText">IDLE</span>
        </div>
        <button class="action-btn" id="connectBtn" title="Connect to server">
          <i class="fas fa-plug"></i>
        </button>
        <button class="action-btn" id="disconnectBtn" title="Disconnect" style="display:none;">
          <i class="fas fa-plug-circle-xmark"></i>
        </button>
        <button class="action-btn danger" id="clearChatBtn" title="Clear chat">
          <i class="fas fa-trash-alt"></i>
        </button>
      </div>
    </header>

    <!-- Messages Container -->
    <div class="messages-container" id="messagesContainer">

      <!-- System welcome message -->
      <div class="system-message" id="welcomeMsg">
        <i class="fas fa-microchip"></i>
        <span>Virtual ESP32 device initialized. Click Connect to register and pair via xiaozhi.me.</span>
      </div>

    </div>

    <!-- Typing Indicator (shown when AI is generating) -->
    <div class="typing-indicator" id="typingIndicator" style="display:none;">
      <div class="typing-avatar"><i class="fas fa-robot"></i></div>
      <div class="typing-bubble">
        <div class="typing-dots">
          <span></span><span></span><span></span>
        </div>
        <div class="typing-status" id="typingStatus">AI is thinking...</div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="input-area">
      <div class="input-toolbar">
        <!-- Voice button -->
        <button class="toolbar-btn mic-btn" id="micBtn" title="Hold to speak / Click to toggle">
          <i class="fas fa-microphone" id="micIcon"></i>
        </button>
        <!-- Text input -->
        <div class="input-wrapper">
          <textarea
            id="messageInput"
            placeholder="Type a message... (Enter to send)"
            rows="1"
          ></textarea>
        </div>
        <!-- Send button -->
        <button class="send-btn" id="sendBtn" title="Send message">
          <i class="fas fa-paper-plane"></i>
        </button>
      </div>
      <div class="input-status-bar" id="inputStatusBar">
        <span id="charCount"></span>
        <span id="inputHint">Connect to server to start chatting</span>
      </div>
    </div>

  </main>

  <!-- ── DEBUG PANEL (overlays chat when tab active) ──────── -->
  <div class="debug-panel" id="debugPanel" style="display:none;">
    <div class="debug-header">
      <h3><i class="fas fa-terminal"></i> Protocol Debug Console</h3>
      <div class="debug-actions">
        <button class="btn-small" id="clearDebugBtn"><i class="fas fa-trash"></i> Clear</button>
        <button class="btn-small" id="copyDebugBtn"><i class="fas fa-copy"></i> Copy</button>
      </div>
    </div>
    <div class="debug-log" id="debugLog"></div>
  </div>

  <!-- ── INFO PANEL ────────────────────────────────────────── -->
  <div class="info-panel" id="infoPanel" style="display:none;">
    <div class="info-content">
      <h3><i class="fas fa-microchip"></i> Xiaozhi Web Client</h3>
      <p>This browser application emulates an ESP32 hardware device and connects to a Xiaozhi server through a local WebSocket proxy that injects required auth headers.</p>

      <h4>Protocol Summary</h4>
      <div class="protocol-table">
        <div class="proto-row"><span>Transport</span><code>WebSocket (ws:// or wss://)</code></div>
        <div class="proto-row"><span>Audio Codec</span><code>Opus @ 16kHz mono</code></div>
        <div class="proto-row"><span>Provisioning</span><code>POST /xiaozhi/ota/ → 6-digit code</code></div>
        <div class="proto-row"><span>Auth Header</span><code>Authorization: Bearer &lt;token&gt; (via /api/ws proxy)</code></div>
        <div class="proto-row"><span>Device ID</span><code>Device-Id: &lt;mac-style&gt;</code></div>
        <div class="proto-row"><span>Client ID</span><code>Client-Id: &lt;uuid&gt;</code></div>
        <div class="proto-row"><span>Hello Timeout</span><code>10 seconds</code></div>
      </div>

      <h4>Message Flow</h4>
      <ol class="flow-list">
        <li>Client → Server: <code>hello</code> (capabilities + audio params)</li>
        <li>Server → Client: <code>hello</code> (session_id + server audio params)</li>
        <li>Client → Server: <code>listen {state: "start"}</code> + binary Opus frames</li>
        <li>Server → Client: <code>stt</code> (transcript)</li>
        <li>Server → Client: <code>llm</code> (emotion)</li>
        <li>Server → Client: <code>tts {state: "start"}</code> + binary Opus frames</li>
        <li>Server → Client: <code>tts {state: "stop"}</code></li>
      </ol>

      <h4>Device Identity</h4>
      <div class="identity-display" id="identityDisplay">Loading...</div>
    </div>
  </div>

</div><!-- #app -->

<!-- Pairing / activation overlay -->
<div class="pairing-overlay" id="pairingOverlay" style="display:none;">
  <div class="pairing-card">
    <div class="pairing-header">
      <i class="fas fa-link"></i>
      <h2 id="pairingTitle">Activation Required</h2>
    </div>
    <p class="pairing-message" id="pairingMessage">
      Go to <a href="https://xiaozhi.me" target="_blank" rel="noopener">xiaozhi.me</a> and enter this code.
    </p>
    <div class="pairing-code" id="pairingCodeDisplay">------</div>
    <button class="btn-secondary pairing-copy-btn" type="button" id="copyPairingCodeBtn">
      <i class="fas fa-copy"></i> Copy Code
    </button>
    <div class="pairing-status-row">
      <i class="fas fa-circle-notch fa-spin" id="pairingStatusIcon"></i>
      <span id="pairingStatusText">Waiting for pairing...</span>
    </div>
    <button class="btn-secondary pairing-cancel-btn" type="button" id="cancelPairingBtn">
      Cancel
    </button>
  </div>
</div>

<!-- Loading overlay -->
<div class="loading-overlay" id="loadingOverlay">
  <div class="loading-card">
    <div class="loading-spinner"></div>
    <div class="loading-text" id="loadingText">Initializing Virtual Device...</div>
  </div>
</div>

<!-- Notification toast -->
<div class="toast-container" id="toastContainer"></div>

<!-- Our JS modules (loaded as module scripts) -->
<script type="module" src="/static/app.js"></script>

</body>
</html>`)
})

export default app
