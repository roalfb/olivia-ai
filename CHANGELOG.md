# Changelog

All notable user-visible changes to Olivia are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Entries are organized by release/milestone and focus on **what changed for
users**, not implementation details. For engineering history and technical
decision-making, see [DEVELOPMENT_HISTORY.md](./DEVELOPMENT_HISTORY.md). For
the current architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Table of Contents

- [v2.2 — Settings, Backup & Restore](#v22--settings-backup--restore)
- [v2.1 — Official Branding & Documentation](#v21--official-branding--documentation)
- [v2.0 — Multi-Assistant Platform](#v20--multi-assistant-platform)
- [v1.1 — Bug Fixes & Cloudflare Deployment](#v11--bug-fixes--cloudflare-deployment)
- [v1.0 — Initial Release](#v10--initial-release)

---

## v2.2 — Settings, Backup & Restore

Olivia 2.2 introduces a dedicated Settings interface, complete
Backup & Restore functionality, and several UI refinements.

### Added

- **Settings icon** — a gear (⚙️) button now appears in the sidebar
  header beside the existing Light/Dark mode toggle; clicking it opens
  the new global Settings panel
- **Global Settings panel** — a slide-in panel separate from the
  per-assistant settings; contains app-level user preferences starting
  with Backup & Restore; designed to accommodate future options (Language,
  Accessibility, Reset Application, Experimental Features)
- **Export Olivia Data** — exports every piece of persistent Olivia data
  (assistants, conversations, avatars, volume settings, device identities,
  pairing tokens, themes, OTA/WebSocket settings, and all other
  `olivia_*`/`xiaozhi_*` localStorage keys) to a single, versioned JSON
  file named `Olivia-Backup-YYYY-MM-DD.json`
- **Versioned backup format** — backups include `backupVersion`,
  `oliviaVersion`, and `createdAt` fields; designed so future Olivia
  versions can migrate older backups without data loss
- **Import Olivia Data** — accepts a previously exported JSON backup;
  validates the file format and required fields before proceeding; shows
  an explicit confirmation prompt before overwriting any data; reloads
  Olivia automatically after a successful restore
- **Last Backup timestamp** — each successful export records the time in
  `localStorage`; the Settings panel displays it in a human-readable
  format (`Jul 28, 2026 • 9:42 PM`) or "Never" if no backup exists

### Changed

- **Info panel — Application Version** updated from `Olivia 2.0`
  to `Olivia 2.2`
- **Info panel — Storage** label corrected to `Browser Local Storage`
  (was `Local Browser Storage`) for consistency with standard terminology
- **Touch-friendly assistant gear icon** — each assistant's settings gear
  icon used to be revealed only on hover, which touch devices cannot
  trigger. On desktop (`hover: hover`), hovering an assistant still reveals
  its gear icon exactly as before, and the active assistant's gear icon
  also stays visible without needing to hover it. On touch devices
  (`hover: none`), only the currently active/selected assistant's gear
  icon is shown; every other assistant's gear stays hidden, so settings
  remain reachable on mobile without cluttering the list with every icon
  at once

### Responsibility separation

- The **Info panel** (accessible via the Info tab) remains purely
  informational — About, Features, Technology Stack, Architecture,
  Protocol, System Status, Open Source, Documentation.
- The **Settings panel** (gear icon) is interactive — Backup & Restore
  and future user preferences. These two panels do not duplicate content.

---

## v2.1 — Official Branding & Documentation

Olivia 2.1 is a branding and documentation release. No protocol, feature,
or architectural behavior changed — every update in this release is
visual identity or documentation, refining the multi-assistant platform
introduced in v2.0 into a professionally branded product.

### Added

- **Official Olivia Monogram and Wordmark** — a new merged "ai" ligature
  monogram and an "olivi**ai**" wordmark, both delivered as unmodified
  SVG assets, replace the generic Font Awesome computer-chip icon and the
  plain `O.L.I.V.I.A.` text branding across the sidebar header, chat
  welcome message, About page, and loading screen
- **Updated favicon and full PWA icon set** — a new brand-aware
  `favicon.svg` (with its own `prefers-color-scheme`-aware styling,
  since page CSS variables aren't visible to browser chrome),
  `favicon-32.png`, `apple-touch-icon.png` (180×180), `icon-192.png`,
  `icon-512.png`, and a safe-zone-padded `maskable-512.png` for PWA
  installs — all placed under the new `public/static/logo/` directory
- **Web App Manifest** (`manifest.json`) — name, icon set, `theme_color`,
  and `display: standalone`, enabling Olivia to be installed to a device
  home screen with the new brand icon
- **Theme-aware logo rendering** — both `monogram.svg` and `wordmark.svg`
  render via a CSS `mask` + `background-color: currentColor` technique,
  so a single SVG file automatically adapts between light and dark
  themes with no duplicate per-theme assets
- **Restructured project documentation** — introduced `README.md`,
  `CHANGELOG.md`, `ARCHITECTURE.md`, and `DEVELOPMENT_HISTORY.md` as the
  project's permanent documentation set; added a "Brand Identity" section
  to the README covering the new logo assets and their theming technique

### Changed

- **About page branding** — the About page header now displays the
  Olivia Wordmark instead of the plain-text `O.L.I.V.I.A.` heading
- **Sidebar branding** — the sidebar's device avatar now displays the
  Olivia Monogram instead of the generic chip icon, and the device name
  label now renders the Olivia Wordmark
- Browser tab `<title>` normalized from `OLIVIA` to `Olivia`

### Removed

- **Retired the HANDOFF documents** — `HANDOFF_PHASE123.md`,
  `HANDOFF_PHASE45.md`, and `HANDOFF_About-Page-Refactor.md` were merged
  into the new `DEVELOPMENT_HISTORY.md` and removed from the repository;
  their content lives on in that consolidated history

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
