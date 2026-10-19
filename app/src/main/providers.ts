import { AssistantConfig } from './config';

const SOLVER_SYSTEM_PROMPT = `You are a senior engineer helping a candidate in a live coding interview.
Given a screenshot of a coding problem, respond with EXACTLY this structure:

## Solution
\`\`\`<language>
// complete, correct, runnable code
\`\`\`

## Explanation
2-4 sentences: the approach and why it works.

## Complexity
Time: O(...), Space: O(...)

Rules: plain code first, no preamble, no apologies. Under 200 words outside the code block.`;

export interface SolveCallbacks {
  onDelta: (delta: string) => void;
}

export interface LlmProvider {
  solve(
    imageBase64: string,
    context: string | undefined,
    cb: SolveCallbacks,
    signal: AbortSignal,
  ): Promise<void>;
  transcribe(audio: Buffer, filename?: string, signal?: AbortSignal): Promise<string>;
}

export class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface ChatMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

function buildMessages(imageBase64: string, context: string | undefined): ChatMessage[] {
  const userContent: Array<Record<string, unknown>> = [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
  ];
  if (context)
    userContent.push({ type: 'text', text: `Interview context (transcript): ${context}` });
  userContent.push({ type: 'text', text: 'Solve the coding problem shown in this screenshot.' });
  return [
    { role: 'system', content: SOLVER_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

async function enrichedError(res: Response, label: string): Promise<ProviderError> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const text = (await res.text()).slice(0, 500);
    const json = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (json.error?.message) detail += ` — ${json.error.code ?? 'error'}: ${json.error.message}`;
  } catch {
    /* status line is sufficient for non-JSON responses */
  }
  return new ProviderError(`${label} error: ${detail}`, res.status);
}

function streamError(label: string, message: string): Error {
  return new Error(`${label} stream error: ${message}`);
}

/** Read SSE without assuming network chunk boundaries coincide with lines/events. */
async function streamDeltas(res: Response, cb: SolveCallbacks, label: string): Promise<void> {
  if (!res.ok || !res.body) throw await enrichedError(res, label);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventData: string[] = [];
  let ended = false;
  let terminal = false;

  const dispatch = (): void => {
    if (!eventData.length) return;
    const data = eventData.join('\n').trim();
    eventData = [];
    if (!data) return;
    if (data === '[DONE]') {
      ended = true;
      terminal = true;
      return;
    }
    let json: {
      error?: { message?: string; code?: string };
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
    };
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error)
      throw streamError(
        label,
        `${json.error.code ?? 'error'}: ${json.error.message ?? 'upstream failure'}`,
      );
    const choice = json.choices?.[0];
    const reason = choice?.finish_reason;
    if (reason === 'length')
      throw streamError(
        label,
        'Response was cut off (token limit). Press the hotkey again for the rest.',
      );
    if (reason === 'content_filter')
      throw streamError(label, 'Response was blocked by the provider content filter.');
    if (reason) terminal = true;
    const delta = choice?.delta?.content;
    if (delta) cb.onDelta(delta);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') dispatch();
        else if (line.startsWith(':')) continue;
        else if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''));
      }
      if (ended) break;
    }
    buffer += decoder.decode();
    if (buffer) {
      if (buffer.startsWith('data:')) eventData.push(buffer.slice(5).replace(/^ /, ''));
      else if (!buffer.startsWith(':')) eventData.push(buffer);
    }
    dispatch();
    if (!terminal)
      throw streamError(label, 'Stream ended before the provider signaled completion.');
  } finally {
    if (!ended && typeof reader.cancel === 'function') {
      try {
        await reader.cancel();
      } catch {
        /* cancellation is best effort during abort/error cleanup */
      }
    }
    reader.releaseLock();
  }
}

function transcriptionForm(audio: Buffer, model: string, filename: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/webm' }), filename);
  form.append('model', model);
  return form;
}

async function parseTranscript(res: Response, label: string): Promise<string> {
  if (!res.ok) throw await enrichedError(res, label);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}

class AzureProvider implements LlmProvider {
  constructor(private cfg: AssistantConfig) {}
  private url(path: string): string {
    const suffix = this.cfg.apiVersion
      ? `?api-version=${encodeURIComponent(this.cfg.apiVersion)}`
      : '';
    return `${this.cfg.endpoint.replace(/\/+$/, '')}${path}${suffix}`;
  }
  async solve(
    imageBase64: string,
    context: string | undefined,
    cb: SolveCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(
      this.url(`/openai/deployments/${encodeURIComponent(this.cfg.chatModel)}/chat/completions`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': this.cfg.apiKey },
        body: JSON.stringify({
          messages: buildMessages(imageBase64, context),
          max_tokens: 3000,
          temperature: 0.2,
          stream: true,
        }),
        signal,
      },
    );
    await streamDeltas(res, cb, 'Azure OpenAI');
  }
  async transcribe(audio: Buffer, filename = 'audio.webm', signal?: AbortSignal): Promise<string> {
    if (this.cfg.transcriptionEnabled === false) return '';
    const model = this.cfg.whisperModel!;
    const res = await fetch(
      this.url(`/openai/deployments/${encodeURIComponent(model)}/audio/transcriptions`),
      {
        method: 'POST',
        headers: { 'api-key': this.cfg.apiKey },
        body: transcriptionForm(audio, model, filename),
        signal,
      },
    );
    return parseTranscript(res, 'Azure OpenAI transcription');
  }
}

class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private cfg: AssistantConfig) {}
  private url(path: string): string {
    return `${this.cfg.endpoint.replace(/\/+$/, '')}${path}`;
  }
  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.apiKey}` };
  }
  async solve(
    imageBase64: string,
    context: string | undefined,
    cb: SolveCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.chatModel,
        messages: buildMessages(imageBase64, context),
        // max_completion_tokens: required by gpt-5.x and newer; accepted by
        // older chat models (gpt-4o-mini etc.) and OpenAI-compatible routers.
        // (max_tokens is rejected by gpt-5.x with 400 unsupported_parameter.)
        max_completion_tokens: 3000,
        temperature: 0.2,
        stream: true,
      }),
      signal,
    });
    await streamDeltas(res, cb, 'LLM');
  }
  async transcribe(audio: Buffer, filename = 'audio.webm', signal?: AbortSignal): Promise<string> {
    if (this.cfg.transcriptionEnabled === false) return '';
    const model = this.cfg.whisperModel!;
    const res = await fetch(this.url('/audio/transcriptions'), {
      method: 'POST',
      headers: this.headers(),
      body: transcriptionForm(audio, model, filename),
      signal,
    });
    return parseTranscript(res, 'Transcription');
  }
}

export function createProvider(cfg: AssistantConfig): LlmProvider {
  return cfg.provider === 'azure' ? new AzureProvider(cfg) : new OpenAiCompatibleProvider(cfg);
}
