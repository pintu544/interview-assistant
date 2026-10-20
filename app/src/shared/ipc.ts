export const IPC = {
  SOLVE_START: 'solve:start',
  SOLVE_REQUEST: 'solve:request',
  SOLVE_DELTA: 'solve:delta',
  SOLVE_DONE: 'solve:done',
  SOLVE_PROGRESS: 'solve:progress',
  OVERLAY_TOGGLE: 'overlay:toggle',
  INTERACTION_CHANGED: 'overlay:interaction',
  RUNTIME_INFO: 'runtime:info',
  LISTEN_START: 'listen:start',
  LISTEN_STOP: 'listen:stop',
  LISTEN_ENDED: 'listen:ended',
  AUDIO_CHUNK: 'audio:chunk',
} as const;

export type AudioSource = 'microphone' | 'system' | 'both';

export interface RuntimeInfo {
  mode: 'mock' | 'live';
  model: string;
  transcriptionEnabled: boolean;
}

export interface ListenResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

export interface TranscriptResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface SolveProgress {
  stage: 'capture' | 'answer' | 'complete';
  captureMs?: number;
  firstTokenMs?: number;
  totalMs?: number;
}

export interface AssistantBridge {
  requestSolve: () => void;
  toggleOverlay: () => void;
  getRuntimeInfo: () => Promise<RuntimeInfo>;
  startListening: (source: AudioSource) => Promise<ListenResult>;
  stopListening: (sessionId: string) => void;
  transcribeChunk: (
    sessionId: string,
    sequence: number,
    base64: string,
  ) => Promise<TranscriptResult>;
  onListeningEnded: (cb: () => void) => () => void;
  onSolveDelta: (cb: (delta: string) => void) => () => void;
  onSolveDone: (cb: (ok: boolean, error?: string) => void) => () => void;
  onSolveStart: (cb: () => void) => () => void;
  onSolveProgress: (cb: (progress: SolveProgress) => void) => () => void;
  onInteractionChanged: (cb: (interactive: boolean) => void) => () => void;
}
