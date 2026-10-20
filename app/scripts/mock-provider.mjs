import http from 'node:http';

/**
 * Loopback stand-in for an OpenAI-compatible provider, so the app can be exercised
 * end to end without credentials, network access, or API spend.
 *
 * MOCK_MODE selects the behaviour under test:
 *   ok             stream a canned solution token by token
 *   unauthorized   401, which must block the solve rather than degrade it
 *   rate_limit     429 with an error body
 *   truncate       finish_reason "length", surfaced as a cut-off response
 *   content_filter finish_reason "content_filter"
 *   slow           hold the response past the app's 25s deadline
 *   asr_404        transcription unavailable, so the solve proceeds screenshot-only
 */
const MODE = process.env.MOCK_MODE ?? 'ok';
const TOKEN_DELAY_MS = Number(process.env.MOCK_TOKEN_DELAY_MS ?? 25);
const PORT = Number(process.env.MOCK_PORT ?? 8787);
const HOST = '127.0.0.1';

const SOLUTION = `## Solution
\`\`\`python
def lengthOfLongestSubstring(s: str) -> int:
    last: dict[str, int] = {}
    left = best = 0
    for i, ch in enumerate(s):
        if ch in last and last[ch] >= left:
            left = last[ch] + 1
        last[ch] = i
        best = max(best, i - left + 1)
    return best
\`\`\`

## Explanation
A sliding window whose left edge jumps past the previous occurrence of a repeated character, so every character is visited exactly once.

## Complexity
Time: O(n), Space: O(min(n, |alphabet|))
`;

const TRANSCRIPT =
  'mock transcript: walk me through how you would handle a string with repeated characters';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function imageSummary(body) {
  const match = body.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!match) return 'image=none';
  return `image=${Math.round((match[1].length * 3) / 4 / 1024)}KB`;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sse(res, status, headers) {
  res.writeHead(status, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...headers,
  });
}

function sseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleChat(req, res, rawBody) {
  const started = Date.now();
  console.log(
    `[mock chat] mode=${MODE} ${imageSummary(rawBody)} transcript=${rawBody.includes('mock transcript') || rawBody.includes('Interview context') ? 'yes' : 'no'}`,
  );

  if (MODE === 'unauthorized')
    return json(res, 401, { error: { code: 'invalid_api_key', message: 'mock: bad key' } });
  if (MODE === 'rate_limit')
    return json(res, 429, { error: { code: 'rate_limit_exceeded', message: 'mock: slow down' } });
  if (MODE === 'slow') {
    await sleep(40_000);
    return json(res, 200, { error: { message: 'mock: too late' } });
  }

  sse(res, 200);
  // req.destroyed is already true once the body has been read, so cancellation is tracked on the response.
  let cancelled = false;
  res.once('close', () => {
    cancelled = true;
  });
  sseEvent(res, { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] });
  for (const token of SOLUTION.split(/(?<=\s)/)) {
    if (cancelled || res.writableEnded) return;
    await sleep(TOKEN_DELAY_MS);
    sseEvent(res, { choices: [{ delta: { content: token }, finish_reason: null }] });
  }
  const reason =
    MODE === 'truncate' ? 'length' : MODE === 'content_filter' ? 'content_filter' : 'stop';
  sseEvent(res, { choices: [{ delta: {}, finish_reason: reason }] });
  res.write('data: [DONE]\n\n');
  res.end();
  console.log(`[mock chat] done in ${Date.now() - started}ms reason=${reason}`);
}

async function handleTranscribe(req, res) {
  if (MODE === 'asr_404')
    return json(res, 404, { error: { code: 'model_not_found', message: 'mock: no ASR' } });
  if (MODE === 'unauthorized')
    return json(res, 401, { error: { code: 'invalid_api_key', message: 'mock: bad key' } });
  console.log('[mock asr] transcription requested');
  return json(res, 200, { text: TRANSCRIPT });
}

export function startMockServer({ port = PORT, mode = MODE } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const raw = req.method === 'POST' ? await readBody(req) : '';
          if (req.url?.endsWith('/chat/completions')) return await handleChat(req, res, raw);
          if (req.url?.endsWith('/audio/transcriptions')) return await handleTranscribe(req, res);
          if (req.url === '/healthz') return json(res, 200, { ok: true, mode });
          return json(res, 404, { error: { message: `mock: no route for ${req.url}` } });
        } catch (error) {
          console.error('[mock] request failed:', error.message);
          if (!res.headersSent) json(res, 500, { error: { message: error.message } });
          else res.end();
        }
      })();
    });
    server.once('error', reject);
    server.listen(port, HOST, () => {
      const address = server.address();
      resolve({
        server,
        url: `http://${HOST}:${address.port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const { url } = await startMockServer();
  console.log(`mock provider listening on ${url} (mode=${MODE}, tokenDelay=${TOKEN_DELAY_MS}ms)`);
  console.log('Ctrl+C to stop.');
  process.once('SIGINT', () => process.exit(0));
}
