# Development History

This document is the engineering history of Olivia — how it evolved from a
single-device ESP32 emulator into a multi-assistant platform. It is written
for future contributors who want to understand **why** the codebase looks
the way it does, including problems encountered, solutions chosen, and
ideas that were considered but deferred.

This is a narrative history, not a technical reference. For how Olivia
works **today**, see [ARCHITECTURE.md](./ARCHITECTURE.md). For a concise
list of released changes, see [CHANGELOG.md](./CHANGELOG.md). For
setup/usage instructions, see [README.md](./README.md).

> **Source note:** This document consolidates the individual
> `HANDOFF_PHASE123.md`, `HANDOFF_PHASE45.md`, and
> `HANDOFF_About-Page-Refactor.md` documents that were produced during
> Version 2.0 and Version 2.1 development (the Brand Identity Integration
> work below was not tracked in its own handoff file). Those files have
> been merged into this single chronological history and removed from
> the repository; their content lives on here.

## Table of Contents

- [v1.0 — Foundation](#v10--foundation)
- [v1.1 — Stabilization and First Deployment](#v11--stabilization-and-first-deployment)
- [Version 2.0 Development — Multi-Assistant Foundation](#version-20-development--multi-assistant-foundation)
  - [Phase 1–2 — Multi-Assistant Foundation](#phase-12--multi-assistant-foundation)
  - [Phase 3 — Finalization, Polish & Theme Toggle](#phase-3--finalization-polish--theme-toggle)
  - [Phase 4 — Assistant Identity & Avatars](#phase-4--assistant-identity--avatars)
  - [Phase 5 — Per-Assistant Speech Volume](#phase-5--per-assistant-speech-volume)
- [Version 2.1 — Official Branding & Documentation](#version-21--official-branding--documentation)
  - [About Page Refactor](#about-page-refactor)
  - [Brand Identity Integration](#brand-identity-integration)
  - [Documentation Restructuring](#documentation-restructuring)
- [Version 2.2 — Settings & Backup](#version-22--settings--backup)
  - [Why Backup & Restore Was Introduced](#why-backup--restore-was-introduced)
  - [Migration from olivia-ai.pages.dev to www.oliviaai.dev](#migration-from-olivia-aipagesdev-to-wwwoliviaaidev)
  - [Evolution of the Settings Interface](#evolution-of-the-settings-interface)
  - [Milestones in Version 2.2](#milestones-in-version-22)
- [Recurring Design Principles](#recurring-design-principles)
- [Future Ideas That Remain Relevant](#future-ideas-that-remain-relevant)

---

## v1.0 — Foundation

Olivia began as a single-device browser emulator for the Xiaozhi ESP32
protocol. The founding goal was to reproduce, in a browser, everything a
physical ESP32 board running Xiaozhi firmware does — without requiring any
hardware.

Three browser limitations had to be solved with a server-side proxy from
day one:

1. **Browser WebSockets cannot set custom HTTP headers.** The Xiaozhi
   server requires `Authorization`, `Device-Id`, `Client-Id`, and
   `Protocol-Version` headers on the WebSocket upgrade request, which no
   browser API allows a page to set. The solution was a Hono server on
   Cloudflare Workers acting as a transparent header-injecting proxy,
   mirroring the reference Python `proxy.py` client from the official
   `xiaozhi-esp32` repository.
2. **CORS blocks direct vision uploads and OTA provisioning calls.** Both
   needed the same proxy treatment — server-side requests with injected
   device headers, forwarded to the real endpoints.
3. **Real Opus encoding is mandatory.** The Xiaozhi server rejects raw
   PCM16 audio outright. `libopus-wasm` was adopted to encode microphone
   audio into genuine 960-sample (60 ms) Opus frames, matching the ESP32
   firmware's exact frame duration.

The result was a fully working single-assistant application: WebSocket
protocol, OTA pairing, Opus voice, camera/gallery vision via MCP tool
calls, and a messenger-style browser UI — functionally complete for one
virtual device.

---

## v1.1 — Stabilization and First Deployment

Before the multi-assistant work began, two bugs were fixed and the project
was deployed to Cloudflare Pages for the first time:

- **Microphone pipeline bug** — a defect in the audio-capture path was
  corrected to make voice input reliable.
- **Long text message rejection** — the Xiaozhi server's `listen{detect}`
  channel has a message-length limit. Long typed messages began being
  automatically split at sentence boundaries into ≤80-character chunks,
  sent sequentially, and reassembled correctly by the server-side LLM.

With these fixes in place, Olivia was deployed to Cloudflare Pages and the
first comprehensive project documentation (including the README banner)
was written.

---

## Version 2.0 Development — Multi-Assistant Foundation

Version 2.0's overarching goal was to transform Olivia from a single
virtual device into a platform hosting **any number of independent AI
assistants**, without changing a single byte of the underlying Xiaozhi
protocol implementation. The work was carried out in phases, each with its
own handoff document; this section merges them into one narrative.

### Phase 1–2 — Multi-Assistant Foundation

**Objective:** Turn the existing single-device modules into per-assistant
instances, orchestrated by a new management layer, with zero protocol
changes.

**Implementation:**

- **`AssistantManager`** was introduced as the single source of truth for
  every assistant's persisted state (identity, settings, pairing,
  conversation history), replacing the old single-device settings object.
  It persists to `localStorage` under `olivia_assistants_v1`.
- **`SessionManager`** was introduced to create, switch, rename, and delete
  assistants, and to orchestrate each assistant's independent **session
  bundle** — its own `DeviceEmulator`, `ProvisioningManager`,
  `ProtocolClient`, `ChatEngine`, and `VisionCapability` instances.
- **`SettingsManager`** was kept as a thin, backwards-compatible shim over
  `AssistantManager`, so any code still written against the original
  single-device settings API continued to work unmodified.
- The existing `ProtocolClient`, OTA provisioning logic, and Opus audio
  pipeline were **not rewritten** — they were simply instantiated once per
  assistant. This was a deliberate architectural choice: multi-assistant
  support is purely an orchestration layer on top of an otherwise
  unmodified protocol stack, keeping the Xiaozhi-facing behavior
  byte-for-byte identical regardless of how many assistants exist.
- UI additions: an "Add Assistant" flow (`prompt()`-based), a per-assistant
  gear icon opening settings scoped to that one assistant, rename, and
  delete (with a guard preventing deletion of the last remaining
  assistant).

**Testing:** A dedicated Node.js VM test harness (fake WebSocket,
`localStorage`, and DOM stubs) verified 12 core-logic tests — default
assistant creation, independent session object identity, chat isolation,
persistence across simulated reloads, the delete-last-assistant guard,
auto-switching after deleting the active assistant, and rename behavior —
plus 5 dedicated connection-isolation tests confirming that connecting,
switching, and disconnecting one assistant never opens, closes, or
otherwise affects another assistant's WebSocket.

**Lessons learned:** Isolating state per assistant is straightforward when
each per-assistant module is a small, self-contained instance; the harder
discipline was ensuring **shared hardware resources** (the physical
microphone and speakers) were deliberately scoped to "whichever assistant
is currently active" rather than being duplicated per assistant — a
pattern that carried forward into every later phase (avatars, volume).

### Phase 3 — Finalization, Polish & Theme Toggle

**Objective:** Harden the Phase 1–2 foundation for a production-quality
deliverable: verify nothing was left half-finished, clean up dead code,
fix a dark-mode readability bug, and add a manual light/dark theme toggle.

**Implementation:**

- Audited every Hono proxy route (`/api/ws`, `/api/ota/check`,
  `/api/ota/activate`, `/api/vision/explain`, static serving, main HTML
  shell) and confirmed none had been modified by the multi-assistant work.
- Removed 15 verbose `console.log('[VISION] …')` debug statements from the
  vision proxy route that had been left in from earlier development;
  confirmed zero remaining TODO/FIXME/HACK markers in the codebase.
- **Dark-mode active-item contrast bug:** the selected assistant in the
  sidebar rendered light grey text on a light-blue background in dark
  mode — nearly invisible. Root cause: `--primary-light` wasn't overridden
  for dark mode, so the active item's background stayed light-blue while
  its text color came from the near-white `--text-primary`. Fixed by
  introducing dedicated `--active-item-bg` / `--active-item-text` custom
  properties, distinct per theme, plus a hover-state override so hovering
  an active item doesn't revert to the unreadable light-blue background.
- **Manual theme toggle:** added a `ThemeManager` module (`init()`,
  `toggle()`, `getCurrent()`) that reads/writes a `localStorage`
  preference (`olivia_theme_preference`) and applies a `data-theme`
  attribute to `<html>`. A three-layer CSS cascade was designed so the
  manual override always wins over the OS-level `prefers-color-scheme`
  media query, while still respecting the system preference when no
  manual choice has been made. A ☀️/🌙 button was added to the sidebar
  header; the icon swap itself is pure CSS, requiring no re-render.

**Files modified:** `src/index.tsx` (removed debug logs, added toggle
button markup), `public/static/style.css` (active-item contrast fix,
theme cascade, toggle button styling), `public/static/app.js` (new
`ThemeManager` module, ~48 lines, wired into boot and exposed on
`window.XiaozhiDebug`).

**Testing:** In-browser Playwright smoke testing confirmed a clean 14-line
boot sequence with zero console errors across a full boot → create →
switch → connect → delete cycle, and confirmed the Opus WASM encoder
loaded successfully from CDN.

**Known limitations carried forward:** the "Add Assistant" flow still used
a plain `prompt()` dialog rather than an inline sidebar input; there was no
auto-reconnect of assistants that were connected before a page reload
(considered intentional — reconnecting is a manual, explicit action, the
same as with a single physical device); and the per-assistant gear icon
was only revealed on hover, which is not ideal for touch-only devices.

### Phase 4 — Assistant Identity & Avatars

**Objective:** Give every assistant a distinct visual identity (a
profile-picture avatar) while keeping the app's own branding singular —
Olivia is always "O.L.I.V.I.A." at the platform level, but individual
assistants can look different from each other.

**Implementation:**

- **`AvatarStorage`** (new module) — a `localStorage` persistence layer
  with `save(id, dataUrl)` / `load(id)` / `remove(id)`, storing each
  assistant's avatar under `olivia_avatar_v1_<assistantId>`.
- **`AvatarSystem`** (new module) — the UI and processing layer: resizes
  and re-encodes any uploaded PNG/JPG/JPEG/WEBP to a 256×256 JPEG at 85%
  quality via an offscreen canvas (entirely client-side, nothing uploaded
  to a server), and keeps every display location — chat header, typing
  indicator, sidebar assistant list, AI message bubbles, and the settings
  panel — in sync.
- A bundled default avatar (`olivia-avatar-default.svg`, a hand-designed
  robot icon) was added so any assistant without a custom avatar still has
  a consistent, network-independent visual.
- The device name field was hidden from the settings UI — from this point
  forward every assistant identifies itself as **O.L.I.V.I.A.** at the
  protocol level (the hidden `deviceNameInput` field still exists
  internally for the OTA payload), while the assistant's display **name**
  and new **avatar** became the actual per-assistant personalization
  surface. The chat subtitle was reworded to "Powered by Olivia —
  `<state>`", replacing the old "Virtual ESP32 Device — Connected" string.
- `SessionManager.deleteAssistant()` was extended to also call
  `AvatarStorage.remove(id)`, so no avatar is ever orphaned in storage.

**Testing:** Verified boot with no errors, correct default-avatar fallback
in all four display locations, correct avatar resizing/persistence,
independent avatars across multiple assistants surviving a switch, and
that deleting an assistant removed its stored avatar. Multi-assistant
switching, connection isolation, conversation isolation, and the pairing
flow were all re-verified as unaffected.

**Known issues noted at the time:** the file-picker `input.click()` call
was triggered from within another click handler, which is normally fine
but could be fragile on some mobile browsers requiring a more direct user
gesture; and a full "preview → confirm → save" avatar upload modal was
scoped in CSS but not implemented — the shipped flow is a simpler
single-step pick-and-save.

**Forward-looking design decision:** `AvatarStorage`'s three-method
interface (`save`/`load`/`remove`) was deliberately kept minimal so it
could later be swapped for `fetch()` calls to R2-backed Hono routes
without touching any UI code — see [Future Ideas](#future-ideas-that-remain-relevant).

### Phase 5 — Per-Assistant Speech Volume

**Objective:** Give each assistant its own local speech-playback volume,
controllable both via a UI slider and via natural language, without
touching the Xiaozhi protocol, TTS voice configuration, or any existing
isolation guarantee.

**Implementation:**

- **`AudioEngine` (extended, not rewritten):** a single shared `GainNode`
  (`ttsGainNode`) was added, created lazily and wired between every
  decoded TTS audio source and `audioContext.destination`. Both existing
  playback paths inside `drainTTSQueue()` — the direct PCM path and the
  `decodeAudioData()` OGG/Opus fallback path — were changed to connect
  through this gain node instead of straight to the destination. This was
  the only change to the playback pipeline; Opus decoding and frame
  scheduling were untouched. New exports `setVolume(vol)` (with a 10ms
  anti-click ramp via `gain.setTargetAtTime`) and `getVolume()` were added
  additively.
- **`VolumeStorage`** (new module) — modeled directly on `AvatarStorage`:
  `save`/`load`/`remove` against a dedicated `olivia_volume_v1_<assistantId>`
  key, fully try/catch-guarded so a storage failure can never block chat.
- **`VolumeSystem`** (new module) — the UI and logic layer: wires a new
  speaker button in the chat header that opens a floating slider popup
  (live update, no Save button, closes on outside click); persists and
  applies volume only when the target assistant is the currently active
  one (mirroring the existing rule that shared hardware — mic, speakers —
  is gated by "is this the active assistant?"); and implements
  **natural-language command interception**.
- **Local command interception:** `UIController.handleSendClick()` was
  given one new, additive check at the very top: before any existing send
  logic runs, `VolumeSystem.tryHandleLocalCommand(text)` is tried against
  an anchored, whole-message regex (never a substring match, so an
  ordinary sentence merely containing the word "volume" is correctly left
  alone and sent to the AI as normal chat). Recognized phrasings include
  relative commands ("lower/raise your volume", stepping 15 percentage
  points), absolute commands ("set your volume to 60%"), and mute/unmute.
  A match short-circuits the send entirely — the text never reaches
  `ChatEngine.sendTextMessage()` and is never transmitted to Xiaozhi.
- **Future extension point, deliberately left unwired:** the Xiaozhi
  protocol's existing `'custom'` message type already had an unused
  `onCustom` callback slot in `ProtocolClient` from the original
  single-device implementation. `VolumeSystem.handleClientAction()` was
  written as a ready-made handler for a future
  `{ "type": "client_action", "action": "set_volume", "value": 0.4 }`
  message, but no call site invokes it yet — wiring it up in a future
  phase would require only one new `protocol.on('custom', ...)` listener,
  no protocol changes.

**Testing:** Verified all example command phrasings matched correctly
(and that ordinary chat mentioning "volume" did not misfire), that the
popup opened/closed correctly, that volume persisted across reload, that
sending a volume command via the real chat input did not increase the
rendered message-bubble count (proving it never reached Xiaozhi), that
mute/unmute correctly remembered the pre-mute level in memory, and that
two assistants maintained fully independent volumes across switches.
`npm run build` completed cleanly and zero console errors were observed.

**Deliberate design decision on mute memory:** the pre-mute volume is
held in memory only, not persisted — if the page reloads while muted,
"unmute" falls back to the saved/default volume rather than the exact
pre-mute value. This was a conscious choice to avoid growing the storage
schema for a rare edge case.

---

## Version 2.1 — Official Branding & Documentation

With Version 2.0 released and the multi-assistant platform stable, Olivia
still carried the visual identity of its original single-device ESP32
emulator days: a generic Font Awesome computer-chip icon and plain
`O.L.I.V.I.A.` text wherever the app needed to identify itself, no PWA
icon set, and its engineering history scattered across three separate
`HANDOFF_*.md` files written during Version 2 development. Version 2.1's
goal was to close that gap — transitioning Olivia from an ESP32 emulator
identity into a professionally branded AI platform — before Version 2.2
introduced Settings and Backup & Restore on top of that foundation. Two
pieces of work made up the release: a refactor of the Info tab into a
proper "About Olivia" page, and a full brand identity integration
(monogram, wordmark, favicon, PWA icons, manifest). A third, non-code
effort — restructuring the project's documentation — closed out the
release.

### About Page Refactor

**Objective:** The Info tab had started life as a single-device "Device
Identity" debug panel (`Device-Id`, `Client-Id`, pairing status, URLs) —
information that no longer made sense once every assistant had its own
independent identity and pairing state, already visible in that
assistant's own Settings panel. It needed to become a platform-level
"About Olivia" page.

**Implementation:**

- The old `#identityDisplay` block, which dumped one assistant's live
  identity values, was removed entirely.
- The redundant sidebar-level gear icon (`#settingsToggleBtn`) was also
  removed — every assistant already has its own per-item gear icon
  covering the same Settings panel for the active assistant, making the
  sidebar-level gear a duplicate entry point.
- The panel was rebuilt with: an updated multi-assistant-aware
  introduction; a two-column **Features** checklist; a three-column
  **Technology Stack** breakdown (Frontend / Backend / Communication); a
  rewritten, purely static **Protocol Summary** (no more live per-assistant
  values); a new **Assistant Architecture** section explaining that every
  assistant owns its own device ID, client ID, pairing token, WebSocket
  session, conversation history, avatar, volume, and settings — without
  displaying any live IDs; a new **System Status** section with
  aggregate, non-identifying live stats (registered assistant count,
  connected assistant count, total stored conversations, current theme);
  **Open Source** links; and a static **Version** block.
- `UIController.updateSystemStatusDisplay()` replaced the old
  `updateIdentityDisplay()`, computing its stats from already-public,
  read-only app state (`AssistantManager.getAllAssistants().length`, a sum
  over each session's connection status, a sum of conversation history
  lengths, and `ThemeManager.getCurrent()`), wrapped in a try/catch so a
  failure here could never block the Info tab or any other feature.
- `DeviceEmulator.getIdentityInfo()`, which had only ever been consumed by
  the removed `updateIdentityDisplay()`, was left in place as unused
  dead code rather than touching the `DeviceEmulator` module, per the
  scope constraint of this refactor.

**Testing:** Verified via static review and a clean `npm run build` (no
live browser click-through was performed in this pass, and that gap was
explicitly flagged as a follow-up recommendation at the time). Confirmed
no dangling references to any removed id/selector remained outside the
intentionally untouched `DeviceEmulator` module, and confirmed all three
Open Source links opened safely in a new tab.

**Recommendation noted at the time:** the Application Version string
("Olivia 2.0") was hardcoded directly in the page markup with no single
source of truth (e.g. a `package.json` version field) — flagged as a
good candidate for future cleanup.

### Brand Identity Integration

**Objective:** Replace the generic Font Awesome computer-chip icon and
the plain `O.L.I.V.I.A.` text branding throughout the app with an official
Olivia Monogram (a merged "ai" ligature) and Olivia Wordmark
("olivi**ai**"), without altering any layout, spacing, connection logic,
animation, or architecture — a pure branding integration.

**Implementation:**

- The source assets were a single Inkscape-exported SVG containing the
  full wordmark as one `<path>` with 12 continuous subpaths. The monogram
  was **extracted**, not redrawn: four specific subpaths (the "a" bowl,
  the ligature stroke, the inner counter, and the dot) were isolated
  using `svgpathtools`, taking each subpath's own emitted path-data string
  verbatim — no manual tracing or geometry changes. The wordmark file
  itself was left 100% geometrically identical to the source, with only
  `fill:#000000` changed to `fill:currentColor` so it inherits theme color.
- Both final SVGs (`monogram.svg`, `wordmark.svg`) render via a CSS `mask`
  + `background-color: currentColor` technique, so a single SVG file
  automatically adapts to both light and dark themes with no duplicate
  per-theme assets.
- A full icon set was generated and placed under `public/static/logo/`:
  `favicon.svg` (with its own `prefers-color-scheme`-aware `<style>`
  block, since page CSS variables aren't visible to browser chrome),
  `favicon-32.png`, `apple-touch-icon.png` (180×180), `icon-192.png`,
  `icon-512.png`, and a safe-zone-padded `maskable-512.png` for PWA
  installs.
- A new `manifest.json` was added (name, icons, `theme_color: #0084ff`,
  `display: standalone`), enabling installation to a device home screen.
- Every existing chip-icon insertion point was swapped for the monogram
  (sidebar avatar, chat welcome message, About page header, loading
  overlay) and every plain-text `O.L.I.V.I.A.` heading was swapped for the
  wordmark span — same DOM slots, same surrounding layout, only the
  artwork changed. The page `<title>` was normalized from `OLIVIA` to
  `Olivia`.
- All existing `.device-avatar` / `.status-dot` connection-state
  gradients and pulse animations (offline/connecting/connected/listening/
  speaking) were left completely untouched — the monogram simply renders
  inside the same colored, animated container the chip icon used to
  occupy.
- A **light-theme visibility bug found during this pass** was fixed
  along the way: the loading-screen monogram had been hardcoded to
  `color: #ffffff`, making it invisible against the light theme's white
  card background. Changed to `color: var(--primary)` so it reads as the
  brand blue correctly in both themes.

**Testing:** Clean `npm run build`; verified `HTTP/1.1 200 OK` from the
running dev server; verified all six in-app branding insertion points
were present in server-rendered HTML; verified the new logo/manifest/icon
assets served with correct content types; captured zero browser console
errors on page load; independently rendered both SVGs to PNG to visually
confirm the extracted monogram and wordmark were geometrically correct;
and confirmed no remaining `fa-microchip` references anywhere in the
codebase. A live cross-browser visual/screenshot comparison was flagged
as not performed in that session (no headless browser binary available)
and recommended as a manual follow-up.

### Documentation Restructuring

**Objective:** Version 2's engineering history had been captured as three
separate, standalone handoff documents — `HANDOFF_PHASE123.md`,
`HANDOFF_PHASE45.md`, and `HANDOFF_About-Page-Refactor.md` — written
incrementally as each phase shipped. Useful in the moment, but by the end
of Version 2 development they were a disconnected, non-chronological set
of files with no single entry point for a new contributor, and no
document at all describing the app's current architecture or a
user-facing changelog.

**Implementation:**

- The three `HANDOFF_*.md` files were consolidated into this single
  document, `DEVELOPMENT_HISTORY.md`, reorganized into one continuous
  chronological narrative (v1.0 → v1.1 → Version 2.0 phases → Version 2.1)
  and removed from the repository — their content lives on here.
- `CHANGELOG.md` was introduced as a concise, user-facing record of
  what changed release over release, intentionally kept separate from
  this document's engineering narrative.
- `ARCHITECTURE.md` was introduced as a static reference for how Olivia
  works **today** — module responsibilities, data flow, and the
  multi-assistant session model — independent of how it got there.
- `README.md` was substantially expanded: a "Brand Identity" section
  documenting the new logo assets and their theming technique, a
  reworked introduction reflecting the multi-assistant platform, and a
  new documentation cross-reference section pointing to `CHANGELOG.md`,
  `ARCHITECTURE.md`, and this file.
- Every remaining reference to the retired `HANDOFF_*.md` filenames
  elsewhere in the repository (README links, code comments) was updated
  to point at the new consolidated documents.

**Rationale:** With four purpose-built documents — a user-facing
changelog, a narrative development history, a static architecture
reference, and a setup/usage README — Olivia's documentation now mirrors
the separation of concerns already established in its codebase: each
document answers one question (*what changed* / *why does it look this
way* / *how does it work now* / *how do I use or run it*) instead of one
growing pile of phase-by-phase handoff notes.

---

## Version 2.2 — Settings & Backup

### Why Backup & Restore Was Introduced

Olivia stores all user data — assistants, conversations, avatars, volume
settings, pairing tokens, and device identities — in browser `localStorage`.
This is intentional: the app is fully client-side and requires no backend
database. However, `localStorage` is bound to a single browser profile on a
single device. Moving to a different browser, clearing browser storage, or
migrating to a new machine means losing all Olivia data.

Version 2.2 solves this with a complete Export / Import system. The export
captures every `olivia_*` and `xiaozhi_*` key from `localStorage` into a
versioned JSON envelope and triggers a browser download. The import reverses
the process: reads the file locally, validates it, asks for confirmation, and
restores all keys before reloading the app. Nothing is transmitted to a server.

The decision to enumerate all `olivia_*` / `xiaozhi_*` keys dynamically
(rather than maintaining an explicit inclusion list) was deliberate: it ensures
that any key added in a future version is automatically included in exports
without requiring a matching update to the backup code.

The `backupVersion` integer in the envelope enables future migration paths.
A future Olivia version that changes storage schema can inspect the
`backupVersion` of an incoming backup and run the appropriate transformations
before writing to `localStorage`, without breaking older backups.

### Migration from olivia-ai.pages.dev to www.oliviaai.dev

During the Version 2 cycle, Olivia moved from its initial Cloudflare Pages
deployment at `olivia-ai.pages.dev` to a custom domain, `www.oliviaai.dev`.
This migration was transparent to users at the protocol level — the Hono
Worker, proxy routes, and all Xiaozhi endpoints are domain-agnostic.

However, the migration highlighted a practical gap: users who had accumulated
assistants, conversation histories, and avatars on the old domain had no way
to carry that data to the new URL. Browser `localStorage` is scoped to the
origin (scheme + hostname + port), so `olivia-ai.pages.dev` and
`www.oliviaai.dev` each have completely separate storage.

The Export / Import feature introduced in v2.2 directly solves this class of
problem. A user can export their data from any Olivia URL and import it into
any other — same user on a different browser, different device, or different
domain. The versioned backup format ensures that a backup created on
`olivia-ai.pages.dev` (Olivia 2.0) can be imported into `www.oliviaai.dev`
(Olivia 2.2) without issues.

### Evolution of the Settings Interface

Olivia's settings have gone through three distinct phases:

**v1.0 — Single global settings panel.** There was one device, so there was
one settings panel. A gear icon in the sidebar header opened it. It contained
all device configuration: WebSocket URL, OTA URL, Device-Id, Client-Id,
protocol version, frame duration, listening mode, and audio toggles.

**v2.0 — Per-assistant settings, header gear icon removed.** When Olivia
became a multi-assistant platform, the old global gear icon was removed. Each
assistant in the sidebar list gained its own gear icon (revealed on hover),
opening a settings panel scoped exclusively to that assistant. The panel
retained all connection and protocol fields, but now also included the
assistant's name, avatar, and delete controls. A global gear icon in the
sidebar header was deemed redundant at the time (the active assistant's gear
icon in the list already served the same purpose) and was not included in v2.0.
The hover-only reveal of the per-assistant gear icon was flagged in Phase 3
as a mobile usability gap (touch devices have no hover state) but was not
revisited until v2.2.

**v2.2 — Global settings icon restored, with a clear separation.**
As Olivia matures, a distinction emerged between two kinds of settings:
*per-assistant configuration* (WebSocket URL, pairing, avatars, protocol) and
*app-level user preferences* (backup, future language, accessibility). The
v2.2 release restores the gear icon to the sidebar header, but wires it to a
new *global* Settings panel that contains only app-level settings. The
per-assistant gear icons in the assistant list remain unchanged and continue
to open the per-assistant settings panel as before. The two panels are
visually and functionally separate, ensuring users intuitively understand
where to find what.

The Info panel (accessible via the Info tab) was deliberately kept separate
from the Settings panel — it is read-only and informational, while Settings
is interactive. This separation was established in the About Page Refactor
and reinforced in v2.2.

### Touch-Friendly Per-Assistant Gear Icon

The hover-only per-assistant gear icon, unresolved since Phase 3, was
addressed in the same v2.2 cycle that restored the global Settings icon.
Rather than introducing new JavaScript state, the fix is purely CSS-driven,
using the `hover` media feature to distinguish real pointer devices from
touch:

- **Desktop (`@media (hover: hover)`)** — unchanged hover reveal on any
  assistant row, plus the active assistant's gear now also stays visible
  without requiring a hover, matching user expectation that "the assistant
  I'm currently using" is always adjustable.
- **Touch (`@media (hover: none)`)** — only the active/selected assistant's
  gear icon is shown; every other assistant in the list keeps its gear
  hidden. This avoids the alternative of showing every assistant's gear
  icon at once on mobile, which would clutter the list and looks
  inconsistent with the calm, minimal sidebar style established since v1.0.

Keyboard focus (`:focus-visible`) continues to reveal the gear regardless
of device, preserving existing accessibility behavior. No changes were made
to `AssistantManager`, `renderAssistantList()`, or the click handlers that
open the per-assistant settings panel — only the CSS visibility rules for
`.assistant-gear-btn` changed.

### Milestones in Version 2.2

| Milestone | Description |
|---|---|
| Global Settings button | Gear icon restored to sidebar header, beside theme toggle |
| Global Settings panel | Slide-in panel for app-level settings (separate from per-assistant panel) |
| BackupSystem module | New IIFE module in `app.js` handling export, import, validation, and restore |
| BackupStorage module | Thin `localStorage` wrapper for the Last Backup timestamp |
| Versioned backup format | `backupVersion` integer + `oliviaVersion` string for future migrations |
| Last Backup timestamp | Persisted after each export, displayed in human-readable form in Settings |
| Import confirmation modal | Required confirmation dialog before any data is overwritten |
| Info panel version bump | `Olivia 2.0` → `Olivia 2.2` in System Status |
| Storage label correction | `Local Browser Storage` → `Browser Local Storage` |
| Touch-friendly gear icon | `@media (hover: ...)` rules so the active assistant's gear is always reachable on touch devices, while desktop hover behavior is preserved |

---

## Recurring Design Principles

Several patterns repeat across every Version 2 phase and are worth calling
out explicitly for future contributors:

1. **Additive, not invasive, changes.** Every phase from Phase 1 onward
   was implemented by adding new modules or new exports alongside
   existing ones, rather than modifying existing function signatures or
   control flow. Each handoff document explicitly enumerated which
   existing modules were "not modified" — a discipline that kept the
   already-working protocol implementation stable through five phases of
   feature work.
2. **Storage-layer / logic-layer module pairs.** `AvatarStorage` +
   `AvatarSystem`, and later `VolumeStorage` + `VolumeSystem`, both follow
   the same shape: a small, try/catch-guarded `localStorage` persistence
   module, wrapped by a UI/logic module. New per-assistant features
   consistently followed this template rather than growing
   `AssistantManager`'s own schema.
3. **Shared hardware, scoped to "the active assistant."** Both the audio
   pipeline (mic/speakers) and the speech-volume gain node are singular,
   real hardware resources; every phase that touched them explicitly
   scoped changes to "only apply when this is the currently active
   assistant," rather than trying to virtualize hardware per assistant.
4. **Protocol stability as a hard constraint.** No phase of Version 2
   ever altered the Xiaozhi WebSocket handshake, OTA payload shape, binary
   Opus framing, or MCP message formats. New client-side behavior (like
   volume commands) was built by intercepting user input *before* it
   reached the protocol layer, not by inventing new protocol messages.
5. **Verification before handoff.** Every phase included an explicit
   testing section — either an automated harness, static review, or
   in-browser Playwright smoke testing — and every phase's handoff
   document explicitly listed known limitations rather than presenting
   the work as flawless.

---

## Future Ideas That Remain Relevant

These ideas were proposed across multiple phases and were still considered
worth pursuing at the time this history was written. They are not
commitments — see the Roadmap section of [README.md](./README.md#roadmap)
for the current, curated list — but are preserved here with their original
rationale for context:

- **Inline "Add Assistant" input** — replacing the `prompt()` dialog with
  an inline sidebar text input was proposed as early as Phase 3 and
  remained unimplemented through Phase 5.
- **Cloudflare R2-backed avatar storage** — `AvatarStorage`'s minimal
  three-method interface (`save`/`load`/`remove`) was deliberately kept
  swappable so a future phase could move avatar images to R2 (via new
  Hono routes) for cross-device sync, without any change to `AvatarSystem`
  or UI code. A concrete migration sketch (new `/api/avatars/:id` routes,
  a `localStorage` cache fallback) was drafted during Phase 4 but never
  implemented.
- **Server-driven volume control** — `VolumeSystem.handleClientAction()`
  is a fully-implemented but unwired handler for a hypothetical Xiaozhi
  `client_action` message using the protocol's existing, previously-unused
  `'custom'` message type. Wiring it up would need only one new
  `protocol.on('custom', ...)` listener.
- **Single source of truth for the application version string** — flagged
  during the About Page Refactor; the version currently displayed on the
  About page is a hardcoded string rather than being sourced from
  `package.json` or a shared constant.
- **Auto-reconnect assistants that were connected before a reload** — an
  intentional non-feature since Phase 2 (reconnecting is currently always
  a manual, explicit action), but noted repeatedly as a possible future
  convenience improvement.
- **Full avatar upload confirm modal** (preview → confirm → save) — CSS
  scaffolding for this exists from Phase 4, but the shipped flow remains
  single-step (pick file → auto-resize → save).
