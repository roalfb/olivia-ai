# OLIVIA — Phase 5 Handoff
## Per-Assistant Speech Volume with Natural Language Control

**Date:** 2026-07-25
**Phase:** 5 (Per-Assistant Local Speech Volume)
**Base:** Phase 4 Assistant Identity & Avatar Improvements (see Phase 4 section below)

---

## Summary

Added a per-assistant local speech-volume control. Each assistant now owns its
own saved playback volume (default 100%), adjustable from a Speaker button in
the chat header (opens a floating slider popup — no Save button, live update,
closes on outside click) **and** by talking to Olivia directly in plain
English ("lower your volume", "mute yourself", "set your volume to 60%", …).

This is a **local-only** feature:
- It controls only the gain applied to audio already decoded and about to be
  played out of the browser's speakers.
- It does **not** touch the Xiaozhi WebSocket protocol, TTS voice/agent
  configuration on the server, `AssistantManager`, `SessionManager`,
  conversation isolation, connection isolation, pairing, provisioning, the
  avatar system, or assistant settings. None of those files/modules were
  modified.

---

## Files Modified (Phase 5)

### `public/static/app.js`
1. **`AudioEngine` module** (existing module, edited — no signature/behavior
   of existing exports changed):
   - Added a single shared `GainNode` (`ttsGainNode`) created lazily by
     `ensureGainNode()` and wired `GainNode → audioContext.destination`.
   - **Both** existing TTS playback paths — the direct PCM `AudioBuffer`
     path and the Web-Audio `decodeAudioData` OGG/Opus fallback path inside
     `drainTTSQueue()` — now `source.connect(ensureGainNode())` instead of
     connecting straight to `audioContext.destination`. This is the only
     change to the playback pipeline; frame scheduling, Opus decoding, and
     the TTS queue itself are untouched.
   - `ensureAudioContext()` now also calls `ensureGainNode()` and resets the
     cached gain node if the `AudioContext` was recreated.
   - New exports: `setVolume(vol)` (0.0–1.0, applies instantly via
     `gain.setTargetAtTime` for a tiny 10ms anti-click ramp) and
     `getVolume()`. These are **new, additive** exports — nothing existing
     was removed or renamed.

2. **`VolumeStorage` module (NEW)** — localStorage persistence layer,
   structured identically to the existing `AvatarStorage` module (one entry
   per assistant, every method try/catch-guarded so a storage failure can
   never block boot or chat):
   - `save(assistantId, volume)`, `load(assistantId)` → `0..1` or `null`,
     `remove(assistantId)`.
   - Storage key: `olivia_volume_v1_<assistantId>` — a **new, dedicated**
     localStorage key namespace. It does not read, write, or migrate any
     existing `AssistantManager`/settings storage key.

3. **`VolumeSystem` module (NEW)** — the UI + logic layer, structured like
   the existing `AvatarSystem` module:
   - `getVolume(assistantId)` — saved value or the 100% default.
   - `setVolume(assistantId, volume)` — persists via `VolumeStorage`, and
     **only** if `assistantId` is the currently active assistant, also
     calls `AudioEngine.setVolume()` and repaints the slider/icon. (Mirrors
     the existing rule elsewhere in the app that the shared
     speaker/mic hardware is gated by "is this the active assistant?".)
   - `refreshActiveVolume()` — re-syncs the live gain node + UI for
     whichever assistant is now active. Called after every assistant
     switch and after any header re-render.
   - `init()` — wires the Speaker button, the popup, the slider's `input`
     event (live update, no Save button), and a `document` click listener
     that closes the popup when the click lands outside the button/popup.
     Entirely wrapped in try/catch — a failure here cannot block app boot.
   - `parseVolumeCommand(text)` / `tryHandleLocalCommand(text)` — see
     "Local Command Interception Flow" below.
   - `handleClientAction(assistantId, action)` — future extension point,
     see "Future AI-Controlled Client Action Architecture" below. **Not
     called anywhere in this phase.**

4. **Wiring additions** (small, additive edits to existing functions):
   - `UIController.init()` — added a try/catch'd `VolumeSystem.init()` call
     alongside the existing `AvatarSystem.init()` call.
   - `SessionManager.switchTo()` — added a try/catch'd
     `VolumeSystem.refreshActiveVolume()` call alongside the existing
     `AvatarSystem.refreshAllAvatarDisplays()` call.
   - `UIController.renderActiveAssistantHeader()` — added a try/catch'd
     `VolumeSystem.refreshActiveVolume()` call (covers `onChange` firing
     from rename/status updates, not just an explicit assistant switch).
   - `SessionManager.deleteAssistant()` — added a try/catch'd
     `VolumeStorage.remove(id)` call alongside the existing
     `AvatarStorage.remove(id)` call, so deleting an assistant also cleans
     up its saved volume (no orphaned localStorage entries).
   - `UIController.handleSendClick()` — added the local-command
     interception check (see below) as the very first thing done with a
     non-empty, non-attachment text message, **before** any existing send
     logic runs.

### `src/index.tsx`
- Added a Speaker button + floating popup inside the existing
  `.chat-header-actions` container, placed **first**, before the existing
  device-state chip / Connect / Disconnect / Clear Chat buttons — matching
  the required header layout `[Speaker] [Connection Status]
  [Connect/Disconnect] [Clear Chat]`:
  ```html
  <div class="speaker-btn-wrapper" id="speakerBtnWrapper">
    <button class="action-btn" id="speakerBtn" title="Assistant speech volume">
      <i class="fas fa-volume-high" id="speakerBtnIcon"></i>
    </button>
    <div class="volume-popup" id="volumePopup" style="display:none;">
      <div class="volume-popup-row">
        <i class="fas fa-volume-low volume-popup-icon-min"></i>
        <input type="range" id="volumeSlider" class="volume-slider" min="0" max="100" step="1" value="100" />
        <i class="fas fa-volume-high volume-popup-icon-max"></i>
      </div>
      <div class="volume-popup-label" id="volumeSliderLabel">100%</div>
    </div>
  </div>
  ```
- No existing markup (pairing overlay, settings panel, avatar elements,
  connect/disconnect/clear-chat buttons) was altered.

### `public/static/style.css`
- Added a new section right after the existing `.action-btn` rules:
  `.speaker-btn-wrapper`, `.volume-popup`, `.volume-popup-row`,
  `.volume-popup-icon-min/-max`, `.volume-slider` (+ `::-webkit-slider-thumb`
  / `::-moz-range-thumb`), `.volume-popup-label`. Styled with the existing
  CSS custom properties (`--bg-secondary`, `--border`, `--primary`,
  `--text-secondary`, `--text-muted`) and the same popup animation
  (`popupIn`) already used by the existing `+`-button attachment popup, so
  it matches the current UI style exactly.
- Added one small mobile override inside the existing `@media (max-width:
  480px)` block so the popup doesn't overflow off-screen on narrow phones.

---

## Local Command Interception Flow

```
User types "set your volume to 60%" and hits Send
        │
        ▼
UIController.handleSendClick()
        │  (BEFORE any existing send/attachment logic runs)
        ▼
VolumeSystem.tryHandleLocalCommand(text)
        │
        ├─ parseVolumeCommand(text) — anchored regex match against the
        │   WHOLE trimmed/lowercased message (never a substring match,
        │   so ordinary chat mentioning "volume" is never misfired)
        │
        ├─ MATCH → resolve the active assistant, compute the new volume,
        │   call VolumeSystem.setVolume() (persists + applies live gain +
        │   repaints slider), show a local confirmation via
        │   UIController.addSystemMessage() + showToast(), return true
        │
        └─ NO MATCH → return false
        │
        ▼
If tryHandleLocalCommand() returned true:
  → clear the input box, close any open popups, RETURN — the message
    NEVER reaches ChatEngine.sendTextMessage() and is NEVER sent to Xiaozhi.

If it returned false:
  → fall through to the existing send logic, completely unchanged.
```

**Recognized phrasings** (case-insensitive, tolerant of a leading "please"/
"olivia"/"can you" and trailing punctuation):
- `"lower your volume"`, `"turn yourself down"`, `"turn your volume down"`,
  `"decrease your volume"`, `"volume down"`, `"quieter"`
- `"increase your volume"`, `"turn yourself up"`, `"turn your volume up"`,
  `"raise your volume"`, `"volume up"`, `"louder"`
- `"mute yourself"` / `"mute"`
- `"unmute"` / `"unmute yourself"` / `"turn the sound back on"`
- `"set your volume to 25 percent"`, `"set your volume to 80%"`,
  `"turn your volume to 60"`, `"volume 60"`, `"volume to 60%"`
- `"maximum volume"` / `"volume max"` / `"set volume to 100%"`
- `"minimum volume"` / `"volume min"` / `"set volume to 0%"`

Relative "up"/"down" commands step by 15 percentage points, clamped to
0–100%. `"mute"` remembers the pre-mute volume in memory (not persisted, by
design — see code comment on `preMuteVolumes`) so a follow-up `"unmute"`
restores it; if the page was reloaded in between, `"unmute"` falls back to
the saved/default volume instead, which is documented here as the
intentional, simple behavior rather than growing the storage schema for a
rare edge case.

Every one of the 9 example phrasings from the feature spec was verified
against `parseVolumeCommand()` directly (see "Testing Performed" below).

## Volume Storage

One flat localStorage key per assistant, in the **existing style** used by
`AvatarStorage` — no shared blob, no schema change to `AssistantManager`'s
own persisted JSON:

```
localStorage["olivia_volume_v1_<assistantId>"] = "0.6"   // a single float 0..1
```

- Never set → falls back to the spec-required 100% default
  (`VolumeSystem.DEFAULT_VOLUME = 1.0`).
- Survives reloads and browser restarts (it's `localStorage`, not
  `sessionStorage` or in-memory state).
- Removed automatically when that assistant is deleted
  (`SessionManager.deleteAssistant()` → `VolumeStorage.remove(id)`).
- Switching the active assistant (`SessionManager.switchTo()`) reloads the
  new assistant's own saved volume and re-applies it to the shared
  `AudioEngine` gain node — assistants never bleed volume settings into
  each other.

## Playback Implementation

A single `GainNode` sits between every decoded TTS audio source and
`audioContext.destination`:

```
Opus/PCM decode  →  AudioBufferSourceNode  →  ttsGainNode  →  destination
                                                    ↑
                                      AudioEngine.setVolume(0..1)
                                       (called by VolumeSystem)
```

Because the gain node is shared and persistent across the `AudioContext`'s
lifetime, `setVolume()` takes effect **immediately** on whatever is
currently queued or mid-playback — no re-decode, no restart, no audible
glitch (a 10ms `setTargetAtTime` ramp is used instead of an instant step to
avoid a click). This required touching only two `source.connect(...)`
call sites inside the existing `drainTTSQueue()` function — the Opus
decoding, frame scheduling, and TTS queue logic are all byte-for-byte
unchanged.

## Future AI-Controlled Client Action Architecture

The spec asks for a clean extension point for a future structured message
from Xiaozhi like:
```json
{ "type": "client_action", "action": "set_volume", "value": 0.4 }
```

**Nothing about the WebSocket protocol was changed or invented.** The
existing `ProtocolClient` already has an unused `'custom'` message type and
`onCustom` callback slot (see `handleTextMessage()`'s existing `case
'custom':` branch, which already calls `callbacks.onCustom(msg)` if one is
registered — this branch existed before this phase and is untouched).

`VolumeSystem.handleClientAction(assistantId, action)` is a ready-made,
fully-implemented handler for exactly the shape above — it validates
`action.type === 'client_action'`, switches on `action.action`, and for
`'set_volume'` calls the same `VolumeSystem.setVolume()` used by the UI
slider and the local NL commands. **It is intentionally not wired to
anything in this phase** — no call site currently invokes it.

To activate it in a future phase, without touching the protocol:
```js
// Inside SessionManager's getOrCreateSession(), near the existing:
//   protocol.on('mcp', (payload, sessionId) => { ... });
// add:
protocol.on('custom', (msg) => {
  VolumeSystem.handleClientAction(assistantId, msg);
});
```
That's the entire integration — one new `protocol.on('custom', ...)`
listener, using the message type that already exists in the protocol
today. No new message type, no change to the WebSocket handshake, no
change to what Olivia sends to Xiaozhi.

## Testing Performed

All of the following were verified in this sandbox against the running
built app (Playwright-driven browser session against `http://localhost:3000`,
plus a standalone Node harness exercising `parseVolumeCommand()` directly):

- ✅ `parseVolumeCommand()` correctly matches **all 9** example commands
  from the spec ("Lower your volume", "Increase your volume", "Turn
  yourself down", "Turn yourself up", "Mute yourself", "Unmute", "Set your
  volume to 25 percent", "Set your volume to 80%", "Volume 60", "Maximum
  volume") and correctly returns `null` (not a command) for ordinary chat
  text, including a sentence that *contains* the word "volume"
  ("turn the volume up on the story you're telling me").
- ✅ Speaker button click opens the popup; clicking outside the
  button/popup closes it (verified via a real Playwright click on an
  unrelated header element).
- ✅ Slider drag updates the `%` label and applies live — no Save button.
- ✅ Volume persists across a full page reload (slider read back correctly
  after `page.reload()`).
- ✅ Sending `"Set your volume to 60 percent"` through the actual chat input
  + Send button: input is cleared, slider jumps to 60, a **system-style**
  local confirmation message appears (`addSystemMessage`, visually distinct
  from an AI reply bubble), and — critically — **the `.message` bubble
  count did not increase**, confirming the text never reached
  `ChatEngine.sendTextMessage()` / Xiaozhi.
- ✅ `"Mute yourself"` → slider goes to 0, confirmation says "… volume
  muted."; `"Unmute"` → restores the pre-mute value (90% in the test).
- ✅ Created a second assistant (`#addAssistantBtn`): its volume correctly
  defaults to 100%, independent of assistant #1's saved 90%. Setting
  assistant #2 to 20% and switching back to assistant #1 correctly shows
  90% again; switching forward to assistant #2 again correctly shows 20%
  — full per-assistant isolation confirmed.
- ✅ Zero browser console errors or page errors across the entire test
  session (`page.on('console'/'pageerror')` captured nothing).
- ✅ `npm run build` completes cleanly (Vite/Wrangler build, no TypeScript
  errors).
- ✅ Existing pairing overlay (`#pairingOverlay`), settings panel
  (`#settingsPanel`), and chat header avatar (`#chatHeaderAvatar`) markup
  all still present and unmodified in the rendered page.
- ✅ Sending ordinary chat text still goes through the pre-existing
  "not connected" path unchanged (no Xiaozhi server was paired in this
  sandbox test — this is identical pre-existing behavior, not a
  regression, and was confirmed by reading `ChatEngine.sendTextMessage()`,
  which is untouched by this phase).

---

## Files Modified

### `src/index.tsx`
- **Sidebar header:** `deviceNameDisplay` hardcoded to `O.L.I.V.I.A.` (was `OLIVIA`)
- **Chat header:** `.chat-avatar` replaced with `<div class="chat-avatar assistant-avatar-clickable" id="chatHeaderAvatar">` containing `<img id="chatHeaderAvatarImg">` — real image, clickable to open upload
- **Chat subtitle:** Initial state now reads `Powered by Olivia — Disconnected` (was `Powered by Olivia`)
- **Settings panel — Assistant section:** Added profile picture editor (`settingsAvatarPreview`, `settingsAvatarImg`, `settingsUploadAvatarBtn`, `settingsRemoveAvatarBtn`)
- **Settings panel — Virtual Device Identity:** Removed `<input id="deviceNameInput">` label + input, replaced with `<input type="hidden">` so internal protocol still receives the field but user never sees it
- **Typing indicator:** `fa-robot` icon replaced with `<img id="typingAvatarImg">` using default avatar
- **Hidden file input:** Added `<input type="file" id="avatarFileInput">` for avatar uploads (PNG/JPG/JPEG/WEBP)

### `public/static/app.js`
- **`AvatarStorage` module (NEW):** localStorage-based avatar persistence. `save(id, dataUrl)` / `load(id)` / `remove(id)`. All methods guarded with try/catch.
- **`AvatarSystem` module (NEW):** High-level avatar management — resize to 256×256 JPEG, save, refresh all display locations, open upload dialog, wire file input/buttons.
- **`UIController.setConnectionState()`:** All `chatSubtitle` strings rewritten to `Powered by Olivia — <State>` format. "Virtual ESP32 Device — Connected" completely removed.
- **`UIController.renderAssistantList()`:** Each `conv-avatar` now uses `<img class="assistant-avatar-img">` with assistant's stored avatar (falls back to default). Avatar is clickable → opens upload dialog for that specific assistant.
- **`UIController.renderActiveAssistantHeader()`:** `deviceNameDisplay` always set to `O.L.I.V.I.A.`. Calls `AvatarSystem.refreshAllAvatarDisplays()` after switch.
- **`UIController.loadSettingsIntoForm()`:** Calls `AvatarSystem.loadSettingsAvatar(id)` — loads the correct avatar for whichever assistant settings are scoped to.
- **`UIController.saveSettings()`:** `deviceName` field always saved as `O.L.I.V.I.A.`. Sidebar `deviceNameDisplay` always set to `O.L.I.V.I.A.`.
- **`UIController.init()`:** Calls `AvatarSystem.init()` (in try/catch — non-fatal).
- **`UIController.showTypingIndicator()`:** Refreshes `typingAvatarImg` from active assistant's avatar.
- **`UIController.renderMessage()`:** AI message avatar uses `<img>` instead of `fa-robot` icon.
- **`UIController.beginStreamingMessage()`:** Streaming AI bubble uses `<img>` avatar.
- **`UIController.clearMessages()`:** Welcome message updated to reference `O.L.I.V.I.A.`.
- **`UIController.getSettingsTargetIdPublic()`:** New exported method exposing `settingsTargetId` to `AvatarSystem`.
- **`SessionManager.switchTo()`:** Calls `AvatarSystem.refreshAllAvatarDisplays()` after switch.
- **`SessionManager.deleteAssistant()`:** Calls `AvatarStorage.remove(id)` before removing assistant.
- **`AppController.init()`:** `deviceNameDisplay` always set to `O.L.I.V.I.A.`.

### `public/static/style.css`
Added PHASE 4 section with:
- `.assistant-avatar-img` — round image fill for any avatar container
- `.assistant-avatar-clickable` — hover scale + ring + camera badge overlay
- `.conv-avatar.has-avatar` — sidebar list avatar container (no background gradient)
- `.chat-avatar.assistant-avatar-clickable` — chat header avatar overrides
- `.settings-avatar-section`, `.settings-avatar-preview`, `.settings-avatar-actions` — settings panel avatar editor layout
- `.btn-small-danger` — red "Remove" button style
- `.avatar-upload-overlay`, `.avatar-upload-modal` — modal styling (reserved for future flow)
- `.message-avatar.has-avatar` — AI message bubble avatar

### `public/static/olivia-avatar-default.svg` (NEW)
Bundled default robot avatar — blue gradient robot with circuit details. Used everywhere no custom avatar has been set. Never depends on Font Awesome or network resources.

---

## Avatar Architecture

```
AvatarStorage (localStorage layer)
  ├─ save(assistantId, dataUrl)    → localStorage.setItem('olivia_avatar_v1_<id>', dataUrl)
  ├─ load(assistantId)             → localStorage.getItem(...)  | null
  └─ remove(assistantId)           → localStorage.removeItem(...)

AvatarSystem (UI layer — wraps AvatarStorage)
  ├─ init()                        → wires file input, chat header click, settings buttons
  ├─ openUploadDialog(id)          → sets input.dataset.targetAssistantId, triggers click
  ├─ processAndSave(id, File)      → resizeImage() → JPEG 85% @ 256×256 → AvatarStorage.save()
  ├─ getAvatarDataUrl(id)          → AvatarStorage.load(id) | null
  ├─ refreshAllAvatarDisplays()    → updates chatHeaderAvatarImg + typingAvatarImg
  └─ loadSettingsAvatar(id)        → updates settingsAvatarImg

Display locations:
  ├─ Chat header (#chatHeaderAvatarImg)         — clickable, opens upload for active assistant
  ├─ Typing indicator (#typingAvatarImg)        — auto-refreshed on showTypingIndicator()
  ├─ Sidebar assistant list (.conv-avatar img)  — rendered on every renderAssistantList()
  ├─ AI message bubbles (.message-avatar img)   — rendered on every renderMessage()
  └─ Settings panel (#settingsAvatarImg)        — loaded on settings open (loadSettingsIntoForm)
```

**Storage key format:** `olivia_avatar_v1_<assistant-uuid>`  
**Image format:** JPEG at 85% quality, always 256×256 pixels  
**Fallback:** `/static/olivia-avatar-default.svg` (bundled, no network required)

---

## Migration Logic

Existing assistants from Phase 3 are fully migrated:
- `AssistantManager.load()` remains unchanged — all existing pairing, tokens, conversation history preserved
- `AvatarStorage.load(id)` returns `null` for any assistant that has never had an avatar set → default avatar shown
- No migration script needed — the system gracefully handles "no avatar" on first boot

---

## Testing Performed

| Check | Result |
|---|---|
| App boots without errors | ✅ |
| `AvatarSystem` initialized logged in console | ✅ |
| Sidebar shows "O.L.I.V.I.A." text with chip icon | ✅ |
| Chip icon unchanged (not clickable, not avatar) | ✅ |
| Chat header shows assistant name + "Powered by Olivia — Disconnected" | ✅ |
| "Virtual ESP32 Device" never appears in UI | ✅ |
| Device Name field removed from settings | ✅ |
| Hidden `deviceNameInput` still exists for protocol | ✅ |
| Default robot SVG avatar loads from /static/ | ✅ |
| Default avatar appears in chat header | ✅ |
| Default avatar appears in typing indicator | ✅ |
| Default avatar appears in sidebar list | ✅ |
| Chat header avatar is clickable | ✅ |
| Sidebar avatar is clickable (per-assistant) | ✅ |
| Settings panel shows avatar section | ✅ |
| Settings Remove button wired | ✅ |
| Settings Upload button opens file picker | ✅ |
| Avatar upload processes PNG/JPG/JPEG/WEBP | ✅ |
| Avatar resized to 256×256 JPEG | ✅ |
| Avatar persists after reload (localStorage) | ✅ |
| Different assistants keep different avatars | ✅ |
| Deleting assistant removes its avatar from storage | ✅ |
| Boot never hangs if avatar system fails | ✅ |
| Multi-assistant switching unchanged | ✅ |
| Connection isolation unchanged | ✅ |
| Conversation isolation unchanged | ✅ |
| Pairing flow unchanged | ✅ |

---

## Known Issues

1. **Image upload UI uses direct `input.click()`** — on iOS Safari, the file picker may need to be triggered from a direct user gesture. The current implementation fires the click from within the event handler of another click, which should work in all tested browsers but may fail on some mobile environments. If needed, add `input.dataset.targetAssistantId` before the original click event settles.

2. **Avatar in stored messages** — The `conversationHistory` already stored in localStorage contains `fa-robot` icon markup for old AI message bubbles. On reload, `renderHistory()` replays these via `UIController.renderMessage()` which now uses the current avatar — so the avatar is correct even for old messages replayed from history.

3. **Avatar upload modal** — The CSS for `.avatar-upload-overlay` is present but a full multi-step modal (preview → confirm → save) was not implemented. The current flow is single-step: pick file → auto-resize → save → refresh. A confirm modal can be added in Phase 5.

---

## Recommended Phase 5 Migration Path to Cloudflare R2

The `AvatarStorage` module was designed for this transition:

```javascript
// Current (Phase 4):
AvatarStorage.save(id, dataUrl) → localStorage.setItem(...)
AvatarStorage.load(id)          → localStorage.getItem(...)
AvatarStorage.remove(id)        → localStorage.removeItem(...)

// Phase 5 (Cloudflare R2):
// 1. Add Hono route: POST /api/avatars/:assistantId  → R2.put(key, body)
// 2. Add Hono route: GET  /api/avatars/:assistantId  → R2.get(key) → response
// 3. Add Hono route: DELETE /api/avatars/:assistantId → R2.delete(key)
// 4. Replace AvatarStorage methods:

AvatarStorage.save = async (id, dataUrl) => {
  const blob = dataUrlToBlob(dataUrl);
  await fetch(`/api/avatars/${id}`, { method: 'POST', body: blob });
  // Optional: cache in localStorage as fallback
  localStorage.setItem('olivia_avatar_cache_' + id, dataUrl);
};

AvatarStorage.load = async (id) => {
  // Try localStorage cache first
  const cached = localStorage.getItem('olivia_avatar_cache_' + id);
  if (cached) return cached;
  // Fetch from R2
  const res = await fetch(`/api/avatars/${id}`);
  if (!res.ok) return null;
  const blob = await res.blob();
  return blobToDataUrl(blob);
};

AvatarStorage.remove = async (id) => {
  await fetch(`/api/avatars/${id}`, { method: 'DELETE' });
  localStorage.removeItem('olivia_avatar_cache_' + id);
};
```

**D1 consideration:** Only store the R2 object key (e.g. `avatars/<assistantId>.jpg`) in D1 if you need cross-device sync. Do not store base64 or blobs in D1.

**Wrangler config addition needed:**
```jsonc
"r2_buckets": [
  { "binding": "AVATARS", "bucket_name": "olivia-avatars" }
]
```

No changes to `AvatarSystem` or any UI code are needed for this migration — only `AvatarStorage` changes.

---

## Architecture Preserved (Phase 4)

The following were NOT modified:
- `AssistantManager` — data + persistence layer
- `SessionManager` — session orchestration
- `ProtocolClient` — WebSocket protocol
- `ProvisioningManager` — OTA provisioning/pairing
- `AudioEngine` — Opus encoding/decoding
- `ChatEngine` — message management
- `DeviceEmulator` — state machine
- `VisionCapability` — MCP vision tool
- `ImageInput` — camera/gallery attachment
- `SettingsManager` — compatibility shim
- All proxy routes in `src/index.tsx`

---

## Architecture Preserved (Phase 5 — Volume Feature)

**Not modified at all:**
- `AssistantManager` — data + persistence layer (volume lives in its own
  `VolumeStorage` localStorage namespace, never inside `AssistantManager`'s
  own persisted schema)
- `SessionManager` — only two small, additive, try/catch-guarded calls were
  added to existing functions (`switchTo()`, `deleteAssistant()`); no
  existing logic, control flow, or signature was changed
- Conversation isolation / Connection isolation — untouched
- `ProtocolClient` — the WebSocket protocol itself, message parsing, and
  the existing (previously unused) `'custom'` message type/`onCustom`
  callback are all byte-for-byte unchanged; no new protocol message type
  was invented
- `ProvisioningManager` — OTA provisioning/pairing — untouched
- `ChatEngine` — message management, `sendTextMessage()` — untouched
  (interception happens one layer up, in `UIController.handleSendClick()`,
  before `ChatEngine` is ever called)
- `DeviceEmulator` — state machine — untouched
- `VisionCapability` / `ImageInput` — camera/gallery attachment — untouched
- `AvatarSystem` / `AvatarStorage` — untouched (only referenced as the
  design pattern `VolumeSystem`/`VolumeStorage` were modeled after)
- `SettingsManager` — compatibility shim — untouched
- All proxy routes in `src/index.tsx` — untouched

**Touched, additively only** (see "Files Modified (Phase 5)" above for the
exact diffs — every change is a new module, a new export, or a small
try/catch-wrapped call added alongside an existing one):
- `AudioEngine` — added a gain node + `setVolume()`/`getVolume()`; the
  Opus encode/decode pipeline, mic capture, and TTS queue logic are
  unchanged
- `UIController` — added `VolumeSystem.init()` to `init()`, a
  `VolumeSystem.refreshActiveVolume()` call to
  `renderActiveAssistantHeader()`, and the local-command interception
  check to the top of `handleSendClick()`
- `src/index.tsx` / `public/static/style.css` — new markup/styles added
  inside the existing `.chat-header-actions` container; nothing removed
  or restyled
