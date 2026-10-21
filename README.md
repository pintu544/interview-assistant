# Interview Assistant (personal Windows build)

[![CI](https://github.com/pintu544/interview-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/pintu544/interview-assistant/actions/workflows/ci.yml)

Screen-aware AI assistant: press a hotkey on a coding problem, get a streamed solution in a stealth overlay. Screen-share hiding is **best effort**: Windows, Electron, and the meeting application can differ, so verify it in the exact app and sharing mode you use.

## Setup (Windows)

1. Install **Node.js 22.12+** from https://nodejs.org.
2. Clone this repo, then run `cd app`, `npm ci`, and `npm run build`. Use a full install; Electron is a development dependency.
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
   For Nvidia (which does not provide the transcription path), set `"transcriptionEnabled": false` and omit `whisperModel`:
   ```json
   { "provider": "openai-compatible", "endpoint": "https://integrate.api.nvidia.com/v1", "apiKey": "YOUR-NVIDIA-KEY", "chatModel": "meta/llama-3.2-11b-vision-instruct", "transcriptionEnabled": false }
   ```
4. Run `npm run dev` during development or `npm run dist` for the portable executable.

## Hotkeys

| Hotkey | Action |
|---|---|
| Ctrl+Alt+S | Capture screen + solve |
| Ctrl+Alt+H | Show / hide overlay |
| Ctrl+Alt+I | Enable mouse scrolling; press again to restore click-through |
| Ctrl+Alt+Q | Quit |

## Security and privacy

Screenshots and optional microphone audio are sent to the configured LLM provider and are not stored by this app. Keep API keys in the user config, never in source control. The overlay uses context isolation, disables renderer Node integration, and applies Electron content protection, but content protection is not a guarantee against every capture path. On POSIX, config files should be created with mode `0600`; Windows does not expose equivalent POSIX modes, so protect the file with Windows ACLs and a private user profile.

The build toolchain currently includes an unpatched transitive `sprintf-js` denial-of-service advisory ([GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)); `npm audit` reports multiple affected dependency paths. These packaging tools are not included in the packaged app. Do not pass untrusted formatting input to the build tools. A forced packager downgrade has not been applied because that needs separate compatibility validation.

## Validation

Run `npm run lint`, `npm run format:check`, and `npm test` for type checks, production build, and regression tests. Tests use mock providers, screen sources, and audio devices; they do not prove live model quality, audio codec compatibility, meeting-app capture protection, or Windows hotkey behavior. The Windows CI workflow also builds the portable executable. Complete the manual checks below before relying on a release.

## Manual Windows checklist

- Confirm the portable build starts and `Ctrl+Alt+S`, `Ctrl+Alt+H`, `Ctrl+Alt+I`, and `Ctrl+Alt+Q` work.
- Test screen sharing in Teams, Meet, and Zoom with both full-screen and window sharing; treat hiding as best effort.
- Confirm microphone permission, an Nvidia config with transcription disabled, and a normal transcription-enabled config.
- Verify the app does not log or commit API keys, and that Windows ACLs restrict the config file.

Unsigned portable builds may trigger Windows SmartScreen; use **More info → Run anyway** only when you trust the build source.
