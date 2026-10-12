import { useEffect, useRef, useState } from 'react';
import { MicRecorder, blobToBase64 } from './audio';

// Renderer: dumb display for the overlay. All logic lives in main.
// Expects window.assistant from the preload script.

interface AssistantBridge {
  requestSolve: () => void;
  toggleOverlay: () => void;
  onSolveDelta: (cb: (delta: string) => void) => () => void;
  onSolveDone: (cb: (ok: boolean, error?: string) => void) => () => void;
  onSolveStart: (cb: () => void) => () => void;
  onAudioRequest: (cb: (requestId: string) => void) => () => void;
  sendAudioResponse: (requestId: string, base64: string) => void;
}

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
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<'idle' | 'thinking' | 'done' | 'error'>('idle');
  const [listening, setListening] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const recorderRef = useRef<MicRecorder | null>(null);

  useEffect(() => {
    const bridge = window.assistant;
    if (!bridge) {
      setBridgeOk(false);
      return;
    }
    // Start mic capture; the overlay listens from launch. Failure is
    // non-fatal — solves still work, just without transcript context.
    const recorder = new MicRecorder();
    recorderRef.current = recorder;
    recorder.onStateChange = (recording) => setListening(recording);
    recorder
      .start()
      .then(() => setListening(recorder.isRecording))
      .catch(() => setListening(false));

    const offStart = bridge.onSolveStart(() => {
      setOutput('');
      setStatus('thinking');
      stickToBottom.current = true;
    });
    const offDelta = bridge.onSolveDelta((delta) => {
      setStatus('thinking');
      setOutput((prev) => prev + delta);
    });
    const offDone = bridge.onSolveDone((ok, error) => {
      setStatus(ok ? 'done' : 'error');
      if (!ok && error) setOutput((prev) => prev + `\n\n**Error:** ${error}`);
    });
    const offAudio = bridge.onAudioRequest((requestId) => {
      const rec = recorderRef.current;
      if (!rec) {
        bridge.sendAudioResponse(requestId, '');
        return;
      }
      // Lazy retry: a denied/unplugged mic at launch recovers on next hotkey.
      const ready = rec.isRecording ? Promise.resolve() : rec.start().catch(() => undefined);
      ready
        .then(() => rec.getRecentAudio())
        .then((blob) => blobToBase64(blob))
        .then((base64) => bridge.sendAudioResponse(requestId, base64))
        .catch(() => bridge.sendAudioResponse(requestId, ''));
    });
    return () => {
      offStart();
      offDelta();
      offDone();
      offAudio();
      recorder.stop();
    };
  }, []);

  // Auto-scroll to bottom as deltas stream, unless the user scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  if (!bridgeOk) {
    return (
      <div className="overlay">
        <div className="body">
          <p className="error">Bridge failed to load — reinstall the app.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay">
      <div className="header">
        <span
          className={`dot${listening ? ' listening' : ''}`}
          title={listening ? 'mic live' : 'mic off'}
        />
        <span>assistant</span>
        <span className="hint">Ctrl+Alt+S solve · Ctrl+Alt+H hide · Ctrl+Alt+Q quit</span>
      </div>
      <div className="body" ref={bodyRef} onScroll={onScroll}>
        {status === 'idle' && <p className="placeholder">Press Ctrl+Alt+S on a problem…</p>}
        {status === 'thinking' && !output && <p className="placeholder">thinking…</p>}
        <div className="output">{renderMarkdown(output)}</div>
        {status === 'error' && <p className="error">Solve failed — see above.</p>}
      </div>
    </div>
  );
}
