const assert = require('assert');
const providers = require('../dist/main/providers.js');

async function stream(body) {
  const old = global.fetch;
  global.fetch = async () => new Response(body, { status: 200 });
  try {
    let output = '';
    await providers
      .createProvider({
        provider: 'openai-compatible',
        endpoint: 'https://example.invalid/v1',
        apiKey: 'k',
        chatModel: 'm',
        whisperModel: 'w',
      })
      .solve(
        'image',
        undefined,
        {
          onDelta: (value) => {
            output += value;
          },
        },
        new AbortController().signal,
      );
    return output;
  } finally {
    global.fetch = old;
  }
}

(async () => {
  assert.equal(
    await stream('data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'),
    'ok',
  );
  await assert.rejects(
    () => stream('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    /ended before/,
  );
  await assert.rejects(() => stream('data: {"error":{"message":"bad"}}\n\n'), /stream error/);
  await assert.rejects(
    () =>
      stream(
        'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n',
      ),
    /content filter/,
  );
  const old = global.fetch;
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response('data: [DONE]\n\n');
  };
  try {
    await providers
      .createProvider({
        provider: 'openai-compatible',
        endpoint: 'https://example.invalid/v1',
        apiKey: 'k',
        chatModel: 'm',
        transcriptionEnabled: false,
      })
      .solve('image', undefined, { onDelta() {} }, new AbortController().signal);
    assert.equal(request.url, 'https://example.invalid/v1/chat/completions');
  } finally {
    global.fetch = old;
  }
  console.log('providers tests: ok');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
