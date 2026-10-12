# SPEC — Interview Assistant (personal Windows build)

## Problem

Candidates freeze on live coding problems under interview pressure — not from lack of knowledge, but from performance anxiety and blank-page panic. Existing tools either require visible browser tabs (detectable on screen share) or give generic chatbot answers with no awareness of what's on screen. There is no fast, screen-aware assistant that stays invisible during screen-shared interviews.

## Users

- **Pintu** (v1): using it himself in live technical interviews on Windows.

## Functional requirements

1. The system SHALL display a transparent, always-on-top overlay window that renders AI-generated solutions.
2. The system SHALL capture a screenshot of the screen on a global hotkey press.
3. The system SHALL send the screenshot to Azure OpenAI GPT-4o (vision) and stream back a solution (code + explanation + time/space complexity).
4. The system SHALL show a "thinking…" state within 500ms of the hotkey press.
5. The system SHALL deliver the complete solution in under 25 seconds or show a clean timeout error.
6. The system SHALL exclude the overlay from screen capture/sharing via `setContentProtection(true)` (WDA_EXCLUDEFROMCAPTURE).
7. The system SHALL be click-through (mouse events pass to underlying windows) and toggleable via hotkey.
8. The system SHALL hide its taskbar icon and run without a visible tray icon.
9. The system SHALL transcribe microphone audio (Whisper) and include recent transcript as context for follow-up questions.
10. The system SHALL read LLM credentials from a local config file (mode 600), never hardcoded. The config selects the provider: `azure` or `openai-compatible` (FastRouter/OpenAI).

## Non-functional requirements

- **Performance:** hotkey → "thinking" ≤ 500ms (p95); hotkey → full solution ≤ 25s (p95) on broadband.
- **Readability/maintainability:** TypeScript strict mode; ESLint + Prettier; single-responsibility modules with header comments.
- **Security:** API keys only in the local config file; never in source, never in the packaged renderer.

## Out of scope (personal build)

- Backend server, user auth, license keys, usage credits, Stripe, landing page — all deferred to a commercial phase.
- macOS / Linux support.
- System-audio loopback capture.
- System design and behavioral interview modes.
- Code signing (unsigned local build).
- Guaranteed undetectability — best-effort obfuscation, documented as such.
