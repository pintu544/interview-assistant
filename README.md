# Interview Assistant (personal Windows build)

Screen-aware AI assistant: press a hotkey on any coding problem, get a streamed solution in a stealth overlay that's invisible to screen share.

## Setup (Windows)

1. Install Node.js 20+ from https://nodejs.org
2. Clone this repo, then:
   ```
   cd app
   npm install
   npm run build
   ```
3. Create `%USERPROFILE%\.interview-assistant\config.json`:
   ```json
   {
     "provider": "openai-compatible",
     "endpoint": "https://api.openai.com/v1",
     "apiKey": "YOUR-OPENAI-KEY",
     "chatModel": "gpt-4o",
     "whisperModel": "whisper-1"
   }
   ```
   Nvidia alternative (free tier, no transcription):
   ```json
   {
     "provider": "openai-compatible",
     "endpoint": "https://integrate.api.nvidia.com/v1",
     "apiKey": "YOUR-NVIDIA-KEY",
     "chatModel": "meta/llama-3.2-11b-vision-instruct",
     "whisperModel": "whisper-1"
   }
   ```
4. Run: `npx electron .` (dev) or build the portable exe: `npm run dist`

## Hotkeys

| Hotkey | Action |
|---|---|
| Ctrl+Alt+S | Capture screen + solve (transcribes last 30s of mic too) |
| Ctrl+Alt+H | Show / hide overlay |
| Ctrl+Alt+Q | Quit |

## First-run checks

1. Press Ctrl+Alt+S on a LeetCode problem → solution streams into the overlay in seconds.
2. Screen-share check: share your screen on Teams/Meet/Zoom and confirm the overlay is NOT visible to viewers.
3. Mic: the header dot pulses red when the mic is live.

## Notes

- The overlay never takes keyboard focus — keep typing in your editor.
- Screenshots are sent to your LLM provider; nothing is stored.
- No installer: the portable exe runs from any folder.
- Unsigned build → Windows SmartScreen will warn on first launch ("More info" → "Run anyway").
