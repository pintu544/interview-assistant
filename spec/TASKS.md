# TASKS — Interview Assistant (personal Windows build)

## Slice 1 — Core solve loop (the demo)

- [ ] **T1.1** Electron scaffold: TS + React + Vite, main/renderer split, ESLint + Prettier strict. *Done means: `npm run dev` opens a window; lint passes.*
- [ ] **T1.2** Overlay window: transparent, frameless, always-on-top, `setIgnoreMouseEvents(true)`, `setContentProtection(true)`, hotkey (Ctrl+Shift+Space) to show/hide. *Done means: overlay floats, clicks pass through, hotkey toggles.*
- [ ] **T1.3** Screenshot capture: `desktopCapturer` grab on hotkey, downscale ≤1568px, base64. *Done means: hotkey → base64 PNG in <1s.*
- [ ] **T1.4** Azure OpenAI client in main process: config file reader (`~/.interview-assistant/config.json`), GPT-4o vision call with solver prompt, streamed response. *Done means: test image → streamed markdown (needs Pintu's Azure key).*
- [ ] **T1.5** Wire overlay to solver: "thinking…" ≤500ms, incremental markdown render, 25s timeout with clean error. *Done means: **THE DEMO** — problem on screen → hotkey → solution streams in <25s.*
- [ ] **T1.6** Adversarial QA pass on Slice 1 (fresh subagent) + fix criticals.

## Slice 2 — Audio context

- [ ] **T2.1** Mic capture: 30s rolling buffer, WAV encode. *Done means: 30s of mic audio → playable file.*
- [ ] **T2.2** Whisper transcription (Azure) → text. *Done means: audio in → accurate transcript.*
- [ ] **T2.3** Transcript as solve context + "listening" indicator in overlay. *Done means: spoken question influences solution.*
- [ ] **T2.4** Adversarial QA pass on Slice 2 + fix criticals.

## Slice 3 — Stealth hardening (Windows)

- [ ] **T3.1** Hide taskbar icon (`setSkipTaskbar`), no tray icon, neutral bundle/binary name. *Done means: Task Manager shows neutral name; no taskbar/tray presence.*
- [ ] **T3.2** Screen-share invisibility verification: record via Teams/Meet/Zoom screen share; overlay must not appear. *Done means: recordings reviewed, overlay absent.*
- [ ] **T3.3** `electron-builder` portable build; app launches from a folder, no installer needed. *Done means: double-click runs it.*
- [ ] **T3.4** Adversarial QA pass on Slice 3 + fix criticals.

## Deferred (commercial phase)

Backend, auth/licenses, Stripe, landing page, macOS, code signing, system-audio loopback, system-design mode.

## Dependency notes

- T1.4 needs Pintu's Azure key + endpoint + deployment names before it can be verified live (scaffold it with a mock first).
- T3.2 needs a Windows machine with Teams/Meet — Pintu verifies, or we document the check for him.
