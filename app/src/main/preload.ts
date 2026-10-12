import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';

// Preload: the only bridge between renderer and Node. Exposes a minimal,
// typed API — the renderer never touches ipcRenderer directly.
contextBridge.exposeInMainWorld('assistant', {
  requestSolve: () => ipcRenderer.send(IPC.SOLVE_REQUEST),
  toggleOverlay: () => ipcRenderer.send(IPC.OVERLAY_TOGGLE),
  onSolveDelta: (cb: (delta: string) => void) => {
    const handler = (_e: unknown, payload: { delta: string }) => cb(payload.delta);
    ipcRenderer.on(IPC.SOLVE_DELTA, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_DELTA, handler);
  },
  onSolveDone: (cb: (ok: boolean, error?: string) => void) => {
    const handler = (_e: unknown, payload: { ok: boolean; error?: string }) =>
      cb(payload.ok, payload.error);
    ipcRenderer.on(IPC.SOLVE_DONE, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_DONE, handler);
  },
  onSolveStart: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(IPC.SOLVE_START, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_START, handler);
  },
  onAudioRequest: (cb: (requestId: string) => void) => {
    const handler = (_e: unknown, payload: { requestId: string }) => cb(payload.requestId);
    ipcRenderer.on(IPC.AUDIO_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_REQUEST, handler);
  },
  sendAudioResponse: (requestId: string, base64: string) =>
    ipcRenderer.send(IPC.AUDIO_RESPONSE, { requestId, base64 }),
});
