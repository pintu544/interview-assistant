const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider, ProviderError } = require('../dist/main/providers.js');

const config = (provider = 'openai-compatible', overrides = {}) => ({
  provider,
  endpoint: 'https://example.invalid/v1/',
  apiKey: 'test-key',
  chatModel: 'chat deployment',
  whisperModel: 'speech deployment',
  ...overrides,
});
const done = () => new Response('data: [DONE]\n\n');

function responseChunks(chunks) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
        controller.close();
      },
    }),
  );
}

async function stream(t, body, provider = 'openai-compatible') {
  t.mock.method(global, 'fetch', async () =>
    typeof body === 'string' ? new Response(body) : body,
  );
  const deltas = [];
  await createProvider(config(provider)).solve(
    'image',
    undefined,
    { onDelta: (value) => deltas.push(value) },
    new AbortController().signal,
  );
  return deltas.join('');
}

for (const provider of ['azure', 'openai-compatible']) {
  test(`${provider} solve sends image, accuracy/clarification instructions and uncertain transcript context`, async (t) => {
    let request;
    t.mock.method(global, 'fetch', async (url, init) => {
      request = { url, init };
      return done();
    });
    const signal = new AbortController().signal;
    await createProvider(config(provider, { apiVersion: '2025-01-01 preview' })).solve(
      'image-base64',
      'possibly incomplete words',
      { onDelta() {} },
      signal,
    );
    assert.equal(
      request.url,
      provider === 'azure'
        ? 'https://example.invalid/v1/openai/deployments/chat%20deployment/chat/completions?api-version=2025-01-01%20preview'
        : 'https://example.invalid/v1/chat/completions',
    );
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.signal, signal);
    assert.equal(request.init.headers['Content-Type'], 'application/json');
    if (provider === 'azure') {
      assert.equal(request.init.headers['api-key'], 'test-key');
      assert.equal(request.init.headers.Authorization, undefined);
    } else {
      assert.equal(request.init.headers.Authorization, 'Bearer test-key');
      assert.equal(request.init.headers['api-key'], undefined);
    }
    const body = JSON.parse(request.init.body);
    assert.equal(body.stream, true);
    assert.equal(
      Object.hasOwn(body, 'temperature'),
      false,
      'reasoning models must receive no implicit temperature',
    );
    assert.equal(body[provider === 'azure' ? 'max_tokens' : 'max_completion_tokens'], 3000);
    assert.equal(
      Object.hasOwn(body, provider === 'azure' ? 'max_completion_tokens' : 'max_tokens'),
      false,
    );
    if (provider === 'openai-compatible') assert.equal(body.model, 'chat deployment');
    const [system, user] = body.messages;
    assert.equal(body.messages.length, 2);
    assert.equal(system.role, 'system');
    assert.match(system.content, /visible language, function signature, and constraints/);
    assert.match(system.content, /transcript only as supporting context.*recognition mistakes/);
    assert.match(
      system.content,
      /missing or unreadable, ask a concise clarification instead of inventing/,
    );
    assert.match(system.content, /visible examples and edge cases/);
    assert.match(system.content, /For a complete problem/);
    for (const section of ['Solution', 'Explanation', 'Complexity'])
      assert.ok(system.content.includes(`## ${section}`));
    assert.equal(user.role, 'user');
    assert.deepEqual(user.content, [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,image-base64' } },
      {
        type: 'text',
        text: 'Recent audio transcript (may be incomplete): possibly incomplete words',
      },
      { type: 'text', text: 'Solve the coding problem shown in this screenshot.' },
    ]);
  });

  test(`${provider} omits empty transcript context and only sends explicitly configured temperature`, async (t) => {
    const bodies = [];
    t.mock.method(global, 'fetch', async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return done();
    });
    for (const context of [undefined, '']) {
      await createProvider(config(provider)).solve(
        'image',
        context,
        { onDelta() {} },
        new AbortController().signal,
      );
      const body = bodies.at(-1);
      assert.equal(Object.hasOwn(body, 'temperature'), false);
      assert.equal(body.messages[1].content.length, 2);
      assert.equal(
        body.messages[1].content.some((item) => item.text?.includes('transcript')),
        false,
      );
    }
    for (const temperature of [0, 0.2, 1]) {
      await createProvider(config(provider, { temperature })).solve(
        'image',
        undefined,
        { onDelta() {} },
        new AbortController().signal,
      );
      assert.equal(bodies.at(-1).temperature, temperature);
    }
  });

  test(`${provider} transcribe sends the fourth context argument as multipart prompt`, async (t) => {
    let request;
    t.mock.method(global, 'fetch', async (url, init) => {
      request = { url, init };
      return Response.json({ text: '  recognized speech  \n' });
    });
    const audio = Buffer.from([0, 1, 2, 127, 255]);
    const signal = new AbortController().signal;
    const result = await createProvider(config(provider, { apiVersion: '2025-01-01' })).transcribe(
      audio,
      'clip.webm',
      signal,
      'previous context: café',
    );
    assert.equal(result, 'recognized speech');
    assert.equal(
      request.url,
      provider === 'azure'
        ? 'https://example.invalid/v1/openai/deployments/speech%20deployment/audio/transcriptions?api-version=2025-01-01'
        : 'https://example.invalid/v1/audio/transcriptions',
    );
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.signal, signal);
    assert.equal(
      request.init.headers[provider === 'azure' ? 'api-key' : 'Authorization'],
      provider === 'azure' ? 'test-key' : 'Bearer test-key',
    );
    assert.equal(
      request.init.headers['Content-Type'],
      undefined,
      'fetch must supply the multipart boundary',
    );
    const form = request.init.body;
    assert.ok(form instanceof FormData);
    assert.deepEqual([...form.keys()], ['file', 'model', 'prompt']);
    assert.equal(form.get('model'), 'speech deployment');
    assert.equal(form.get('prompt'), 'previous context: café');
    assert.equal(form.has('temperature'), false);
    const file = form.get('file');
    assert.equal(file.name, 'clip.webm');
    assert.equal(file.type, 'audio/webm');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio);
  });

  test(`${provider} transcription omits an absent/empty prompt and defaults the filename`, async (t) => {
    const forms = [],
      urls = [];
    t.mock.method(global, 'fetch', async (url, init) => {
      forms.push(init.body);
      urls.push(url);
      return Response.json({});
    });
    for (const context of [undefined, '']) {
      const result = await createProvider(config(provider, { temperature: 0.2 })).transcribe(
        Buffer.from('audio'),
        undefined,
        undefined,
        context,
      );
      assert.equal(result, '');
      const form = forms.at(-1);
      assert.equal(form.has('prompt'), false);
      assert.equal(form.has('temperature'), false);
      assert.equal(form.get('file').name, 'audio.webm');
      assert.equal(urls.at(-1).includes('?'), false, 'no API version suffix when unconfigured');
    }
  });

  test(`${provider} disabled transcription returns empty text without making a request`, async (t) => {
    const fetch = t.mock.method(global, 'fetch', async () => {
      throw new Error('unexpected fetch');
    });
    assert.equal(
      await createProvider(config(provider, { transcriptionEnabled: false })).transcribe(
        Buffer.from('audio'),
        undefined,
        undefined,
        'context',
      ),
      '',
    );
    assert.equal(fetch.mock.callCount(), 0);
  });

  test(`${provider} propagates abort signals to both provider operations`, async (t) => {
    t.mock.method(global, 'fetch', async (_url, { signal }) => {
      signal.throwIfAborted();
      return done();
    });
    const controller = new AbortController();
    controller.abort();
    const instance = createProvider(config(provider));
    await assert.rejects(instance.solve('image', undefined, { onDelta() {} }, controller.signal), {
      name: 'AbortError',
    });
    await assert.rejects(
      instance.transcribe(Buffer.from('audio'), undefined, controller.signal, 'context'),
      { name: 'AbortError' },
    );
  });

  test(`${provider} enriches HTTP solve/transcription errors with status and provider details`, async (t) => {
    t.mock.method(global, 'fetch', async () =>
      Response.json(
        { error: { code: 'invalid_key', message: 'Access denied' } },
        { status: 401, statusText: 'Unauthorized' },
      ),
    );
    const instance = createProvider(config(provider));
    const check = (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.name, 'ProviderError');
      assert.equal(error.status, 401);
      assert.match(error.message, /401 Unauthorized.*invalid_key: Access denied/);
      return true;
    };
    await assert.rejects(
      instance.solve('image', undefined, { onDelta() {} }, new AbortController().signal),
      check,
    );
    await assert.rejects(instance.transcribe(Buffer.from('audio')), check);
  });

  test(`${provider} SSE handles CRLF and stops on DONE`, async (t) => {
    assert.equal(
      await stream(
        t,
        'data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
        provider,
      ),
      'ok',
    );
  });
}

test('SSE decodes split UTF-8, split CRLF, comments and multiline data without losing deltas', async (t) => {
  const body =
    ': heartbeat\r\nevent: message\r\nid: 1\r\n' +
    'data: {"choices":\r\ndata: [{"delta":{"content":"café 中文"}}]}\r\n\r\n' +
    'data: not JSON\r\n\r\ndata: {"choices":[{"delta":{"content":"!"}}]}\r\n\r\n' +
    'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(body);
  assert.equal(
    await stream(t, responseChunks([...bytes].map((byte) => Uint8Array.of(byte)))),
    'café 中文!',
  );
});

test('SSE accepts a terminal finish_reason at EOF without a DONE event or final newline', async (t) => {
  assert.equal(
    await stream(t, 'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}'),
    'complete',
  );
});

test('SSE accepts a DONE event at EOF without the final event separator', async (t) => {
  assert.equal(
    await stream(t, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]'),
    'ok',
  );
});

for (const [name, body, pattern] of [
  [
    'partial stream',
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    /ended before.*completion/,
  ],
  ['empty stream', '', /ended before.*completion/],
  ['malformed events only', 'data: not JSON\n\n', /ended before.*completion/],
  [
    'upstream error',
    'data: {"error":{"code":"overloaded","message":"try again"}}\n\n',
    /stream error: overloaded: try again/,
  ],
  [
    'token limit',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
    /cut off \(token limit\)/,
  ],
  [
    'content filter',
    'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n',
    /content filter/,
  ],
]) {
  test(`SSE rejects ${name} rather than reporting a completed answer`, async (t) => {
    await assert.rejects(stream(t, body), pattern);
  });
}

test('non-JSON HTTP errors retain the status rather than leaking a parser failure', async (t) => {
  t.mock.method(
    global,
    'fetch',
    async () => new Response('upstream is unavailable', { status: 503, statusText: 'Unavailable' }),
  );
  await assert.rejects(
    createProvider(config()).solve(
      'image',
      undefined,
      { onDelta() {} },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof ProviderError &&
      error.status === 503 &&
      /503 Unavailable/.test(error.message),
  );
});

test('SSE releases its reader after DONE without waiting for the HTTP connection to close', async (t) => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      },
    }),
  );
  t.after(() => response.body.cancel());
  assert.equal(await stream(t, response), '');
  assert.equal(response.body.locked, false);
});

test('SSE cancels and releases the reader when a delta callback fails', async (t) => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"code"}}]}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  t.mock.method(global, 'fetch', async () => response);
  await assert.rejects(
    createProvider(config()).solve(
      'image',
      undefined,
      {
        onDelta() {
          throw new Error('consumer failed');
        },
      },
      new AbortController().signal,
    ),
    /consumer failed/,
  );
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test('SSE releases its reader after a transport failure', async (t) => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('connection lost'));
      },
    }),
  );
  await assert.rejects(stream(t, response), /connection lost/);
  assert.equal(response.body.locked, false);
});
