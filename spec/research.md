# Research — Interview Assistant (InterviewCoder clone)

Researched 2026-10-12. All findings filed here per spec-driven rule 12.

## 1. Stealth overlay primitives (Electron)

**Source:** Electron docs — `BrowserWindow` API (`win.setContentProtection`, `win.setIgnoreMouseEvents`), verified 2026-10-12 via electronjs.org and electron/electron GitHub.
- `win.setContentProtection(true)`:
  - **Windows:** calls `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. On Windows 10 2004+ the window is removed from capture entirely; older versions render it black.
  - **macOS:** sets `NSWindow.sharingType = NSWindowSharingNone`.
  - ⚠️ **Known limitation (macOS):** "due to an intentional change in macOS, newer Mac applications that use ScreenCaptureKit will capture your window despite `win.setContentProtection(true)`." This directly threatens the "invisible to screen share on Mac" claim on newer macOS versions.
- `win.setIgnoreMouseEvents(true)` — click-through overlay; mouse events pass to the window below. Standard, reliable on macOS + Windows.
- `win.setAlwaysOnTop(true)`, `transparent: true`, `frame: false` — the standard overlay recipe.
- **Bypass risk:** public repos (e.g. TopSoftdeveloper/SetWindowDisplayAffinity-Bypass) demonstrate non-invasive capture of `WDA_EXCLUDEFROMCAPTURE` windows without DLL injection. Stealth is obfuscation, not a guarantee — interview platforms can and do build detection.

**Implication:** Electron covers ~90% of the stealth requirements with built-in APIs. The macOS ScreenCaptureKit gap is the top technical risk — needs a throwaway prototype on a real Mac before committing to "undetectable on Mac" claims.

## 2. Screen capture

- Electron `desktopCapturer.getSources({ types: ['screen'] })` — standard, works macOS/Windows. Returns thumbnails or full-res streams.
- For cropping a region (the code editor area), capture full screen then crop in the renderer/main process with Sharp or canvas. Keeps it simple; no native modules.

## 3. Audio transcription

- Mic audio → OpenAI Whisper API (`whisper-1`) or local whisper.cpp. API is simpler for v1; local is a later optimization for latency/cost.
- **System-audio capture (interviewer's voice):** macOS requires ScreenCaptureKit audio tap or a virtual audio driver (e.g. BlackHole); Windows needs WASAPI loopback. This is the hardest part of the audio pipeline — v1 should do **mic-only** (candidate repeats/paraphrases or the interviewer's audio comes through speakers into mic), with system-audio as a later slice.

## 4. Vision LLM for solving

- GPT-4o / GPT-4o-mini via OpenAI API: best-in-class for screenshot → code solutions. InterviewCoder markets "most powerful fine tuned AI models."
- Pricing (Oct 2026, verify at ship time): GPT-4o ~$2.50/$10 per 1M tokens in/out; a screenshot (~1-2k tokens image) + solution round-trip ≈ $0.01–0.03 per solve. At 1,000 credits/month/user, API cost per heavy user ≈ $10–30/mo — pricing must cover this.
- Alternative: Anthropic Claude (strong at code), Nebius (Pintu already has a key — check vision model availability; could cut costs significantly).

## 5. Hiding from dock / taskbar / activity monitor

- macOS: `app.dock.hide()` + `LSUIElement: true` in Info.plist removes dock icon. Process still visible in Activity Monitor under its real name — disguising the process name further requires renaming the binary/bundle identifier (cosmetic, easily defeated).
- Windows: `win.setSkipTaskbar(true)` hides taskbar; tray icon simply not created. Task Manager still lists the process.
- Honest assessment: "invisible in activity monitor" is marketing — a determined checker finds the process. These are speed bumps, not invisibility.

## 6. Distribution & signing

- **macOS:** Apple Developer Program ($99/yr) required for Developer ID signing + notarization; without it, Gatekeeper blocks the app on other Macs.
- **Windows:** code-signing certificate (~$200–400/yr) to avoid SmartScreen warnings.
- **Auto-update:** electron-updater + a static file host (S3/GitHub Releases) — standard.
- Without signing, distribution is "download → right-click open" friction. Signing is a ship requirement, not a nice-to-have.

## 7. Reference product notes (interviewcoder.co, observed 2026-10-12)

- Pricing: Free download (explore only) → Monthly Pro $299/mo (1,000 credits) → Lifetime $799 one-time (unlimited).
- Feature surface: audio support, 20+ undetectability features, LeetCode + system design + "all kinds of interviews."
- Testimonials lean heavily on FAANG offers; marketing is aggressive ("Got Meta and Google offers even though I failed all my CS classes!").
- FAQ contact: abdulla@interviewcoder.com. No public API docs.

## 8. Stack decision inputs

- **Electron + React + TypeScript:** one codebase for Mac + Windows; all stealth APIs needed are built-in except the macOS ScreenCaptureKit gap. Rejected Tauri (smaller binary, but we'd hand-roll more native code for the same stealth surface).
- **Backend:** Node.js (Fastify) — same language as the desktop client; handles auth, subscriptions (Stripe), and LLM proxying (keys never ship in the client).
- **Landing:** Next.js (Pintu's stack; SSR for SEO — "searchable" requirement).
- **DB:** PostgreSQL (users, subscriptions, usage credits) — Pintu's standard.
