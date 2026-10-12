import { AssistantConfig } from './config';

// LLM providers: Azure OpenAI (Pintu's real key) and any OpenAI-compatible
// endpoint (FastRouter for testing, OpenAI direct). One interface, so the
// solve loop never cares which backend is configured.

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

interface ChatMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

function buildMessages(imageBase64: string, context: string | undefined): ChatMessage[] {
  const userContent: Array<Record<string, unknown>> = [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
  ];
  if (context) {
    userContent.push({ type: 'text', text: `Interview context (transcript): ${context}` });
  }
  userContent.push({ type: 'text', text: 'Solve the coding problem shown in this screenshot.' });
  return [
    { role: 'system', content: SOLVER_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

async function enrichedError(res: Response, label: string): Promise<Error> {
  // Azure/OpenAI JSON error bodies carry the useful code/message — keep them.
  let detail = `${res.status} ${res.statusText}`;
  try {
    const text = (await res.text()).slice(0, 500);
    const json = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (json.error?.message) detail += ` — ${json.error.code ?? 'error'}: ${json.error.message}`;
  } catch {
    // Non-JSON body; status line is all we have.
  }
  return new Error(`${label} error: ${detail}`);
}

/** Shared SSE stream reader: yields markdown deltas, detects token cutoff. */
async function streamDeltas(res: Response, cb: SolveCallbacks, label: string): Promise<void> {
  if (!res.ok || !res.body) throw await enrichedError(res, label);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        let json: {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
        };
        try {
          json = JSON.parse(data);
        } catch {
          continue; // Skip malformed SSE lines.
        }
        const choice = json.choices?.[0];
        if (choice?.finish_reason === 'length') {
          throw new Error(
            'Response was cut off (token limit). Press the hotkey again for the rest.',
          );
        }
        const delta = choice?.delta?.content;
        if (delta) cb.onDelta(delta);
      }
    }
    buffer += decoder.decode(); // Flush split multi-byte chars.
  } finally {
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

/** Azure OpenAI: deployment-based URLs, api-key header. */
class AzureProvider implements LlmProvider {
  constructor(private cfg: AssistantConfig) {}

  private url(path: string): string {
    return `${this.cfg.endpoint.replace(/\/+$/, '')}${path}?api-version=${this.cfg.apiVersion}`;
  }

  async solve(
    imageBase64: string,
    context: string | undefined,
    cb: SolveCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(
      this.url(`/openai/deployments/${this.cfg.chatModel}/chat/completions`),
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
    const res = await fetch(
      this.url(`/openai/deployments/${this.cfg.whisperModel}/audio/transcriptions`),
      {
        method: 'POST',
        headers: { 'api-key': this.cfg.apiKey },
        body: transcriptionForm(audio, this.cfg.whisperModel, filename),
        signal,
      },
    );
    return parseTranscript(res, 'Azure OpenAI transcription');
  }
}

/** OpenAI-compatible: Bearer auth, /v1 paths. Covers FastRouter and OpenAI direct. */
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
        max_tokens: 3000,
        temperature: 0.2,
        stream: true,
      }),
      signal,
    });
    await streamDeltas(res, cb, 'LLM');
  }

  async transcribe(audio: Buffer, filename = 'audio.webm', signal?: AbortSignal): Promise<string> {
    const res = await fetch(this.url('/audio/transcriptions'), {
      method: 'POST',
      headers: this.headers(),
      body: transcriptionForm(audio, this.cfg.whisperModel, filename),
      signal,
    });
    return parseTranscript(res, 'Transcription');
  }
}

export function createProvider(cfg: AssistantConfig): LlmProvider {
  return cfg.provider === 'azure' ? new AzureProvider(cfg) : new OpenAiCompatibleProvider(cfg);
}
