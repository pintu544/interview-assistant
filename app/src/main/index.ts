import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
} from 'electron';
import path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { IPC, type AudioSource, type ListenResult, type TranscriptResult } from '../shared/ipc';
import { captureScreen } from './capture';
import { loadConfig, type AssistantConfig } from './config';
import { createProvider, type LlmProvider } from './providers';
import { abortable, abortError } from './lifecycle';

let overlay: BrowserWindow | null = null;
let solving = false;
let interactive = true;
let activeController: AbortController | null = null;
const HOTKEY_SOLVE = 'CommandOrControl+Alt+S';
const HOTKEY_TOGGLE = 'CommandOrControl+Alt+H';
const HOTKEY_INTERACT = 'CommandOrControl+Alt+I';
const HOTKEY_QUIT = 'CommandOrControl+Alt+Q';
const SOLVE_TIMEOUT_MS = 25_000;
const rendererFile = path.join(__dirname, '../renderer/index.html');
const isDevelopment = process.env.NODE_ENV === 'development';

interface ListeningSession {
  id: string;
  source: AudioSource;
  provider: LlmProvider;
  controller: AbortController | null;
  sequence: number;
  entries: Array<{ at: number; text: string }>;
}
let listening: ListeningSession | null = null;

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

function isOwner(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return (
    !!overlay &&
    !overlay.isDestroyed() &&
    event.sender === overlay.webContents &&
    event.senderFrame === overlay.webContents.mainFrame &&
    trustedRenderer(overlay.webContents.getURL())
  );
}

function transcriptionEnabled(cfg: AssistantConfig): boolean {
  return (
    cfg.transcriptionEnabled !== false &&
    new URL(cfg.endpoint).hostname !== 'integrate.api.nvidia.com'
  );
}

function send(channel: string, payload?: unknown): void {
  if (overlay && !overlay.isDestroyed() && !overlay.webContents.isDestroyed())
    overlay.webContents.send(channel, payload);
}

function stopListening(): void {
  listening?.controller?.abort();
  listening = null;
  send(IPC.LISTEN_ENDED);
}

function transcriptText(current: ListeningSession): string {
  current.entries = current.entries.filter((entry) => Date.now() - entry.at < 60_000);
  return current.entries
    .map((entry) => entry.text)
    .join(' ')
    .slice(-8000);
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
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!trustedRenderer(url)) event.preventDefault();
  });
  win.webContents.on('did-start-loading', stopListening);
  win.webContents.on('render-process-gone', stopListening);
  win.on('hide', stopListening);
  win.on('minimize', stopListening);
  win.on('closed', () => {
    activeController?.abort();
    stopListening();
    if (overlay === win) overlay = null;
    app.quit();
  });
  const loading = isDevelopment ? win.loadURL('http://localhost:5173') : win.loadFile(rendererFile);
  void loading
    .then(() => {
      if (!win.isDestroyed()) win.showInactive();
    })
    .catch((error: unknown) => {
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
  if (overlay.isVisible()) {
    stopListening();
    overlay.hide();
  } else overlay.showInactive();
}

function toggleInteraction(): void {
  if (!overlay || overlay.isDestroyed()) return;
  if (listening) return;
  interactive = !interactive;
  overlay.setIgnoreMouseEvents(!interactive);
  send(IPC.INTERACTION_CHANGED, { interactive });
  showOverlayInactive();
}

function registerHotkey(accelerator: string, handler: () => void): void {
  if (globalShortcut.register(accelerator, handler)) return;
  console.error(`Hotkey registration failed: ${accelerator}`);
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

async function transcribeChunk(payload: unknown): Promise<TranscriptResult> {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Invalid audio clip.' };
  const data = payload as { sessionId?: unknown; sequence?: unknown; base64?: unknown };
  const current = listening;
  if (!current || data.sessionId !== current.id || !overlay?.isVisible())
    return { ok: false, error: 'Listening has stopped.' };
  if (current.controller) return { ok: false, error: 'Transcription is still busy.' };
  if (
    !Number.isSafeInteger(data.sequence) ||
    (data.sequence as number) <= current.sequence ||
    typeof data.base64 !== 'string' ||
    !data.base64.length ||
    data.base64.length > 2 * 1024 * 1024 ||
    data.base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)
  )
    return { ok: false, error: 'Invalid audio clip.' };
  current.sequence = data.sequence as number;
  const controller = new AbortController();
  current.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const text = await abortable(
      current.provider.transcribe(
        Buffer.from(data.base64, 'base64'),
        'audio.webm',
        controller.signal,
        transcriptText(current).slice(-1000),
      ),
      controller.signal,
    );
    if (listening !== current) return { ok: false, error: 'Listening has stopped.' };
    if (text.trim()) current.entries.push({ at: Date.now(), text: text.trim().slice(0, 4000) });
    current.entries = current.entries.slice(-12);
    return { ok: true, text: transcriptText(current) };
  } catch (error) {
    const message = controller.signal.aborted
      ? 'Transcription timed out or was stopped.'
      : error instanceof Error
        ? error.message
        : 'Transcription failed.';
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
    if (current.controller === controller) current.controller = null;
  }
}

async function runSolve(): Promise<void> {
  if (!overlay || overlay.isDestroyed() || solving) return;
  solving = true;
  const started = Date.now();
  const controller = new AbortController();
  activeController = controller;
  const timeout = setTimeout(() => controller.abort(), SOLVE_TIMEOUT_MS);
  showOverlayInactive();
  try {
    await waitForLoad(controller.signal);
    send(IPC.SOLVE_START);
    send(IPC.SOLVE_PROGRESS, { stage: 'capture' });
    const cfg = loadConfig();
    const provider = createProvider(cfg);
    const captureStarted = Date.now();
    const shot = await abortable(captureScreen(), controller.signal);
    const captureMs = Date.now() - captureStarted;
    // Completed background transcripts are used; an in-flight ASR request never blocks a solve.
    const transcript = listening && transcriptionEnabled(cfg) ? transcriptText(listening) : '';
    send(IPC.SOLVE_PROGRESS, { stage: 'answer', captureMs });
    let firstTokenMs: number | undefined;
    await abortable(
      provider.solve(
        shot.base64,
        transcript || undefined,
        {
          onDelta: (delta) => {
            if (controller.signal.aborted) return;
            if (firstTokenMs === undefined) {
              firstTokenMs = Date.now() - started;
              send(IPC.SOLVE_PROGRESS, { stage: 'answer', captureMs, firstTokenMs });
            }
            send(IPC.SOLVE_DELTA, { delta });
          },
        },
        controller.signal,
      ),
      controller.signal,
    );
    send(IPC.SOLVE_PROGRESS, {
      stage: 'complete',
      captureMs,
      firstTokenMs,
      totalMs: Date.now() - started,
    });
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
        // Electron reports display-media authorization with an empty mediaTypes list.
        const displayMedia = mediaTypes.length === 0 && listening?.source !== 'microphone';
        callback(
          !!listening &&
            overlay?.isVisible() === true &&
            contents === overlay.webContents &&
            trustedRenderer(contents.getURL()) &&
            details.isMainFrame &&
            trustedRenderer(details.requestingUrl) &&
            ((permission === 'media' &&
              (displayMedia ||
                (listening.source !== 'system' &&
                  mediaTypes.includes('audio') &&
                  !mediaTypes.includes('video')))) ||
              (permission === 'display-capture' && listening.source !== 'microphone')),
        );
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        !!listening &&
        overlay?.isVisible() === true &&
        contents === overlay.webContents &&
        trustedRenderer(contents.getURL()) &&
        details.isMainFrame &&
        trustedRenderer(details.requestingUrl ?? '') &&
        ((permission === 'media' &&
          listening.source !== 'system' &&
          details.mediaType === 'audio') ||
          (permission === 'display-capture' && listening.source !== 'microphone')),
    );
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const current = listening;
      if (
        !current ||
        current.source === 'microphone' ||
        process.platform !== 'win32' ||
        !overlay?.isVisible() ||
        request.frame !== overlay.webContents.mainFrame ||
        !trustedRenderer(request.frame.url) ||
        !request.userGesture ||
        !request.audioRequested
      ) {
        callback({});
        return;
      }
      void desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (listening !== current || !overlay?.isVisible() || !sources.length)
            return callback({});
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch(() => callback({}));
    });
    overlay = createOverlay();
    registerHotkey(HOTKEY_SOLVE, () => void runSolve());
    registerHotkey(HOTKEY_TOGGLE, toggleOverlay);
    registerHotkey(HOTKEY_INTERACT, toggleInteraction);
    registerHotkey(HOTKEY_QUIT, () => app.quit());
    ipcMain.handle(IPC.RUNTIME_INFO, (event) => {
      if (!isOwner(event)) throw new Error('Untrusted caller.');
      const cfg = loadConfig();
      return {
        mode: cfg.chatModel === 'mock-vision' ? 'mock' : 'live',
        model: cfg.chatModel,
        transcriptionEnabled: transcriptionEnabled(cfg),
      };
    });
    ipcMain.handle(IPC.LISTEN_START, (event, source: unknown): ListenResult => {
      if (!isOwner(event) || !overlay?.isVisible())
        return { ok: false, error: 'Open the app to start listening.' };
      if (source !== 'microphone' && source !== 'system' && source !== 'both')
        return { ok: false, error: 'Invalid audio source.' };
      if (source !== 'microphone' && process.platform !== 'win32')
        return { ok: false, error: 'Computer audio is supported on Windows only.' };
      if (listening) return { ok: false, error: 'A listening session is already active.' };
      try {
        const cfg = loadConfig();
        if (!transcriptionEnabled(cfg))
          return { ok: false, error: 'Transcription is disabled in your provider config.' };
        listening = {
          id: randomUUID(),
          source,
          provider: createProvider(cfg),
          controller: null,
          sequence: -1,
          entries: [],
        };
        interactive = true;
        overlay.setIgnoreMouseEvents(false);
        send(IPC.INTERACTION_CHANGED, { interactive });
        return { ok: true, sessionId: listening.id };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to start transcription.',
        };
      }
    });
    ipcMain.handle(IPC.AUDIO_CHUNK, (event, payload: unknown) =>
      isOwner(event)
        ? transcribeChunk(payload)
        : Promise.resolve({ ok: false, error: 'Untrusted caller.' }),
    );
    ipcMain.on(IPC.LISTEN_STOP, (event, id: unknown) => {
      if (isOwner(event) && id === listening?.id) stopListening();
    });
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
  stopListening();
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => app.quit());
