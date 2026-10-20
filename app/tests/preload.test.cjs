const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { IPC } = require('../dist/shared/ipc.js');

const MAX_AUDIO = 2 * 1024 * 1024;

function bridge(invoke = async () => ({ ok: true })) {
  const events = new EventEmitter();
  const sent = [],
    invoked = [];
  events.send = (channel, payload) => sent.push({ channel, payload });
  events.invoke = (channel, payload) => {
    invoked.push({ channel, payload });
    return invoke(channel, payload);
  };
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/main/preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron', 'sandbox preload must not require any local/Node module');
      return {
        ipcRenderer: events,
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'assistant');
            assert.equal(api, undefined, 'only one bridge is exposed');
            api = value;
          },
        },
      };
    },
  });
  return { api, events, sent, invoked };
}

test('bundled preload exposes only the current sandbox bridge and sends solve/overlay requests', () => {
  const { api, sent } = bridge();
  assert.deepEqual(
    Object.keys(api).sort(),
    [
      'requestSolve',
      'toggleOverlay',
      'getRuntimeInfo',
      'startListening',
      'stopListening',
      'transcribeChunk',
      'onListeningEnded',
      'onSolveDelta',
      'onSolveDone',
      'onSolveStart',
      'onSolveProgress',
      'onInteractionChanged',
    ].sort(),
  );
  api.requestSolve();
  api.toggleOverlay();
  assert.deepEqual(sent, [
    { channel: IPC.SOLVE_REQUEST, payload: undefined },
    { channel: IPC.OVERLAY_TOGGLE, payload: undefined },
  ]);
});

test('runtime, listening and transcription use invoke and return main-process results', async () => {
  const runtime = { mode: 'mock', model: 'mock-vision', transcriptionEnabled: true };
  const started = { ok: true, sessionId: 'session-1' };
  const transcript = { ok: true, text: 'completed context' };
  const { api, invoked, sent } = bridge(
    async (channel) =>
      ({
        [IPC.RUNTIME_INFO]: runtime,
        [IPC.LISTEN_START]: started,
        [IPC.AUDIO_CHUNK]: transcript,
      })[channel],
  );
  assert.equal(await api.getRuntimeInfo(), runtime);
  for (const source of ['microphone', 'system', 'both'])
    assert.equal(await api.startListening(source), started);
  assert.equal(await api.transcribeChunk('session-1', 0, 'YQ=='), transcript);
  api.stopListening('session-1');
  assert.deepEqual(
    invoked.map(({ channel }) => channel),
    [IPC.RUNTIME_INFO, IPC.LISTEN_START, IPC.LISTEN_START, IPC.LISTEN_START, IPC.AUDIO_CHUNK],
  );
  assert.equal(invoked[0].payload, undefined);
  assert.deepEqual(
    invoked.slice(1, 4).map(({ payload }) => payload),
    ['microphone', 'system', 'both'],
  );
  assert.deepEqual(
    { ...invoked[4].payload },
    { sessionId: 'session-1', sequence: 0, base64: 'YQ==' },
  );
  assert.deepEqual(sent, [{ channel: IPC.LISTEN_STOP, payload: 'session-1' }]);
});

test('invoke denials and rejections are not converted into false successes', async () => {
  const denied = { ok: false, error: 'Listening has stopped.' };
  const { api } = bridge(async () => denied);
  assert.equal(await api.startListening('microphone'), denied);
  assert.equal(await api.transcribeChunk('session', 0, 'YQ=='), denied);
  const failing = bridge(async () => {
    throw new Error('Untrusted caller.');
  });
  await assert.rejects(failing.api.getRuntimeInfo(), /Untrusted caller/);
  await assert.rejects(failing.api.startListening('both'), /Untrusted caller/);
  await assert.rejects(failing.api.transcribeChunk('session', 0, 'YQ=='), /Untrusted caller/);
});

test('invalid listening sources are rejected before IPC', async () => {
  const { api, invoked } = bridge();
  for (const source of [undefined, null, '', 1, {}, ['microphone'], 'camera', 'MICROPHONE']) {
    assert.deepEqual(
      { ...(await api.startListening(source)) },
      { ok: false, error: 'Invalid audio source.' },
    );
  }
  assert.equal(invoked.length, 0);
});

test('stop validates session ID type and the 128-character bound', () => {
  const { api, sent } = bridge();
  for (const id of [undefined, null, 1, {}, [], 'x'.repeat(129)]) api.stopListening(id);
  assert.equal(sent.length, 0);
  api.stopListening('x'.repeat(128));
  assert.deepEqual(sent, [{ channel: IPC.LISTEN_STOP, payload: 'x'.repeat(128) }]);
});

test('transcription validates session ID, sequence and audio bounds before invoking', async () => {
  const { api, invoked } = bridge();
  const invalid = [
    ...[undefined, null, 1, {}, 'x'.repeat(129)].map((id) => [id, 0, 'YQ==']),
    ...[undefined, null, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
      (sequence) => ['session', sequence, 'YQ=='],
    ),
    ...[undefined, null, 123, {}, '', 'A'.repeat(MAX_AUDIO + 1)].map((base64) => [
      'session',
      0,
      base64,
    ]),
  ];
  for (const args of invalid) {
    assert.deepEqual(
      { ...(await api.transcribeChunk(...args)) },
      { ok: false, error: 'Invalid audio clip.' },
    );
  }
  assert.equal(invoked.length, 0);
  assert.equal(
    (await api.transcribeChunk('x'.repeat(128), Number.MAX_SAFE_INTEGER, 'A'.repeat(MAX_AUDIO))).ok,
    true,
  );
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].payload.base64.length, MAX_AUDIO);
  assert.equal(invoked[0].payload.sequence, Number.MAX_SAFE_INTEGER);
});

test('preload validates delta/done/interaction messages and strips IPC event objects', () => {
  const { api, events } = bridge();
  const deltas = [],
    completions = [],
    interactions = [];
  const offDelta = api.onSolveDelta((...args) => deltas.push(args));
  const offDone = api.onSolveDone((...args) => completions.push(args));
  const offInteraction = api.onInteractionChanged((...args) => interactions.push(args));
  for (const value of [undefined, null, 1, 'message', {}, []]) {
    events.emit(IPC.SOLVE_DELTA, { secret: true }, value);
    events.emit(IPC.SOLVE_DONE, { secret: true }, value);
    events.emit(IPC.INTERACTION_CHANGED, { secret: true }, value);
  }
  events.emit(IPC.SOLVE_DELTA, {}, { delta: 42 });
  events.emit(IPC.SOLVE_DONE, {}, { ok: 'true' });
  events.emit(IPC.INTERACTION_CHANGED, {}, { interactive: 'true' });
  assert.deepEqual([deltas, completions, interactions], [[], [], []]);
  events.emit(IPC.SOLVE_DELTA, { secret: true }, { delta: 'code' });
  events.emit(IPC.SOLVE_DELTA, {}, { delta: '' });
  events.emit(IPC.SOLVE_DONE, { secret: true }, { ok: false, error: 'failed' });
  events.emit(IPC.SOLVE_DONE, {}, { ok: true, error: 42 });
  events.emit(IPC.INTERACTION_CHANGED, { secret: true }, { interactive: true });
  events.emit(IPC.INTERACTION_CHANGED, {}, { interactive: false });
  assert.deepEqual(deltas, [['code'], ['']]);
  assert.deepEqual(completions, [
    [false, 'failed'],
    [true, undefined],
  ]);
  assert.deepEqual(interactions, [[true], [false]]);
  offDelta();
  offDone();
  offInteraction();
  for (const channel of [IPC.SOLVE_DELTA, IPC.SOLVE_DONE, IPC.INTERACTION_CHANGED])
    assert.equal(events.listenerCount(channel), 0);
});

test('solve-start and listening-ended subscriptions expose no event or payload and unsubscribe', () => {
  const { api, events } = bridge();
  for (const [method, channel] of [
    ['onSolveStart', IPC.SOLVE_START],
    ['onListeningEnded', IPC.LISTEN_ENDED],
  ]) {
    const received = [];
    const off = api[method]((...args) => received.push(args));
    events.emit(channel, { secret: true }, { sessionId: 'private' });
    assert.deepEqual(received, [[]]);
    off();
    off();
    events.emit(channel, {});
    assert.deepEqual(received, [[]]);
    assert.equal(events.listenerCount(channel), 0);
  }
});

test('progress accepts the three stages and optional finite nonnegative timings', () => {
  const { api, events } = bridge();
  const received = [];
  const off = api.onSolveProgress((...args) => received.push(args));
  const valid = [
    { stage: 'capture' },
    { stage: 'answer', captureMs: 0 },
    { stage: 'answer', captureMs: 1.5, firstTokenMs: 12 },
    { stage: 'complete', captureMs: 4, firstTokenMs: 20, totalMs: 30 },
    { stage: 'complete', captureMs: 0, totalMs: 0 },
  ];
  for (const payload of valid) events.emit(IPC.SOLVE_PROGRESS, { secret: true }, payload);
  assert.deepEqual(
    received,
    valid.map((value) => [value]),
  );
  off();
  events.emit(IPC.SOLVE_PROGRESS, {}, { stage: 'capture' });
  assert.equal(received.length, valid.length);
  assert.equal(events.listenerCount(IPC.SOLVE_PROGRESS), 0);
});

test('progress rejects unknown stages, malformed payloads and invalid timings', () => {
  const { api, events } = bridge();
  const received = [];
  api.onSolveProgress((value) => received.push(value));
  const invalid = [
    undefined,
    null,
    1,
    'capture',
    [],
    {},
    ...[undefined, null, '', 'transcribe', 'done', 1, {}].map((stage) => ({ stage })),
    ...['captureMs', 'firstTokenMs', 'totalMs'].flatMap((key) =>
      [-1, NaN, Infinity, -Infinity, '1', null, {}].map((value) => ({
        stage: 'answer',
        [key]: value,
      })),
    ),
  ];
  for (const payload of invalid) events.emit(IPC.SOLVE_PROGRESS, {}, payload);
  assert.deepEqual(received, []);
});

test('progress stage must be a string, not an array that coerces to a valid stage', () => {
  const { api, events } = bridge();
  const received = [];
  api.onSolveProgress((value) => received.push(value));
  for (const stage of [['capture'], ['answer'], ['complete']])
    events.emit(IPC.SOLVE_PROGRESS, {}, { stage });
  assert.deepEqual(received, []);
});

test('unsubscribing one listener leaves other subscribers active', () => {
  const { api, events } = bridge();
  for (const [method, channel, payload] of [
    ['onSolveStart', IPC.SOLVE_START, undefined],
    ['onListeningEnded', IPC.LISTEN_ENDED, undefined],
    ['onSolveDelta', IPC.SOLVE_DELTA, { delta: 'code' }],
    ['onSolveDone', IPC.SOLVE_DONE, { ok: true }],
    ['onSolveProgress', IPC.SOLVE_PROGRESS, { stage: 'capture' }],
    ['onInteractionChanged', IPC.INTERACTION_CHANGED, { interactive: true }],
  ]) {
    let first = 0,
      second = 0;
    const offFirst = api[method](() => first++);
    const offSecond = api[method](() => second++);
    offFirst();
    events.emit(channel, {}, payload);
    assert.equal(first, 0, method);
    assert.equal(second, 1, method);
    offSecond();
    assert.equal(events.listenerCount(channel), 0, method);
  }
});
