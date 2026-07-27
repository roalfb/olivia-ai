# Changelog

All notable user-visible changes to Olivia are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Entries are organized by release/milestone and focus on **what changed for
users**, not implementation details. For engineering history and technical
decision-making, see [DEVELOPMENT_HISTORY.md](./DEVELOPMENT_HISTORY.md). For
the current architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Table of Contents

- [v2.0 — Multi-Assistant Platform](#v20--multi-assistant-platform)
- [v1.1 — Bug Fixes & Cloudflare Deployment](#v11--bug-fixes--cloudflare-deployment)
- [v1.0 — Initial Release](#v10--initial-release)

---

## v2.0 — Multi-Assistant Platform

Olivia grew from a single virtual ESP32 device into a full multi-assistant
platform. Every assistant is now an independent, isolated virtual device
under the hood, while the app presents them as a simple, unified roster of
named, avatared assistants.

### Added

- **Multi-assistant support** — create, rename, and delete unlimited
  independent assistants, each with its own connection, pairing state,
  device identity, conversation history, avatar, and speech volume
- **Instant assistant switching** — switching assistants never disconnects
  or reconnects any WebSocket; background assistants keep running
- **Per-assistant scoped settings panel** — a gear icon on each assistant
  opens settings for that specific assistant without switching the active view
- **Per-assistant profile pictures (avatars)** — upload a custom image per
  assistant; images are resized/re-encoded client-side to a 256×256 JPEG;
  a bundled default robot SVG is shown when no avatar is set
- **Per-assistant speech volume** — a speaker button in the chat header
  opens a live slider; volume can also be set via natural language
  ("lower your volume", "mute yourself", "set your volume to 60%")
  without ever contacting the Xiaozhi server
- **Manual light/dark theme toggle** — a ☀️/🌙 button in the sidebar lets
  users override the OS-level `prefers-color-scheme` preference; the
  choice persists across reloads
- **Official brand identity** — the Olivia Monogram and Wordmark ("olivi**ai**")
  SVG logos replace the generic chip icon and plain text branding across
  the sidebar, chat welcome message, About page, loading screen, favicon,
  and PWA install icon
- **PWA support** — web app manifest and icon set (192/512/maskable) so
  Olivia can be installed to a home screen
- **Redesigned About / Info page** — replaced the old single-device
  "Device Identity" debug panel with a platform-level page covering
  features, technology stack, protocol summary, assistant architecture,
  live system status (registered/connected assistant counts, stored
  conversation count, current theme), and open-source links

### Changed

- The app now always identifies itself as **O.L.I.V.I.A.** at the branding
  level; the previous per-device "Device Name" field was hidden from the
  UI in favor of a per-assistant display **name** and **avatar**
- The sidebar header's device gear icon was removed in favor of each
  assistant's own per-item gear icon (redundant entry point to the same
  Settings panel)
- Dark mode contrast for the active/selected assistant in the sidebar list
  was fixed (previously near-invisible light text on a light-blue background)

### Fixed

- Fixed a light-theme visibility bug where the loading-screen monogram was
  hardcoded to white and invisible against the light theme's background

---

## v1.1 — Bug Fixes & Cloudflare Deployment

### Added

- Initial Cloudflare Pages deployment
- Comprehensive project documentation and README banner

### Fixed

- **Microphone pipeline bug** — corrected an issue in the audio capture
  path that affected voice input reliability
- **Long text message rejection** — long typed messages are now
  automatically split into ≤80-character chunks at sentence boundaries
  before being sent, respecting the server's `listen{detect}` channel
  limit, and reassembled correctly by the LLM

---

## v1.0 — Initial Release

The first working release of Olivia: a browser-based virtual ESP32 device
emulator for the Xiaozhi AI platform.

### Added

- Full Xiaozhi WebSocket protocol implementation (`hello` handshake,
  `listen`, `stt`, `llm`, `tts`, `abort`, `system`, `alert`, `mcp`, `custom`)
- OTA provisioning and pairing flow (device registration, 6-digit
  activation code, polling)
- Real-time microphone capture and genuine Opus audio encoding via
  `libopus-wasm`, matching the ESP32 firmware's binary audio format
- Streaming text-to-speech playback with pre-scheduled, gapless audio
- Browser camera viewfinder (front/rear switching) and photo capture
- Gallery image upload with automatic JPEG conversion
- MCP (Model Context Protocol) tool-call architecture for vision
  (`self.camera.take_photo`)
- Server-side Hono proxy routes for WebSocket header injection, OTA, and
  vision upload — working around browser limitations that block these
  operations directly
- Messenger-style chat UI with streaming AI responses, typing indicator,
  and message history
- Automatic dark mode via `prefers-color-scheme`
- Protocol debug console with timestamped, color-coded log entries
- Device identity persistence (`Device-Id` / `Client-Id`) in `localStorage`
- Text-mode chat via the `listen{detect}` channel
- Responsive layout for mobile and desktop
