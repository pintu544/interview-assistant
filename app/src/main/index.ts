import { app, BrowserWindow, globalShortcut, ipcMain, screen, session } from 'electron';
import path from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '../shared/ipc';
import { captureScreen } from './capture';
import { loadConfig } from './config';
import { createProvider } from './providers';

// Main process: owns the overlay window, global hotkeys, screenshot capture,
// and Azure OpenAI calls. Renderer is dumb by design.

let overlay: BrowserWindow | null = null;
let solving = false;

// Ctrl+Alt chords: avoids the Windows Ctrl+Shift input-language switcher.
const HOTKEY_SOLVE = 'CommandOrControl+Alt+S';
const HOTKEY_TOGGLE = 'CommandOrControl+Alt+H';
const HOTKEY_QUIT = 'CommandOrControl+Alt+Q';
const SOLVE_TIMEOUT_MS = 25_000;

function createOverlay(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(560, width - 40);
  const win = new BrowserWindow({
    width: w,
    height: Math.min(700, height - 40),
    x: width - w - 24,
    y: 24,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    focusable: false, // overlay never takes keyboard focus (stealth + typing flow)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Stealth primitives: invisible to screen capture, click-through.
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
}

function toggleOverlay() {
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide();
  else overlay.showInactive();
}

function showOverlayInactive() {
  // showInactive: visible without stealing focus from the code editor.
  overlay?.showInactive();
}

function hotkeyError(accelerator: string): void {
  showOverlayInactive();
  overlay?.webContents.send(IPC.SOLVE_DONE, {
    ok: false,
    error: `Hotkey ${accelerator} is already taken by another app. Close it or change HOTKEY_* in src/main/index.ts.`,
  });
}

function registerHotkey(accelerator: string, handler: () => void): void {
  const ok = globalShortcut.register(accelerator, handler);
  if (!ok) hotkeyError(accelerator);
}

async function waitForLoad(): Promise<void> {
  if (!overlay || !overlay.webContents.isLoading()) return;
  await new Promise<void>((resolve) =>
    overlay?.webContents.once('did-finish-load', () => resolve()),
  );
}

/** Ask the renderer for the last ~30s of mic audio. '' when unavailable. */
function requestRecentAudio(): Promise<string> {
  return new Promise((resolve) => {
    if (!overlay) return resolve('');
    const requestId = randomUUID();
    const onResponse = (_e: unknown, payload: { requestId: string; base64: string }) => {
      if (payload.requestId !== requestId) return;
      clearTimeout(timeout);
      ipcMain.removeListener(IPC.AUDIO_RESPONSE, onResponse);
      resolve(payload.base64 ?? '');
    };
    const timeout = setTimeout(() => {
      ipcMain.removeListener(IPC.AUDIO_RESPONSE, onResponse);
      resolve('');
    }, 5000);
    ipcMain.on(IPC.AUDIO_RESPONSE, onResponse);
    overlay.webContents.send(IPC.AUDIO_REQUEST, { requestId });
  });
}

async function runSolve() {
  if (!overlay || solving) return;
  solving = true;

  await waitForLoad();
  // New solve: clear stale output and flip to "thinking" IMMEDIATELY
  // (spec: hotkey → thinking ≤ 500ms).
  overlay.webContents.send(IPC.SOLVE_START);
  showOverlayInactive();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLVE_TIMEOUT_MS);

  try {
    const cfg = loadConfig();
    const provider = createProvider(cfg);

    // Screenshot and audio fetched in parallel — the screenshot stays
    // hotkey-fresh instead of going stale behind the audio roundtrip.
    // Mic audio → transcript. Non-fatal for 5xx/network/timeout, but 4xx
    // means the key/deployment config is broken — surface that loudly.
    let transcript: string | undefined;
    const [shot, audioBase64] = await Promise.all([captureScreen(), requestRecentAudio()]);
    try {
      if (audioBase64) {
        transcript = await provider.transcribe(
          Buffer.from(audioBase64, 'base64'),
          'audio.webm',
          controller.signal,
        );
      }
    } catch (err) {
      if (err instanceof Error && /error: 40[0134]/.test(err.message)) throw err;
      transcript = undefined;
    }

    await provider.solve(
      shot.base64,
      transcript || undefined,
      {
        onDelta: (delta) => overlay?.webContents.send(IPC.SOLVE_DELTA, { delta }),
      },
      controller.signal,
    );
    overlay.webContents.send(IPC.SOLVE_DONE, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let friendly = message;
    if (message.includes('Missing config') || message.includes('not valid JSON')) {
      friendly = `Config problem: ${message}`;
    } else if (err instanceof Error && err.name === 'AbortError') {
      friendly = 'Timed out after 25s — try a tighter screenshot of just the problem.';
    }
    overlay.webContents.send(IPC.SOLVE_DONE, { ok: false, error: friendly });
  } finally {
    clearTimeout(timeout);
    solving = false;
  }
}

// Single instance: a second launch focuses the existing overlay instead of
// creating a duplicate (which would also fight over the hotkeys).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showOverlayInactive());

  app.whenReady().then(() => {
    // Grant mic access to the overlay itself (for the rolling audio buffer).
    // Nothing else is granted: camera, geolocation, etc. stay denied.
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, permission, callback, details) => {
        const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        const isMicOnly =
          permission === 'media' && mediaTypes.includes('audio') && !mediaTypes.includes('video');
        callback(isMicOnly);
      },
    );

    overlay = createOverlay();

    registerHotkey(HOTKEY_SOLVE, () => void runSolve());
    registerHotkey(HOTKEY_TOGGLE, toggleOverlay);
    registerHotkey(HOTKEY_QUIT, () => app.quit());

    ipcMain.on(IPC.SOLVE_REQUEST, () => void runSolve());
    ipcMain.on(IPC.OVERLAY_TOGGLE, toggleOverlay);
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  // Overlay app: closing all windows does not quit (no dock icon to reopen from).
});
