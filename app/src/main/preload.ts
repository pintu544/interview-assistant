import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';

// Bundled as one CommonJS file: sandbox preloads cannot require local modules.
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

contextBridge.exposeInMainWorld('assistant', {
  requestSolve: () => ipcRenderer.send(IPC.SOLVE_REQUEST),
  toggleOverlay: () => ipcRenderer.send(IPC.OVERLAY_TOGGLE),
  onSolveDelta: (cb: (delta: string) => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      const delta = record(payload)?.delta;
      if (typeof delta === 'string') cb(delta);
    };
    ipcRenderer.on(IPC.SOLVE_DELTA, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_DELTA, handler);
  },
  onSolveDone: (cb: (ok: boolean, error?: string) => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      const value = record(payload);
      if (typeof value?.ok === 'boolean')
        cb(value.ok, typeof value.error === 'string' ? value.error : undefined);
    };
    ipcRenderer.on(IPC.SOLVE_DONE, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_DONE, handler);
  },
  onSolveStart: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(IPC.SOLVE_START, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_START, handler);
  },
  onAudioRequest: (cb: (requestId: string) => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      const id = record(payload)?.requestId;
      if (typeof id === 'string' && id.length <= 128) cb(id);
    };
    ipcRenderer.on(IPC.AUDIO_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_REQUEST, handler);
  },
  onInteractionChanged: (cb: (interactive: boolean) => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      const value = record(payload)?.interactive;
      if (typeof value === 'boolean') cb(value);
    };
    ipcRenderer.on(IPC.INTERACTION_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.INTERACTION_CHANGED, handler);
  },
  sendAudioResponse: (requestId: string, base64: string) => {
    if (
      typeof requestId === 'string' &&
      requestId.length <= 128 &&
      typeof base64 === 'string' &&
      base64.length <= 8 * 1024 * 1024
    ) {
      ipcRenderer.send(IPC.AUDIO_RESPONSE, { requestId, base64 });
    }
  },
});
