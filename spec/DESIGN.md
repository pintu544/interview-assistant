# DESIGN — Interview Assistant (personal Windows build)

## Architecture

Single deployable. No backend in v1 — the Electron main process calls Azure OpenAI directly with the user's own key from local config.

```
┌──────────────────────────────────────────────┐
│            DESKTOP APP (Electron)            │
│  ┌────────────────────────────────────────┐  │
│  │ Overlay (React)                        │  │
│  │ transparent, frameless, always-on-top, │  │
│  │ click-through, content-protected       │  │
│  └──────────────────┬─────────────────────┘  │
│                     │ IPC                    │
│  ┌──────────────────▼─────────────────────┐  │
│  │ Main process                           │  │
│  │ • global hotkeys                       │  │
│  │ • screenshot (desktopCapturer)         │  │
│  │ • mic capture (30s rolling buffer)     │  │
│  │ • Azure OpenAI client (GPT-4o vision,  │  │
│  │   Whisper) — key from ~/.interview-    │  │
│  │   assistant/config.json (600)          │  │
│  │ • streaming SSE → overlay              │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**Core loop:** hotkey → capture screenshot → `chat.completions.create` with image + solver prompt → stream deltas to overlay → render markdown incrementally.

## Key decisions

- **Electron over Tauri:** stealth primitives built-in (`setContentProtection`, `setIgnoreMouseEvents`, `setSkipTaskbar`). Rejected Tauri (hand-rolled native modules for the same surface).
- **No backend in v1:** personal build — the key lives on his own machine, so a proxy buys nothing. Rejected the Fastify proxy until commercialization.
- **Azure OpenAI (not OpenAI direct):** Pintu provides it; GPT-4o vision confirmed working on Azure; same SDK shape.
- **Streaming via SSE/chunks:** incremental markdown render so the candidate reads while it generates.
- **No screenshot persistence:** screenshots live in memory only, never written to disk. Privacy by design.

## Risks

1. **WDA_EXCLUDEFROMCAPTURE bypasses exist** (research.md §1). Accepted: personal use, best-effort.
2. **LLM latency spikes.** Mitigated: 25s timeout, instant "thinking" state, GPT-4o-mini fallback config flag.
3. **Whisper lag on long audio.** Mitigated: 30s rolling windows, mic-only.
