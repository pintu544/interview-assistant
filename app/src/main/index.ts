import { app, BrowserWindow, globalShortcut, ipcMain, screen, session } from 'electron';
import path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { IPC } from '../shared/ipc';
import { captureScreen } from './capture';
import { loadConfig } from './config';
import { createProvider, ProviderError } from './providers';
import { abortable, abortError } from './lifecycle';

// Main owns credentials, capture and provider calls; the renderer remains sandboxed.
let overlay: BrowserWindow | null = null;
let solving = false;
let interactive = false;
let activeController: AbortController | null = null;
const HOTKEY_SOLVE = 'CommandOrControl+Alt+S';
const HOTKEY_TOGGLE = 'CommandOrControl+Alt+H';
const HOTKEY_INTERACT = 'CommandOrControl+Alt+I';
const HOTKEY_QUIT = 'CommandOrControl+Alt+Q';
const SOLVE_TIMEOUT_MS = 25_000;
const MAX_AUDIO_BASE64 = 8 * 1024 * 1024;
const rendererFile = path.join(__dirname, '../renderer/index.html');
const isDevelopment = process.env.NODE_ENV === 'development';

function trustedRenderer(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isDevelopment
      ? parsed.origin === 'http://localhost:5173'
      : parsed.href.split(/[?#]/)[0] === pathToFileURL(rendererFile).href;
  } catch {
    return false;
  }
}

function send(channel: string, payload?: unknown): void {
  if (overlay && !overlay.isDestroyed() && !overlay.webContents.isDestroyed()) {
    overlay.webContents.send(channel, payload);
  }
}

function showOverlayInactive(): void {
  if (overlay && !overlay.isDestroyed()) overlay.showInactive();
}

function createOverlay(): BrowserWindow {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const w = Math.max(240, Math.min(560, width - 40));
  const win = new BrowserWindow({
    width: w,
    height: Math.max(200, Math.min(700, height - 40)),
    x: x + width - w - 24,
    y: y + 24,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!trustedRenderer(url)) event.preventDefault();
  });
  win.on('closed', () => {
    activeController?.abort();
    if (overlay === win) overlay = null;
    app.quit();
  });
  const loading = isDevelopment ? win.loadURL('http://localhost:5173') : win.loadFile(rendererFile);
  void loading.catch((error: unknown) => {
    console.error(
      'Unable to load overlay:',
      error instanceof Error ? error.message : String(error),
    );
    activeController?.abort();
  });
  return win;
}

function toggleOverlay(): void {
  if (!overlay || overlay.isDestroyed()) return;
  if (overlay.isVisible()) overlay.hide();
  else overlay.showInactive();
}

function toggleInteraction(): void {
  if (!overlay || overlay.isDestroyed()) return;
  interactive = !interactive;
  overlay.setIgnoreMouseEvents(!interactive);
  send(IPC.INTERACTION_CHANGED, { interactive });
  showOverlayInactive();
}

function registerHotkey(accelerator: string, handler: () => void): void {
  if (globalShortcut.register(accelerator, handler)) return;
  const notify = () => {
    showOverlayInactive();
    send(IPC.SOLVE_DONE, {
      ok: false,
      error: `Hotkey ${accelerator} is already taken by another app. Close the conflicting app and restart.`,
    });
  };
  if (overlay?.webContents.isLoading()) overlay.webContents.once('did-finish-load', notify);
  else notify();
}

async function waitForLoad(signal: AbortSignal): Promise<void> {
  const contents = overlay?.webContents;
  if (!contents || contents.isDestroyed()) throw new Error('Overlay is unavailable.');
  if (!contents.isLoading()) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      contents.removeListener('did-finish-load', done);
      contents.removeListener('did-fail-load', failed);
      contents.removeListener('destroyed', destroyed);
      signal.removeEventListener('abort', aborted);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = (_event: unknown, code: number, description: string) => {
      if (code === -3) return;
      cleanup();
      reject(new Error(`Overlay failed to load: ${description}`));
    };
    const destroyed = () => {
      cleanup();
      reject(new Error('Overlay was closed.'));
    };
    const aborted = () => {
      cleanup();
      reject(abortError());
    };
    contents.once('did-finish-load', done);
    contents.on('did-fail-load', failed);
    contents.once('destroyed', destroyed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Recent audio is optional; validate sender and bounded payload before decoding. */
function requestRecentAudio(signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (!overlay || overlay.isDestroyed() || signal.aborted) return resolve('');
    const owner = overlay.webContents;
    const requestId = randomUUID();
    const cleanup = () => {
      clearTimeout(timeout);
      ipcMain.removeListener(IPC.AUDIO_RESPONSE, onResponse);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (audio: string) => {
      cleanup();
      resolve(audio);
    };
    const onAbort = () => finish('');
    const onResponse = (event: Electron.IpcMainEvent, payload: unknown) => {
      if (event.sender !== owner || event.senderFrame !== owner.mainFrame) return;
      if (!payload || typeof payload !== 'object') return;
      const response = payload as { requestId?: unknown; base64?: unknown };
      if (response.requestId !== requestId || typeof response.base64 !== 'string') return;
      if (
        response.base64.length > MAX_AUDIO_BASE64 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(response.base64)
      ) {
        finish('');
        return;
      }
      finish(response.base64);
    };
    const timeout = setTimeout(() => finish(''), 5000);
    ipcMain.on(IPC.AUDIO_RESPONSE, onResponse);
    signal.addEventListener('abort', onAbort, { once: true });
    send(IPC.AUDIO_REQUEST, { requestId });
  });
}

async function runSolve(): Promise<void> {
  if (!overlay || overlay.isDestroyed() || solving) return;
  solving = true;
  const controller = new AbortController();
  activeController = controller;
  // This deadline includes renderer readiness and non-abortable desktop capture.
  const timeout = setTimeout(() => controller.abort(), SOLVE_TIMEOUT_MS);
  showOverlayInactive();
  try {
    await waitForLoad(controller.signal);
    send(IPC.SOLVE_START);
    const cfg = loadConfig();
    const provider = createProvider(cfg);
    const transcriptionEnabled =
      cfg.transcriptionEnabled !== false &&
      new URL(cfg.endpoint).hostname !== 'integrate.api.nvidia.com';
    const [shot, audioBase64] = await abortable(
      Promise.all([
        captureScreen(),
        transcriptionEnabled ? requestRecentAudio(controller.signal) : Promise.resolve(''),
      ]),
      controller.signal,
    );
    let transcript: string | undefined;
    if (audioBase64) {
      try {
        transcript = await abortable(
          provider.transcribe(Buffer.from(audioBase64, 'base64'), 'audio.webm', controller.signal),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) throw abortError();
        // Auth failures are actionable. Unsupported ASR and transient audio errors are optional.
        if (error instanceof ProviderError && (error.status === 401 || error.status === 403))
          throw error;
      }
    }
    await abortable(
      provider.solve(
        shot.base64,
        transcript || undefined,
        {
          onDelta: (delta) => {
            if (!controller.signal.aborted) send(IPC.SOLVE_DELTA, { delta });
          },
        },
        controller.signal,
      ),
      controller.signal,
    );
    send(IPC.SOLVE_DONE, { ok: true });
  } catch (error) {
    const message = controller.signal.aborted
      ? 'Timed out or cancelled after up to 25s — try again with the problem visible.'
      : error instanceof Error
        ? error.message
        : String(error);
    send(IPC.SOLVE_DONE, { ok: false, error: message });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (activeController === controller) activeController = null;
    solving = false;
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showOverlayInactive);
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        callback(
          contents === overlay?.webContents &&
            trustedRenderer(contents.getURL()) &&
            permission === 'media' &&
            mediaTypes.includes('audio') &&
            !mediaTypes.includes('video'),
        );
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        contents === overlay?.webContents &&
        trustedRenderer(contents.getURL()) &&
        permission === 'media' &&
        details.mediaType === 'audio',
    );
    overlay = createOverlay();
    registerHotkey(HOTKEY_SOLVE, () => void runSolve());
    registerHotkey(HOTKEY_TOGGLE, toggleOverlay);
    registerHotkey(HOTKEY_INTERACT, toggleInteraction);
    registerHotkey(HOTKEY_QUIT, () => app.quit());
    const isOwner = (event: Electron.IpcMainEvent) =>
      event.sender === overlay?.webContents && event.senderFrame === overlay.webContents.mainFrame;
    ipcMain.on(IPC.SOLVE_REQUEST, (event) => {
      if (isOwner(event)) void runSolve();
    });
    ipcMain.on(IPC.OVERLAY_TOGGLE, (event) => {
      if (isOwner(event)) toggleOverlay();
    });
  });
}
app.on('will-quit', () => {
  activeController?.abort();
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => app.quit());
