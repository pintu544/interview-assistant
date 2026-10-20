import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioRecorder, blobToBase64 } from './audio';
import type { AssistantBridge, AudioSource, RuntimeInfo, SolveProgress } from '../shared/ipc';

declare global {
  interface Window {
    assistant?: AssistantBridge;
  }
}

// Minimal markdown-lite renderer: code fences, ## headers, **bold**.
// No dependency — the overlay needs headers/code scannable under pressure,
// not full CommonMark.
function renderMarkdown(src: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const fenceRe = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  const inline = (text: string, k: number): React.ReactNode => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return (
      <span key={k}>
        {parts.map((p, i) =>
          p.startsWith('**') && p.endsWith('**') ? (
            <strong key={i}>{p.slice(2, -2)}</strong>
          ) : (
            <span key={i}>{p}</span>
          ),
        )}
      </span>
    );
  };

  const textBlock = (text: string, k: number): React.ReactNode =>
    text.split('\n').map((line, i) => {
      const h = line.match(/^(#{2,3})\s+(.*)/);
      if (h) {
        const Tag = h[1].length === 2 ? 'h2' : 'h3';
        return (
          <Tag key={`${k}-${i}`} className="md-head">
            {inline(h[2], i)}
          </Tag>
        );
      }
      return (
        <p key={`${k}-${i}`} className="md-p">
          {inline(line, i)}
        </p>
      );
    });

  while ((m = fenceRe.exec(src)) !== null) {
    if (m.index > last) nodes.push(textBlock(src.slice(last, m.index), key++));
    nodes.push(
      <pre key={key++} className="md-code">
        <code>{m[2].replace(/\n$/, '')}</code>
      </pre>,
    );
    last = m.index + m[0].length;
  }
  if (last < src.length) nodes.push(textBlock(src.slice(last), key++));
  return nodes;
}

export default function App() {
  const [bridgeOk, setBridgeOk] = useState(true);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<'idle' | 'thinking' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState<SolveProgress | null>(null);
  const [listening, setListening] = useState<'off' | 'starting' | 'on'>('off');
  const [source, setSource] = useState<AudioSource>('both');
  const [consent, setConsent] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [transcript, setTranscript] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [interactive, setInteractive] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const generation = useRef(0);
  const sessionId = useRef<string | null>(null);
  const buffered = useRef('');
  const animation = useRef<number | null>(null);
  const rendered = useMemo(() => renderMarkdown(output), [output]);

  const stopListening = useCallback(() => {
    generation.current++;
    const id = sessionId.current;
    sessionId.current = null;
    if (recorderRef.current) recorderRef.current.onSegment = null;
    recorderRef.current?.stop();
    if (id) window.assistant?.stopListening(id);
    setListening('off');
    setTranscribing(false);
    setTranscript('');
  }, []);

  useEffect(() => {
    const bridge = window.assistant;
    if (!bridge) {
      setBridgeOk(false);
      return;
    }
    let active = true;
    void bridge
      .getRuntimeInfo()
      .then((info) => {
        if (active) setRuntime(info);
      })
      .catch(() => {
        if (active)
          setAudioError(
            'Unable to load provider configuration. Check your config before starting.',
          );
      });
    const recorder = new AudioRecorder();
    recorderRef.current = recorder;
    recorder.onError = (message) => {
      stopListening();
      setAudioError(message);
    };
    const flush = () => {
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
      const text = buffered.current;
      buffered.current = '';
      if (text) setOutput((prev) => prev + text);
    };
    const offStart = bridge.onSolveStart(() => {
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
      buffered.current = '';
      setOutput('');
      setProgress(null);
      setStatus('thinking');
      stickToBottom.current = true;
    });
    const offDelta = bridge.onSolveDelta((delta) => {
      buffered.current += delta;
      if (animation.current === null) animation.current = requestAnimationFrame(flush);
    });
    const offDone = bridge.onSolveDone((ok, error) => {
      flush();
      setStatus(ok ? 'done' : 'error');
      if (!ok && error) setOutput((prev) => prev + `\n\n**Error:** ${error}`);
    });
    const offProgress = bridge.onSolveProgress(setProgress);
    const offInteraction = bridge.onInteractionChanged(setInteractive);
    const offEnded = bridge.onListeningEnded(stopListening);
    return () => {
      active = false;
      generation.current++;
      offStart();
      offDelta();
      offDone();
      offProgress();
      offInteraction();
      offEnded();
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      recorder.onError = null;
      recorder.onSegment = null;
      recorder.stop();
      if (sessionId.current) bridge.stopListening(sessionId.current);
      sessionId.current = null;
    };
  }, [stopListening]);

  const startListening = async () => {
    const bridge = window.assistant;
    const recorder = recorderRef.current;
    if (!bridge || !recorder || !consent || listening !== 'off') return;
    const version = ++generation.current;
    setListening('starting');
    setAudioError('');
    setTranscript('');
    try {
      const result = await bridge.startListening(source);
      if (version !== generation.current) {
        if (result.sessionId) bridge.stopListening(result.sessionId);
        return;
      }
      if (!result.ok || !result.sessionId)
        throw new Error(result.error || 'Unable to start listening.');
      const id = result.sessionId;
      sessionId.current = id;
      const queue: Blob[] = [];
      let processing = false;
      let sequence = 0;
      const current = () => version === generation.current && sessionId.current === id;
      const drain = async () => {
        if (processing || !current()) return;
        processing = true;
        setTranscribing(true);
        try {
          while (queue.length && current()) {
            const base64 = await blobToBase64(queue.shift()!);
            if (!current()) return;
            const response = await bridge.transcribeChunk(id, sequence++, base64);
            if (!current()) return;
            if (!response.ok) throw new Error(response.error || 'Transcription failed.');
            setTranscript(response.text || '');
          }
        } catch (error) {
          if (current()) {
            stopListening();
            setAudioError(error instanceof Error ? error.message : 'Transcription failed.');
          }
        } finally {
          processing = false;
          if (current()) setTranscribing(false);
        }
      };
      recorder.onSegment = (blob) => {
        if (!current()) return;
        if (queue.length >= 2) {
          stopListening();
          setAudioError(
            'Transcription cannot keep up. Listening stopped; check your connection and try again.',
          );
          return;
        }
        queue.push(blob);
        void drain();
      };
      await recorder.start(source);
      if (current() && recorder.isRecording) setListening('on');
    } catch (error) {
      if (version === generation.current) {
        stopListening();
        setAudioError(
          error instanceof Error ? error.message : 'Audio permission or device access failed.',
        );
      }
    }
  };

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

  if (!bridgeOk)
    return (
      <div className="overlay">
        <div className="body">
          <p className="error">Open the desktop app to use capture and audio controls.</p>
        </div>
      </div>
    );

  return (
    <div className="overlay">
      <div className="header">
        <strong>Assistant</strong>
        <span className={`mode ${runtime?.mode === 'mock' ? 'mock' : ''}`}>
          {runtime
            ? runtime.mode === 'mock'
              ? 'MOCK · canned answers'
              : 'LIVE API'
            : 'Checking config'}
        </span>
        <button className="hide-button" onClick={() => window.assistant?.toggleOverlay()}>
          Hide
        </button>
      </div>
      <section className="audio-controls" aria-label="Listening controls">
        <div className="recording-status" role="status">
          <span className={`dot${listening === 'on' ? ' listening' : ''}`} />
          <strong>
            {listening === 'on'
              ? 'Recording'
              : listening === 'starting'
                ? 'Starting audio…'
                : 'Listening off'}
          </strong>
          <span className="model">{runtime?.model}</span>
        </div>
        <div className="control-row">
          <label htmlFor="audio-source">Source</label>
          <select
            id="audio-source"
            value={source}
            disabled={listening !== 'off'}
            onChange={(event) => setSource(event.target.value as AudioSource)}
          >
            <option value="both">Microphone + computer audio</option>
            <option value="microphone">Microphone only</option>
            <option value="system">Computer audio only</option>
          </select>
          {listening === 'off' ? (
            <button
              onClick={() => void startListening()}
              disabled={!consent || !runtime?.transcriptionEnabled}
            >
              Start listening
            </button>
          ) : (
            <button className="stop-button" onClick={stopListening}>
              Stop listening
            </button>
          )}
        </div>
        <label className="consent">
          <input
            type="checkbox"
            checked={consent}
            disabled={listening !== 'off'}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I have consent to capture and transcribe this audio.
        </label>
        <p className="audio-note">
          {runtime?.mode === 'mock'
            ? 'Local mock transcript only; speech is not recognized.'
            : 'Audio clips go to your configured provider while listening; API charges apply.'}{' '}
          Computer audio includes all app playback. Hide/minimize stops listening.
        </p>
        {runtime && !runtime.transcriptionEnabled && (
          <p className="error">Transcription is disabled in your configuration.</p>
        )}
        {audioError && (
          <p className="error" role="alert">
            {audioError}
          </p>
        )}
        {listening === 'on' && (
          <div className="transcript-panel">
            <div className="audio-note">
              {transcribing ? 'Transcribing…' : 'Live transcript · approximately 5-second clips'}
            </div>
            <p className="transcript" aria-live="polite">
              {transcript || 'Waiting for the first completed audio clip…'}
            </p>
          </div>
        )}
      </section>
      <div className="solve-controls">
        <button onClick={() => window.assistant?.requestSolve()} disabled={status === 'thinking'}>
          {status === 'thinking' ? 'Working…' : 'Capture & answer'}
        </button>
        <span className="audio-note">
          Uses the latest completed transcript; wait for your words above before solving.
        </span>
      </div>
      <div className="timing" role="status">
        {status === 'idle'
          ? 'Ready · Ctrl+Alt+S captures the screen'
          : status === 'error'
            ? 'Request failed'
            : progress?.stage === 'capture'
              ? 'Capturing screen…'
              : status === 'done'
                ? 'Answer complete'
                : 'Waiting for answer…'}
        {progress?.captureMs !== undefined && ` · capture ${seconds(progress.captureMs)}`}
        {progress?.firstTokenMs !== undefined && ` · first text ${seconds(progress.firstTokenMs)}`}
        {progress?.totalMs !== undefined && ` · total ${seconds(progress.totalMs)}`}
      </div>
      <div className="body" ref={bodyRef} onScroll={onScroll}>
        {status === 'idle' && (
          <p className="placeholder">Open a problem, then capture. Listening is optional.</p>
        )}
        <div className="output">{rendered}</div>
      </div>
      <div className="footer">
        Ctrl+Alt: S capture · H hide/stop audio · I mouse · Q quit
        {!interactive && ' · Click-through enabled'}
      </div>
    </div>
  );
}
