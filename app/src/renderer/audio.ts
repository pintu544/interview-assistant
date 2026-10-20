// Capture starts only from an explicit start() call. Each five-second clip uses
// a fresh MediaRecorder, so it has its own WebM container header.
const CLIP_MS = 5_000;
const MIME_TYPE = 'audio/webm;codecs=opus';

export type AudioSource = 'microphone' | 'system' | 'both';

interface Clip {
  recorder: MediaRecorder;
  chunks: Blob[];
  finalizing: boolean;
}

interface Session {
  generation: number;
  label: string;
  tracks: Set<MediaStreamTrack>;
  endedListeners: Map<MediaStreamTrack, () => void>;
  context: AudioContext | null;
  nodes: AudioNode[];
  mixed: MediaStream | null;
  clips: Set<Clip>;
  current: Clip | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AudioRecorder {
  private generation = 0;
  private session: Session | null = null;
  private starting: Promise<void> | null = null;
  private _recording = false;

  onStateChange: ((recording: boolean) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onSegment: ((blob: Blob) => void) | null = null;

  get isRecording(): boolean {
    return this._recording;
  }

  private setRecording(value: boolean): void {
    if (this._recording === value) return;
    this._recording = value;
    this.onStateChange?.(value);
  }

  private isCurrent(session: Session): boolean {
    return this.session === session && this.generation === session.generation;
  }

  /** Concurrent starts share one acquisition; stop before changing sources. */
  start(source: AudioSource): Promise<void> {
    if (this._recording) return Promise.resolve();
    if (this.starting) return this.starting;

    const session: Session = {
      generation: ++this.generation,
      label:
        source === 'both'
          ? 'Microphone and computer audio'
          : source === 'system'
            ? 'Computer audio'
            : 'Microphone',
      tracks: new Set(),
      endedListeners: new Map(),
      context: null,
      nodes: [],
      mixed: null,
      clips: new Set(),
      current: null,
      timer: null,
    };
    this.session = session;
    // Do not defer open(): getDisplayMedia must run in the click's activation.
    const starting = this.open(session, source);
    if (this.isCurrent(session)) this.starting = starting;
    const settled = () => {
      if (this.starting === starting) this.starting = null;
    };
    void starting.then(settled, settled);
    return starting;
  }

  private async open(session: Session, source: AudioSource): Promise<void> {
    let action = 'Unable to start audio recording';
    try {
      if (source !== 'microphone' && source !== 'system' && source !== 'both') {
        throw new Error('Choose microphone, system, or both as the audio source.');
      }
      const inputs: MediaStream[] = [];
      if (source === 'system' || source === 'both') {
        action = 'Computer audio capture failed';
        if (!navigator.mediaDevices?.getDisplayMedia) {
          throw new Error('Computer audio sharing is not supported in this environment.');
        }
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const input = this.retainAudio(session, display, 'Computer audio');
        if (!input) return;
        inputs.push(input);
      }
      if (source === 'microphone' || source === 'both') {
        action = 'Microphone capture failed';
        const microphone = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        });
        const input = this.retainAudio(session, microphone, 'Microphone');
        if (!input) return;
        inputs.push(input);
      }

      action = `${session.label} recording failed`;
      if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
        throw new Error('WebM/Opus audio recording is not supported in this environment.');
      }
      action = 'Audio mixing failed';
      const context = new AudioContext();
      session.context = context;
      const destination = context.createMediaStreamDestination();
      session.nodes.push(destination);
      session.mixed = this.retainAudio(session, destination.stream, 'Mixed audio');
      if (!session.mixed) return;
      for (const input of inputs) {
        const node = context.createMediaStreamSource(input);
        session.nodes.push(node);
        const gain = context.createGain();
        session.nodes.push(gain);
        gain.gain.value = source === 'both' ? 0.5 : 1;
        node.connect(gain);
        gain.connect(destination); // Never connect captured audio to the speakers.
      }
      if (context.state === 'suspended') await context.resume();
      if (!this.isCurrent(session)) return;
      action = `${session.label} recording failed`;
      this.startClip(session);
      if (this.isCurrent(session)) this.setRecording(true);
    } catch (error) {
      // A cancelled permission request must not report errors into a new session.
      if (!this.isCurrent(session)) return;
      const message = `${action}: ${errorMessage(error)}`;
      this.fail(session, message);
      throw new Error(message);
    }
  }

  private retainAudio(session: Session, stream: MediaStream, label: string): MediaStream | null {
    if (!this.isCurrent(session)) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
    stream.getTracks().forEach((track) => session.tracks.add(track));
    // Release display video immediately, including when no audio was shared.
    stream.getVideoTracks().forEach((track) => {
      track.stop();
      session.tracks.delete(track);
    });
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error(
        `${label} did not provide an audio track. ${
          label === 'Computer audio'
            ? 'Select a source with audio sharing enabled.'
            : 'Check your audio device.'
        }`,
      );
    }
    for (const track of audioTracks) {
      if (track.readyState === 'ended') {
        throw new Error(`${label} ended before recording could start. Check the source or device.`);
      }
      const ended = () =>
        this.fail(
          session,
          `${label} ended or disconnected. Select the source or device and start recording again.`,
        );
      session.endedListeners.set(track, ended);
      track.addEventListener('ended', ended);
    }
    return new MediaStream(audioTracks);
  }

  private startClip(session: Session): void {
    const recorder = new MediaRecorder(session.mixed!, {
      mimeType: MIME_TYPE,
      audioBitsPerSecond: 64_000,
    });
    const clip: Clip = { recorder, chunks: [], finalizing: false };
    session.clips.add(clip);
    session.current = clip;
    recorder.ondataavailable = (event: BlobEvent) => {
      if (!this.isCurrent(session) || !session.clips.has(clip) || event.data.size === 0) return;
      clip.chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      if (!this.isCurrent(session) || !session.clips.has(clip)) return;
      const detail = (event as Event & { error?: DOMException }).error?.message;
      this.fail(
        session,
        `${session.label} recorder failed: ${detail || 'check the audio source or device and try again.'}`,
      );
    };
    recorder.onstop = () => {
      if (!this.isCurrent(session) || !session.clips.has(clip)) return;
      const chunks = clip.chunks;
      this.detachClip(session, clip);
      if (!clip.finalizing) {
        this.fail(
          session,
          `${session.label} recorder stopped unexpectedly. Check the audio source or device.`,
        );
        return;
      }
      const blob = new Blob(chunks, { type: MIME_TYPE });
      if (blob.size === 0) {
        this.fail(
          session,
          `No audio was captured from ${session.label.toLowerCase()}. Check the source or device and audio sharing settings.`,
        );
        return;
      }
      this.onSegment?.(blob);
    };
    recorder.start(); // No timeslice: finish the complete container on stop().
    if (!this.isCurrent(session) || !session.clips.has(clip)) return;
    session.timer = setTimeout(() => this.rotate(session, clip), CLIP_MS);
  }

  private rotate(session: Session, clip: Clip): void {
    if (!this.isCurrent(session) || session.current !== clip) return;
    session.timer = null;
    // At most one active and one finalizing clip: a stalled encoder cannot
    // accumulate pending recorders/chunks indefinitely.
    if (session.clips.size > 1) {
      this.fail(
        session,
        `${session.label} recorder did not finish the previous audio clip. Start recording again.`,
      );
      return;
    }
    clip.finalizing = true;
    try {
      clip.recorder.stop();
      // Do not await onstop; the next independent clip starts immediately.
      if (this.isCurrent(session)) this.startClip(session);
    } catch (error) {
      this.fail(session, `${session.label} recording failed: ${errorMessage(error)}`);
    }
  }

  private detachClip(session: Session, clip: Clip): void {
    clip.recorder.ondataavailable = null;
    clip.recorder.onerror = null;
    clip.recorder.onstop = null;
    clip.chunks = [];
    session.clips.delete(clip);
    if (session.current === clip) session.current = null;
  }

  private fail(session: Session, message: string): void {
    if (!this.isCurrent(session)) return;
    this.stop();
    this.onError?.(message);
  }

  /** Cancel pending permissions and discard all unfinished/finalizing clips. */
  stop(): void {
    ++this.generation;
    this.starting = null;
    const session = this.session;
    this.session = null;
    if (session) {
      if (session.timer !== null) clearTimeout(session.timer);
      session.timer = null;
      for (const [track, ended] of session.endedListeners) {
        track.removeEventListener('ended', ended);
      }
      session.endedListeners.clear();
      for (const clip of session.clips) {
        this.detachClip(session, clip);
        try {
          if (clip.recorder.state !== 'inactive') clip.recorder.stop();
        } catch {
          // Already stopped or failed. Track/context cleanup must still run.
        }
      }
      for (const node of session.nodes) node.disconnect();
      session.nodes = [];
      session.tracks.forEach((track) => track.stop());
      session.tracks.clear();
      session.mixed = null;
      const context = session.context;
      session.context = null;
      if (context) void context.close().catch(() => {});
    }
    this.setRecording(false);
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
