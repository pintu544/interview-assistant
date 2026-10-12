// MicRecorder: continuous microphone capture into a rolling ~35s buffer.
// Runs in the renderer (Chromium getUserMedia) — no native modules needed.
// Chunks are 1s webm slices; Whisper accepts webm directly.
//
// CRITICAL detail: only the FIRST MediaRecorder chunk carries the EBML
// container header. The header chunk is pinned separately and never pruned —
// without it, the concatenated buffer is undecodable after ~35s.

const WINDOW_MS = 35_000;
const KEEP_MS = 30_000;

interface Chunk {
  at: number;
  data: Blob;
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Chunk[] = [];
  private header: Blob | null = null;
  private starting: Promise<void> | null = null;
  private generation = 0;
  private _recording = false;

  /** Called with (recording: boolean) on state changes (errors, device loss). */
  onStateChange: ((recording: boolean) => void) | null = null;

  get isRecording(): boolean {
    return this._recording;
  }

  private setRecording(value: boolean): void {
    if (this._recording === value) return;
    this._recording = value;
    this.onStateChange?.(value);
  }

  async start(): Promise<void> {
    if (this._recording) return;
    if (this.starting) return this.starting; // idempotent under concurrency
    const gen = ++this.generation;
    this.starting = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (gen !== this.generation) {
          // stop() raced us — release the orphaned stream.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.stream = stream;
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (e: BlobEvent) => {
          if (e.data.size === 0) return;
          if (!this.header) this.header = e.data; // pin the container header
          this.chunks.push({ at: Date.now(), data: e.data });
          const cutoff = Date.now() - WINDOW_MS;
          this.chunks = this.chunks.filter((c) => c.at >= cutoff);
        };
        recorder.onerror = () => this.handleDeviceLoss();
        recorder.onstop = () => {
          // onstop fires on manual stop() too — only treat as loss if unexpected.
          if (gen === this.generation && this._recording) this.handleDeviceLoss();
        };
        recorder.start(1000);
        this.recorder = recorder;
        this.setRecording(true);
      } finally {
        if (gen === this.generation) this.starting = null;
      }
    })();
    return this.starting;
  }

  private handleDeviceLoss(): void {
    this.teardown();
    this.setRecording(false);
  }

  /** Last ~30s of audio as a single webm Blob, header first. */
  async getRecentAudio(): Promise<Blob> {
    const cutoff = Date.now() - KEEP_MS;
    const recent = this.chunks.filter((c) => c.at >= cutoff).map((c) => c.data);
    if (recent.length === 0) return new Blob([], { type: 'audio/webm' });
    // Prepend the pinned header unless it's already first (dedupe).
    const parts = this.header && recent[0] !== this.header ? [this.header, ...recent] : recent;
    return new Blob(parts, { type: 'audio/webm' });
  }

  stop(): void {
    this.generation++; // invalidate any in-flight start()
    this.starting = null;
    this.teardown();
    this.setRecording(false);
  }

  private teardown(): void {
    try {
      this.recorder?.stop();
    } catch {
      // Already stopped — ignore.
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.header = null;
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
