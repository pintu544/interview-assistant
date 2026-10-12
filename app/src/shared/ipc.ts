// Shared IPC contracts between main and renderer processes.
// Channels are the only cross-process API; payloads are JSON-serializable.

export const IPC = {
  /** Main → Renderer: a new solve started — clear output, show "thinking". */
  SOLVE_START: 'solve:start',
  /** Renderer → Main: request a screenshot solve. Payload: none (main captures). */
  SOLVE_REQUEST: 'solve:request',
  /** Main → Renderer: streamed markdown delta. Payload: { delta: string }. */
  SOLVE_DELTA: 'solve:delta',
  /** Main → Renderer: solve finished. Payload: { ok: boolean; error?: string }. */
  SOLVE_DONE: 'solve:done',
  /** Renderer → Main: toggle overlay visibility. */
  OVERLAY_TOGGLE: 'overlay:toggle',
  /** Main → Renderer: send recent mic audio. Payload: { requestId: string }. */
  AUDIO_REQUEST: 'audio:request',
  /** Renderer → Main: recent mic audio. Payload: { requestId, base64 }. */
  AUDIO_RESPONSE: 'audio:response',
} as const;

export interface SolveDeltaPayload {
  delta: string;
}

export interface SolveDonePayload {
  ok: boolean;
  error?: string;
}
