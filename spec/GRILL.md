# GRILL — Interview Assistant (personal Windows build)

Locked 2026-10-12. Pintu's decisions: **Windows only, personal use, Azure OpenAI**. Commercial parts (auth, billing, landing) deferred.

## 1. What is the one demo that proves it works?

A screen recording showing: (a) a LeetCode-style problem on screen, (b) hotkey pressed, (c) the transparent overlay appearing with a correct solution + explanation in under 10 seconds, (d) a simultaneous screen-share/recording that does NOT show the overlay.

## 2. Which platform?

**Windows only.** One OS, one stealth mechanism (WDA_EXCLUDEFROMCAPTURE — solid on Win 10 2004+). macOS deferred entirely, including the ScreenCaptureKit prototype.

## 3. Which LLM?

**Pintu's choice: OpenAI key OR Nvidia developer key** (no Azure credits). Both go through the `openai-compatible` provider in `src/main/providers.ts` — no code change needed:
- **OpenAI:** endpoint `https://api.openai.com/v1`, chatModel `gpt-4o`, whisperModel `whisper-1` — full features (vision solve + transcription).
- **Nvidia:** endpoint `https://integrate.api.nvidia.com/v1`, chatModel a vision model (e.g. `meta/llama-3.2-11b-vision-instruct`, `nvidia/nemotron-nano-12b-v2-vl`, or `moonshotai/kimi-k3`) — vision solve works; **transcription NOT available** (no Whisper on NIM; Riva ASR is a different API). The solve loop degrades gracefully to screenshot-only.
- Verified 2026-10-12: FastRouter (`openai/gpt-4o` + `whisper-1`) vision solve works end-to-end (Two Sum image → correct hash-map solution in 2.6s); Whisper transcription endpoint works.

## 4. Stealth mechanism on Windows?

Electron `win.setContentProtection(true)` → `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. Verified via Electron docs 2026-10-12. Known: bypass tools exist (obfuscation, not guarantee) — accepted for personal use.

## 5. What audio in v1?

Microphone only, 30s rolling buffer → Whisper (Azure OpenAI whisper deployment, or OpenAI Whisper API — whichever Pintu has). No system-audio loopback.

## 6. Monetization?

**Deferred.** Personal build: no auth, no Stripe, no credits. License key comes later if commercialized.

## 7. Where does the API key live?

Local config file (`~/.interview-assistant/config.json`, mode 600) read by the Electron main process. No backend in v1, so no proxy — acceptable because it's his own machine and his own key.

## 8. Distribution?

Unsigned local build for now (`electron-builder` portable/dir target). Code signing deferred until/unless he distributes.

## 9. Problem types in scope?

LeetCode-style coding problems only: screenshot → solution + explanation + complexity. System design / behavioral deferred.

## 10. Failure mode when the LLM is wrong/slow?

"Thinking…" state within 500ms; code-first presentation (start typing while reading); 25s timeout with clean "try a tighter screenshot" error, never a hang.

---

**NEEDS PINTU (2 items):** ① Azure OpenAI key + endpoint + deployment names (GPT-4o vision, Whisper) ② nothing else — build starts now.
