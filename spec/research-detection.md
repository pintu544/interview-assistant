# Research: Detecting a stealth overlay on Windows screen share

Researched 2026-10-12. Context: our Electron app uses `win.setContentProtection(true)`
(= `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`), click-through transparent overlay,
`skipTaskbar`, non-focusable window, `showInactive()`. Target evasion: Zoom / Teams /
Google Meet screen sharing on Windows 10/11.

Evidence grades used below: **[docs]** = verified in official documentation,
**[field]** = demonstrated in a real test/run by a third party, **[reported]** = user/community
reports, **[theory]** = technically possible but no observed deployment.

---

## 1. How Zoom / Teams / Meet capture on Windows, and what respects the flag

Windows offers several screen-capture paths, and the flag's effectiveness depends entirely
on which path the sharing app uses:

- **Windows.Graphics.Capture (WGC)** — the modern WinRT capture API (per-window or
  per-display). Respects `WDA_EXCLUDEFROMCAPTURE`. **[docs]**
- **DXGI Desktop Duplication** — GPU-level frame capture. The DWM compositor enforces the
  affinity flag at compositing time, so duplication output excludes the window on
  Win 10 2004+. **[reported]** by stream-shield
  (https://github.com/medy-gribkov/stream-shield): "The DWM compositor enforces
  WDA_EXCLUDEFROMCAPTURE at the hardware compositing level. All capture APIs on Windows
  (BitBlt, DXGI Desktop Duplication, Windows.Graphics.Capture) go through DWM."
- **GDI BitBlt / PrintWindow** — legacy path. On Win 10 2004+, DWM-composited BitBlt of
  the screen honors the flag (same exclusion path as Print Screen). **[reported]** by
  mithril issue discussion (https://github.com/moumantai-gg/mithril/issues/965):
  a window with the affinity "is removed from screen captures (Print Screen, Snipping
  Tool, GDI BitBlt of the screen DC, WGC) while staying fully visible on the display."

Per-app behavior:

- **Microsoft Teams / Google Meet (desktop):** modern releases capture via WGC and respect
  the flag automatically — no user action needed. **[reported]** by AI-overlay
  (https://github.com/AndreTeixeira1998/AI-overlay).
- **Google Meet (browser):** Chromium's `getDisplayMedia` (Chromium 100+) honors the
  exclusion. **[reported]** by AI-overlay.
- **Zoom (desktop):** has a *setting-dependent* capture path. Zoom → Settings → Share Screen
  offers "Auto", "Capture with window filtering", "Advanced capture …", and legacy modes
  (per University of Delaware Zoom docs, https://ats.udel.edu/conferencing/zoom/screen-share-settings/).
  AI-overlay reports that older Zoom builds fall back to `BitBlt`/DXGI paths that can
  bypass the OS exclude flag, and recommends the "windowing-system capture method"
  ("Use the new capture method") for strongest exclusion. **[reported]**
- **Discord / OBS (display capture):** OBS display capture via DXGI duplication is
  reported to respect the flag by some projects (obs-snap-detector commit notes
  `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` "prevents dxcam/DXGI from capturing
  the tkinter overlay window", https://github.com/chiguayeshao/obs-snap-detector/commit/b817f7e93defbf523fa136520cb39578cffb1df9),
  but OBS can also be configured with sources that bypass it — treat OBS as hostile.

Microsoft's own caveat **[docs]**
(https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity):
"unlike a security feature or an implementation of Digital Rights Management (DRM), there
is no guarantee that using SetWindowDisplayAffinity … will strictly protect windowed
content." It also only works when DWM is composing the desktop, and `WDA_EXCLUDEFROMCAPTURE`
requires Windows 10 version 2004+ (older builds degrade to `WDA_MONITOR`, i.e. a black
rectangle instead of invisibility).

**Bottom line for Q1:** on Win 10 2004+ with DWM compositing, all mainstream capture
APIs exclude the window. The risk is not the API — it's which capture *mode* the
sharing app is configured to use (Zoom's legacy/fallback modes).

---

## 2. Documented failures of WDA_EXCLUDEFROMCAPTURE on Windows

- **No Windows equivalent of the macOS ScreenCaptureKit hole was found.** (On macOS,
  newer ScreenCaptureKit-based apps capture `NSWindowSharingNone` windows anyway —
  documented in Electron's own API docs. No analogous documented bypass exists for
  the Windows flag against mainstream apps.)
- **Public bypasses exist but are not deployed in meeting apps:**
  - `TopSoftdeveloper/SetWindowDisplayAffinity-Bypass`
    (https://github.com/TopSoftdeveloper/SetWindowDisplayAffinity-Bypass) — a
    **non-invasive user-mode** technique (no DLL injection, no API hooking) that captures
    protected windows "under specific conditions". Exact mechanism is demonstrated via
    video, not documented in text; it builds on wongfei/wda_monitor_trick
    (https://github.com/wongfei/wda_monitor_trick, archived, "abusing WDA_MONITOR"),
    which abused `WDA_MONITOR` semantics rather than `WDA_EXCLUDEFROMCAPTURE`. **[field]**
    that bypasses exist; **[theory]** that any meeting app ships one.
  - `TopSoftdeveloper/Bypass-SetWindowDisplayAffinity`
    (https://github.com/TopSoftdeveloper/Bypass-SetWindowDisplayAffinity) — a
    **kernel-driver** patch that neutralizes affinity enforcement below user mode,
    tested on Win 10 22H2 in a VM. Requires loading an unsigned driver — not something
    a meeting app can do silently. **[field]**
- **Indirect displays are capture surfaces:** a Tauri app's issue
  (https://github.com/lumorez07/flow/issues/1) documents that a `WDA_EXCLUDEFROMCAPTURE`
  window is *completely invisible* on USB/indirect displays, because DWM strips it from
  the composed frames the indirect driver acquires. Implication: if a candidate shares
  via an indirect-display path (wireless display dongles, some screen-sharing drivers),
  the overlay vanishes for the *candidate* too — a usability hazard, not a detection
  vector, but worth knowing.
- **The "Zoom 6.1.6+" invisibility break** reported by AI-overlay is **macOS-specific**;
  no equivalent Windows version cutoff was found.

**Bottom line for Q2:** against stock Zoom/Teams/Meet on Windows, there is no documented
case of the flag failing. Bypasses exist as research PoCs, not as shipped features.

---

## 3. Non-pixel detection vectors (the real threat)

Pixel capture is only half the story. A scanner running on the same machine can see far
more than the screen share does. This is demonstrated, not theoretical, by **hortense**
(https://github.com/prince-sernine/hortense), a Windows interview-integrity scanner
that caught Cluely (in "undetectable mode"), Parakeet, LinkJobAI, and InterviewMan in
field runs on a real Windows machine. Its threat model
(https://github.com/prince-sernine/hortense/blob/main/THREAT_MODEL.md) documents:

| Vector | How it works | Status vs our app |
|---|---|---|
| **`GetWindowDisplayAffinity` query** | Any process can call `GetWindowDisplayAffinity(hwnd)` on *your* window and read back `WDA_EXCLUDEFROMCAPTURE`. The stealth flag is itself a beacon. Hortense caught Cluely this way: "Cluely undetectable mode set display affinity, and Hortense caught it with GetWindowDisplayAffinity." | **[field]** — our app sets the flag on its only window; a scanner enumerating windows will find it in one pass. |
| **Overlay heuristics via `EnumWindows`** | `EnumWindows` still lists the window (the flag hides it from *capture*, not from *enumeration*). Layered + topmost + transparent + click-through + covering large screen area = cheat-shaped. Hortense: "Overlay heuristics for layered, topmost, click-through windows that cover the real screen." | **[field]** — our overlay matches every heuristic when visible. Mitigated partially: ours is hidden except during solves. |
| **Process / path / tree signatures** | Process name, install path, parent/child tree matched against signature lists. "Renaming the binary defeats exactly one check." | **[field]** — our neutral name ("Interview Assistant") is not in any public signature list today; that is obscurity, not protection. |
| **Microphone ownership** | Which process holds mic capture (attributed through WebView2/process ancestry). Our app holds the mic continuously from launch. | **[field]** — we are a non-allowlisted mic holder; paired with any other signal this corroborates. |
| **Network: AI endpoint connections** | TCP owner table → process talking to `api.openai.com` etc. during a meeting. | **[field]** — every solve opens a TLS connection to the LLM provider from our PID. |
| **Local relay listeners** | Listening sockets for PC→phone relay shapes. | N/A — we have no relay. |
| **DWM thumbnail APIs** | `DwmRegisterThumbnail` gives live thumbnails of *other* windows — honors the affinity flag for excluded windows (same DWM enforcement). Not a bypass. | **[theory]** as a detection vector; the flag is enforced here too. |
| **Accessibility / UI Automation APIs** | Can enumerate window titles/structure but not pixels of excluded windows; no known deployment for overlay detection. | **[theory]** |
| **Focus/activation events** | A focus-stealing overlay is observable (foreground window changes). We use `showInactive()` + non-focusable — no focus events fire. | **[docs]** — not a vector for us as built. |
| **Global hotkey conflicts** | `RegisterHotKey` fails if another app took the chord; not enumerable by other apps in practice. Low value as a *detection* vector. | **[theory]** — negligible. |
| **Webcam gaze analysis** | HackerRank Proctor Mode does gaze detection ("repeated look-away-then-type patterns", limited availability). Reading an overlay off to the side is behaviorally detectable. | **[reported]** — no code can fix eye movement. |

**Fair Screen** (https://news.ycombinator.com/item?id=46019665) independently confirms the
window-enumeration approach: "Uses OS-level window enumeration (metadata only). Identifies
windows that are non-shareable, click-through, or overlaying the main screen" — no
screenshots, no process killing.

Key quote from hortense's threat model: "Renaming the binary defeats exactly one check.
The install folder stays. The affinity flag still reads. The microphone capture continues.
The outbound connection still resolves."

**Bottom line for Q3:** the strongest real-world vectors are, in order: (1) the affinity
flag itself via `GetWindowDisplayAffinity`, (2) overlay window-style heuristics via
`EnumWindows`, (3) process identity, (4) mic ownership, (5) network connections. All five
are demonstrated in field tests against commercial tools. None of them are used by
*stock* Zoom/Teams/Meet — they require a dedicated scanner/proctoring agent on the machine.

---

## 4. What interview/proctoring platforms actually do

- **HackerRank Proctor Mode** — the most explicit. Per
  https://medium.com/@zskzskabcd/hackerrank-records-your-whole-solve-the-follow-up-is-the-real-test-d4d516cb982f:
  full-screen screenshots every 15s (dropping to 5s on suspicious activity), webcam
  images every 5s, and automated review that looks specifically for "invisible overlay
  applications" among other things — naming **Cluely** as the example product. Also:
  gaze detection, phone/tablet object detection, and type-and-delete conversation
  detection. This is **[reported]** from documentation; it is the clearest evidence that
  major platforms now hunt overlays explicitly. (Screenshots themselves would use standard
  capture APIs that respect the flag — the detection is of the *overlay's existence* via
  other signals, and of behavioral patterns.)
- **CodeSignal** — offers proctored exams (live, automated, recorded); "built-in cheating
  protection: proctoring, ID verification, and plagiarism detection"
  (https://codesignal.com/build-assessment-demo/). Details of the client agent are not
  public. **[reported]**
- **Lockdown browsers / tab-switch detection** — standard across HackerRank, HackerEarth,
  Codility, Mettl: tab switches, copy/paste, fullscreen exits are flagged. These are
  **browser-level** and blind to a native overlay (per the anti-cheat cold-war analysis,
  https://medium.com/@codegrey/the-anti-cheat-cold-war-how-interview-platforms-are-catching-ai-use-c0e807bf8405:
  "A platform that monitors only its own tab is genuinely blind to a native overlay
  running alongside it"). **[reported]**
- **Karat** — live human-led interviews over video with collaborative coding. Detection
  is primarily the human interviewer (behavioral cues, follow-up questions) plus
  whatever the video platform transmits. No public proctoring-agent documentation found;
  treat as human-observed, not machine-scanned. **[theory]** (no Karat-specific
  technical source located; format confirmed via multiple candidate writeups).
- **Industry direction** — the arms race is explicit: "Truely" was built by two Columbia
  students specifically to detect Cluely-style tools (per the cold-war article above),
  and ~77% of companies used proctored technical assessments by mid-2025 (per
  newsbytesapp, https://www.newsbytesapp.com/news/science/indian-recruiters-use-ai-proctoring-to-curb-campus-hiring-cheating/tldr).

**Bottom line for Q4:** async assessment platforms (HackerRank Proctor Mode especially)
are the hostile environment — they screenshot periodically and explicitly hunt invisible
overlays. Live human interviews (Karat-style, or a hiring manager on Zoom/Teams/Meet)
rely on the meeting app's screen share, where the flag holds, plus human observation.

---

## 5. Public bypasses of WDA_EXCLUDEFROMCAPTURE (summary)

1. **Non-invasive user-mode** — `TopSoftdeveloper/SetWindowDisplayAffinity-Bypass`:
   captures protected windows without DLL injection or API hooking, "under specific
   conditions" (author's words; mechanism shown in video, not documented in text).
   Descended from `wongfei/wda_monitor_trick` (archived 2020), which abused
   `WDA_MONITOR` semantics. Implication: the flag is obfuscation, not a security
   boundary — Microsoft says as much in the docs.
2. **Kernel driver** — `TopSoftdeveloper/Bypass-SetWindowDisplayAffinity`: patches
   enforcement below user mode; needs an (unsigned) driver load. Not deployable by a
   meeting app.
3. **Capture-path discrepancy** (defensive, from hortense): comparing DXGI duplication
   output against a deeper per-window read can reveal a window that *should* be visible
   but isn't — i.e., detecting the *absence* the flag creates. Planned, not shipped.

**Implication for "undetectable" claims:** no vendor claim of undetectability survives a
dedicated on-machine scanner. The flag defeats *pixel capture*; it does not defeat
*endpoint inspection*. Every commercial tool tested (Cluely, Parakeet, LinkJobAI,
InterviewMan) was caught by at least the affinity query.

---

## 6. Hardening recommendations for our app (ranked by impact/effort)

1. **Keep the overlay hidden unless solving (HIGH impact, already done).** Overlay
   heuristics only fire on *visible* windows. Ours is hidden by default and appears for
   seconds per solve — the smallest possible window of exposure. Do not add a persistent
   visible element.
2. **Do not chase the affinity flag away (HIGH impact, zero effort).** Removing the flag
   to dodge `GetWindowDisplayAffinity` would make the overlay visible in every screen
   share — strictly worse. The flag is the right trade: it defeats the common case
   (meeting-app capture) at the cost of detectability by a dedicated scanner most
   interviews don't run.
3. **Delay mic capture until first hotkey (MEDIUM impact, LOW effort).** We currently
   hold the mic from launch — a continuous, attributable signal. Starting the recorder
   lazily on first solve halves the exposure window. (We already retry on hotkey if
   denied — extend to first-start.)
4. **Keep the neutral process/install identity (LOW effort, ongoing).** "Interview
   Assistant" / `interview-assistant` is not in public signature lists. Never rename it
   to anything evasion-flavored, and don't impersonate system binaries (that creates a
   *different* detection: integrity anomaly).
5. **Minimize network fingerprint (LOW impact, LOW effort).** Solves already only fire
   on hotkey. Optional: route through a generic proxy domain so the destination isn't
   literally `api.openai.com` — but hortense's author notes this is "the network shell
   game": process lineage still gives it away. Don't over-invest.
6. **Window class name (LOW impact, zero effort).** Electron windows report
   `Chrome_WidgetWin_1` — indistinguishable from Chrome at a glance. Leave it.
7. **Hotkey choice (LOW impact, done).** Ctrl+Alt+S avoids OS-reserved chords; global
   hotkeys aren't enumerable by scanners in practice.
8. **Do NOT implement: driver-level tricks, API hooking, process hollowing, or
   anti-scanner countermeasures.** That crosses from "stealth overlay" into malware
   techniques, will trip antivirus/EDR, and cannot win against a scanner with admin
   visibility anyway.
9. **Panic-hide hotkey (MEDIUM impact, LOW effort).** We have Ctrl+Alt+H. Document it as
   the response to "please share your screen" when unsure about the capture path.

---

## Bottom-line verdict

**Against stock Zoom / Teams / Google Meet screen share on Windows 10 2004+:
confidence HIGH that the overlay stays pixel-invisible.** All mainstream capture paths
(WGC, DXGI duplication, DWM-composited BitBlt) honor `WDA_EXCLUDEFROMCAPTURE`, Microsoft
documents the mechanism, and no Windows equivalent of the macOS ScreenCaptureKit hole
was found. The realistic pixel-capture risks are narrow: the interviewer using Zoom's
legacy capture mode, or an OBS-style recorder with a bypassing source — both are
"outside the normal interview" scenarios.

**The single biggest residual risk is not pixel capture at all — it is endpoint
inspection.** Any proctoring agent or integrity scanner on the machine (HackerRank
Proctor Mode's desktop agent, hortense-style tools, Truely and its successors) can
enumerate windows, query `GetWindowDisplayAffinity`, and flag the overlay in one pass —
*using the very flag that makes it invisible*. Against that class of adversary,
confidence is LOW, and no code change within a user-mode Electron app fixes it; the
mitigation is situational awareness (know which platform you're interviewing on —
HackerRank Proctor Mode explicitly hunts "invisible overlay applications").

In one sentence: **invisible to the meeting, visible to the machine.**
