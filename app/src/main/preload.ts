import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AssistantBridge, type SolveProgress } from '../shared/ipc';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

const bridge: AssistantBridge = {
  requestSolve: () => ipcRenderer.send(IPC.SOLVE_REQUEST),
  toggleOverlay: () => ipcRenderer.send(IPC.OVERLAY_TOGGLE),
  getRuntimeInfo: () => ipcRenderer.invoke(IPC.RUNTIME_INFO),
  startListening: (source) => {
    if (!['microphone', 'system', 'both'].includes(source))
      return Promise.resolve({ ok: false, error: 'Invalid audio source.' });
    return ipcRenderer.invoke(IPC.LISTEN_START, source);
  },
  stopListening: (sessionId) => {
    if (typeof sessionId === 'string' && sessionId.length <= 128)
      ipcRenderer.send(IPC.LISTEN_STOP, sessionId);
  },
  transcribeChunk: (sessionId, sequence, base64) => {
    if (
      typeof sessionId !== 'string' ||
      sessionId.length > 128 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      typeof base64 !== 'string' ||
      base64.length === 0 ||
      base64.length > 2 * 1024 * 1024
    )
      return Promise.resolve({ ok: false, error: 'Invalid audio clip.' });
    return ipcRenderer.invoke(IPC.AUDIO_CHUNK, { sessionId, sequence, base64 });
  },
  onListeningEnded: (cb) => {
    const handler = () => cb();
    ipcRenderer.on(IPC.LISTEN_ENDED, handler);
    return () => ipcRenderer.removeListener(IPC.LISTEN_ENDED, handler);
  },
  onSolveDelta: (cb) => {
    const handler = (_event: unknown, payload: unknown) => {
      const delta = record(payload)?.delta;
      if (typeof delta === 'string') cb(delta);
    };
    ipcRenderer.on(IPC.SOLVE_DELTA, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_DELTA, handler);
  },
  onSolveDone: (cb) => {
    const handler = (_event: unknown, payload: unknown) => {
      const value = record(payload);
      if (typeof value?.ok === 'boolean')
        cb(value.ok, typeof value.error === 'string' ? value.error : undefined);
    };
    ipcRenderer.on(IPC.SOLVE_DONE, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_DONE, handler);
  },
  onSolveStart: (cb) => {
    const handler = () => cb();
    ipcRenderer.on(IPC.SOLVE_START, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_START, handler);
  },
  onSolveProgress: (cb) => {
    const handler = (_event: unknown, payload: unknown) => {
      const value = record(payload);
      if (
        !value ||
        typeof value.stage !== 'string' ||
        !['capture', 'answer', 'complete'].includes(value.stage)
      )
        return;
      for (const key of ['captureMs', 'firstTokenMs', 'totalMs']) {
        if (
          value[key] !== undefined &&
          (typeof value[key] !== 'number' ||
            !Number.isFinite(value[key]) ||
            (value[key] as number) < 0)
        )
          return;
      }
      cb(value as unknown as SolveProgress);
    };
    ipcRenderer.on(IPC.SOLVE_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.SOLVE_PROGRESS, handler);
  },
  onInteractionChanged: (cb) => {
    const handler = (_event: unknown, payload: unknown) => {
      const value = record(payload)?.interactive;
      if (typeof value === 'boolean') cb(value);
    };
    ipcRenderer.on(IPC.INTERACTION_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.INTERACTION_CHANGED, handler);
  },
};

contextBridge.exposeInMainWorld('assistant', bridge);
