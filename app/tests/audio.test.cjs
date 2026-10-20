const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');

const sourcePath = path.resolve(__dirname, '../src/renderer/audio.ts');
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const MIME_TYPE = 'audio/webm;codecs=opus';
const plain = (value) => JSON.parse(JSON.stringify(value));

class Track {
  constructor(kind = 'audio') {
    this.kind = kind;
    this.readyState = 'live';
    this.stopped = 0;
    this.listeners = new Set();
  }
  addEventListener(type, listener) {
    assert.equal(type, 'ended');
    this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    assert.equal(type, 'ended');
    this.listeners.delete(listener);
  }
  stop() {
    this.stopped++;
    this.readyState = 'ended';
    // Like the browser, intentional stop() does not dispatch ended.
  }
  end() {
    this.readyState = 'ended';
    for (const listener of [...this.listeners]) listener();
  }
}

class Stream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Drain permission/resume continuations without waiting on a real recording timer.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function makeHarness(settings = {}) {
  const mic = settings.mic || new Stream([new Track()]);
  const display = settings.display || new Stream([new Track(), new Track('video')]);
  const calls = [];
  const contexts = [];
  const recorders = [];
  const timers = new Map();
  const stopEvents = [];
  let now = 0;
  let nextTimer = 0;

  class AudioNode {
    constructor(kind, stream) {
      this.kind = kind;
      this.stream = stream;
      this.connections = [];
      this.disconnected = 0;
      this.gain = { value: 1 };
    }
    connect(target) {
      this.connections.push(target);
      return target;
    }
    disconnect() {
      this.disconnected++;
    }
  }

  class FakeAudioContext {
    constructor() {
      if (settings.contextThrows) throw new Error('audio context unavailable');
      this.state = 'suspended';
      this.nodes = [];
      this.sources = [];
      this.gains = [];
      this.destination = new AudioNode('speakers');
      this.closed = 0;
      this.resumed = 0;
      contexts.push(this);
    }
    createMediaStreamDestination() {
      this.output = new AudioNode('mixed', settings.mixed || new Stream([new Track()]));
      this.nodes.push(this.output);
      return this.output;
    }
    createMediaStreamSource(stream) {
      const node = new AudioNode('source', stream);
      this.sources.push(node);
      this.nodes.push(node);
      return node;
    }
    createGain() {
      if (settings.gainThrows) throw new Error('gain unavailable');
      const node = new AudioNode('gain');
      this.gains.push(node);
      this.nodes.push(node);
      return node;
    }
    async resume() {
      this.resumed++;
      if (settings.resume) await settings.resume();
      if (this.state !== 'closed') this.state = 'running';
    }
    async close() {
      this.closed++;
      this.state = 'closed';
      if (settings.closeRejects) throw new Error('context already closed');
    }
  }

  class FakeRecorder {
    static isTypeSupported(type) {
      assert.equal(type, MIME_TYPE);
      return settings.supported !== false;
    }
    constructor(stream, options) {
      this.id = recorders.length + 1;
      if (settings.constructorFailureAt === this.id) throw new Error('encoder constructor failed');
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onerror = null;
      this.onstop = null;
      this.startCalls = [];
      this.stopped = 0;
      // Model a per-recorder header, never a header on subsequent data chunks.
      this.header = Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.from(`clip-${this.id}|`),
      ]);
      this.headerSent = false;
      recorders.push(this);
    }
    start(...args) {
      this.startCalls.push(args);
      if (settings.startFailureAt === this.id) throw new Error('encoder start failed');
      this.state = 'recording';
      if (settings.errorOnStart) this.error('encoder failed during start');
    }
    stop() {
      this.stopped++;
      if (settings.stopFailureAt === this.id) throw new Error('encoder stop failed');
      assert.equal(this.state, 'recording');
      this.state = 'inactive';
      const finish = () => {
        if (!settings.emptyClips) this.emit(`final-${this.id}`);
        this.onstop?.();
      };
      if (settings.synchronousStop) finish();
      else stopEvents.push(finish);
    }
    emit(body) {
      const parts = this.headerSent ? [body] : [this.header, body];
      this.headerSent = true;
      this.ondataavailable?.({ data: new Blob(parts, { type: MIME_TYPE }) });
    }
    emitEmpty() {
      this.ondataavailable?.({ data: new Blob([]) });
    }
    error(message = 'audio device lost') {
      this.onerror?.({ error: new Error(message) });
    }
    endUnexpectedly() {
      this.state = 'inactive';
      this.onstop?.();
    }
  }

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    Blob,
    Uint8Array,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    navigator: {
      mediaDevices: {
        getDisplayMedia(constraints) {
          calls.push({ source: 'display', constraints: plain(constraints) });
          return settings.getDisplayMedia
            ? settings.getDisplayMedia(constraints)
            : Promise.resolve(display);
        },
        getUserMedia(constraints) {
          calls.push({ source: 'microphone', constraints: plain(constraints) });
          return settings.getUserMedia ? settings.getUserMedia(constraints) : Promise.resolve(mic);
        },
      },
    },
    MediaStream: Stream,
    AudioContext: FakeAudioContext,
    MediaRecorder: FakeRecorder,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(transpiled, { filename: sourcePath }).runInContext(sandbox, { timeout: 5000 });
  const recorder = new mod.exports.AudioRecorder();
  const states = [];
  const errors = [];
  const segments = [];
  recorder.onStateChange = (state) => states.push(state);
  recorder.onError = (message) => errors.push(message);
  recorder.onSegment = (blob) => segments.push(blob);

  return {
    ...mod.exports,
    recorder,
    settings,
    sandbox,
    mic,
    display,
    calls,
    contexts,
    recorders,
    timers,
    states,
    errors,
    segments,
    tick(ms = 5000) {
      const target = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    },
    flushStops() {
      while (stopEvents.length) stopEvents.shift()();
    },
  };
}

function assertReleased(h, ...streams) {
  assert.equal(h.recorder.isRecording, false);
  assert.equal(h.timers.size, 0);
  for (const stream of streams) {
    for (const track of stream.getTracks()) {
      assert.equal(track.stopped, 1, `${track.kind} track must be stopped exactly once`);
      assert.equal(track.listeners.size, 0);
    }
  }
  for (const context of h.contexts) {
    assert.equal(context.closed, 1);
    for (const track of context.output.stream.getTracks()) {
      assert.equal(track.stopped, 1, 'mixed track must be released');
      assert.equal(track.listeners.size, 0);
    }
    for (const node of context.nodes) assert.equal(node.disconnected, 1);
  }
  for (const recorder of h.recorders) {
    assert.equal(recorder.ondataavailable, null);
    assert.equal(recorder.onerror, null);
    assert.equal(recorder.onstop, null);
  }
}

function assertMix(h, inputs, gain) {
  assert.equal(h.contexts.length, 1);
  const context = h.contexts[0];
  assert.equal(context.resumed, 1);
  assert.equal(context.sources.length, inputs.length);
  assert.equal(context.gains.length, inputs.length);
  inputs.forEach((input, index) => {
    const source = context.sources[index];
    assert.deepEqual(source.stream.getTracks(), input.getAudioTracks());
    assert.deepEqual(source.connections, [context.gains[index]]);
    assert.equal(context.gains[index].gain.value, gain);
    assert.deepEqual(context.gains[index].connections, [context.output]);
  });
  assert.ok(context.nodes.every((node) => !node.connections.includes(context.destination)));
  assert.deepEqual(h.recorders[0].stream.getTracks(), context.output.stream.getAudioTracks());
  assert.deepEqual(plain(h.recorders[0].options), {
    mimeType: MIME_TYPE,
    audioBitsPerSecond: 64000,
  });
  assert.deepEqual(h.recorders[0].startCalls, [[]]);
}

test('audio module type-checks in isolation against browser APIs', () => {
  const program = ts.createProgram([sourcePath], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
    types: [],
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
  );
});

test('construction and idle stop do not acquire audio or notify state', () => {
  const h = makeHarness();
  const fresh = new h.AudioRecorder();
  assert.equal(fresh.onStateChange, null);
  assert.equal(fresh.onError, null);
  assert.equal(fresh.onSegment, null);
  h.recorder.stop();
  h.tick(60000);
  assert.equal(h.recorder.isRecording, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.contexts.length, 0);
  assert.deepEqual(h.states, []);
});

test('both prompts for display synchronously first, stops video, then mixes both audio inputs', async () => {
  const displayPermission = deferred();
  const micPermission = deferred();
  const h = makeHarness({
    getDisplayMedia: () => displayPermission.promise,
    getUserMedia: () => micPermission.promise,
  });
  const pending = h.recorder.start('both');
  assert.deepEqual(h.calls, [{ source: 'display', constraints: { video: true, audio: true } }]);
  assert.equal(h.recorder.isRecording, false);
  displayPermission.resolve(h.display);
  await settle();
  assert.deepEqual(h.calls[1], {
    source: 'microphone',
    constraints: {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    },
  });
  assert.equal(h.display.getVideoTracks()[0].stopped, 1);
  assert.equal(h.display.getAudioTracks()[0].stopped, 0);
  assert.equal(h.contexts.length, 0);
  micPermission.resolve(h.mic);
  await pending;
  assertMix(h, [h.display, h.mic], 0.5);
  assert.equal(h.recorder.isRecording, true);
  assert.deepEqual(h.states, [true]);
  h.recorder.stop();
  h.recorder.stop();
  assertReleased(h, h.display, h.mic);
  assert.deepEqual(h.states, [true, false]);
  assert.deepEqual(h.errors, []);
});

for (const source of ['microphone', 'system']) {
  test(`${source}-only acquires just that source with unity gain`, async () => {
    const h = makeHarness();
    await h.recorder.start(source);
    const input = source === 'system' ? h.display : h.mic;
    assert.deepEqual(
      h.calls.map((call) => call.source),
      [source === 'system' ? 'display' : 'microphone'],
    );
    assertMix(h, [input], 1);
    assert.equal(input.getAudioTracks()[0].stopped, 0);
    h.recorder.stop();
    assertReleased(h, input);
    const unused = source === 'system' ? h.mic : h.display;
    assert.ok(unused.getTracks().every((track) => track.stopped === 0));
  });
}

for (const source of ['system', 'both']) {
  test(`${source} rejects missing system audio without microphone fallback`, async () => {
    const h = makeHarness({ display: new Stream([new Track('video'), new Track('video')]) });
    await assert.rejects(h.recorder.start(source), /Computer audio.*audio track.*audio sharing/);
    assert.deepEqual(
      h.calls.map((call) => call.source),
      ['display'],
    );
    assert.equal(h.contexts.length, 0);
    assert.equal(h.errors.length, 1);
    assertReleased(h, h.display);
    h.tick(60000);
    assert.equal(h.calls.length, 1, 'no automatic retry');
  });
}

test('missing microphone audio also fails and releases every acquired track', async () => {
  const h = makeHarness({ mic: new Stream([new Track('video')]) });
  await assert.rejects(h.recorder.start('both'), /Microphone.*audio track/);
  assertReleased(h, h.display, h.mic);
  assert.equal(h.recorders.length, 0);
});

test('display denial never asks for microphone or retries automatically', async () => {
  const h = makeHarness({
    getDisplayMedia: async () => {
      throw new Error('Permission denied');
    },
  });
  await assert.rejects(
    h.recorder.start('both'),
    /Computer audio capture failed.*Permission denied/,
  );
  h.tick(60000);
  assert.deepEqual(
    h.calls.map((call) => call.source),
    ['display'],
  );
  assert.equal(h.contexts.length, 0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.recorder.isRecording, false);
});

test('microphone denial releases already acquired display audio and permits only an explicit retry', async () => {
  const h = makeHarness({
    getUserMedia: async () => {
      throw new Error('Permission denied');
    },
  });
  await assert.rejects(h.recorder.start('both'), /Microphone capture failed.*Permission denied/);
  assertReleased(h, h.display);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.errors.length, 1);
  h.tick(60000);
  assert.equal(h.calls.length, 2);
  h.settings.getUserMedia = null;
  await h.recorder.start('microphone');
  assert.equal(h.recorder.isRecording, true);
  h.recorder.stop();
  assertReleased(h, h.display, h.mic);
});

test('synchronous permission failure clears pending start for an explicit retry', async () => {
  const h = makeHarness({
    getDisplayMedia: () => {
      throw new Error('User activation required');
    },
  });
  await assert.rejects(h.recorder.start('system'), /User activation required/);
  h.settings.getDisplayMedia = null;
  await h.recorder.start('system');
  assert.equal(h.calls.length, 2);
  h.recorder.stop();
  assertReleased(h, h.display);
});

test('unsupported display capture reports a source error without fallback', async () => {
  const h = makeHarness();
  delete h.sandbox.navigator.mediaDevices.getDisplayMedia;
  await assert.rejects(h.recorder.start('both'), /Computer audio sharing is not supported/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
});

test('unsupported WebM/Opus rejects instead of silently recording a different format', async () => {
  const h = makeHarness({ supported: false });
  await assert.rejects(h.recorder.start('both'), /WebM\/Opus.*not supported/);
  assertReleased(h, h.display, h.mic);
  assert.equal(h.recorders.length, 0);
});

for (const [setting, message] of [
  ['constructorFailureAt', /encoder constructor failed/],
  ['startFailureAt', /encoder start failed/],
]) {
  test(`${setting} during startup closes context and stops original/mixed tracks`, async () => {
    const h = makeHarness({ [setting]: 1 });
    await assert.rejects(h.recorder.start('both'), message);
    assertReleased(h, h.display, h.mic);
    assert.deepEqual(h.states, []);
    assert.equal(h.errors.length, 1);
    h.flushStops();
    assert.equal(h.segments.length, 0);
  });
}

for (const settings of [
  { contextThrows: true },
  { gainThrows: true },
  {
    resume: async () => {
      throw new Error('resume denied');
    },
  },
]) {
  test(`mixing failure (${Object.keys(settings)[0]}) releases acquired resources`, async () => {
    const h = makeHarness(settings);
    await assert.rejects(h.recorder.start('both'), /Audio mixing failed/);
    assertReleased(h, h.display, h.mic);
    assert.equal(h.errors.length, 1);
    assert.equal(h.recorders.length, 0);
  });
}

test('concurrent and already-active starts neither reacquire nor change the source', async () => {
  const permission = deferred();
  const h = makeHarness({ getUserMedia: () => permission.promise });
  const first = h.recorder.start('microphone');
  const duplicate = h.recorder.start('both');
  assert.strictEqual(first, duplicate);
  assert.equal(h.calls.length, 1);
  permission.resolve(h.mic);
  await Promise.all([first, duplicate]);
  await h.recorder.start('system');
  assert.equal(h.calls.length, 1);
  assert.equal(h.recorders.length, 1);
  assert.deepEqual(h.states, [true]);
  h.recorder.stop();
  assertReleased(h, h.mic);
});

for (const source of ['microphone', 'system', 'both']) {
  test(`stop while ${source} permission is pending releases the late stream without callbacks`, async () => {
    const permission = deferred();
    const h = makeHarness({
      getUserMedia: () => permission.promise,
      getDisplayMedia: () => permission.promise,
    });
    const pending = h.recorder.start(source);
    h.recorder.stop();
    const late = source === 'microphone' ? h.mic : h.display;
    permission.resolve(late);
    await pending;
    assertReleased(h, late);
    assert.equal(h.calls.length, 1);
    assert.equal(h.contexts.length, 0);
    assert.deepEqual(h.states, []);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.segments, []);
  });
}

test('stop during the second permission releases display immediately and microphone on arrival', async () => {
  const permission = deferred();
  const h = makeHarness({ getUserMedia: () => permission.promise });
  const pending = h.recorder.start('both');
  await settle();
  h.recorder.stop();
  assertReleased(h, h.display);
  permission.resolve(h.mic);
  await pending;
  assertReleased(h, h.display, h.mic);
  assert.equal(h.contexts.length, 0);
  assert.deepEqual(h.errors, []);
});

test('late acquisition and captured stale callbacks cannot affect a newer active session', async () => {
  const oldPermission = deferred();
  const late = new Stream([new Track(), new Track('video')]);
  let calls = 0;
  const h = makeHarness({
    getUserMedia: () => (++calls === 1 ? oldPermission.promise : Promise.resolve(h.mic)),
  });
  const pending = h.recorder.start('microphone');
  h.recorder.stop();
  await h.recorder.start('microphone');
  oldPermission.resolve(late);
  await pending;
  assert.ok(late.getTracks().every((track) => track.stopped === 1));
  assert.equal(h.mic.getAudioTracks()[0].stopped, 0);
  assert.equal(h.recorder.isRecording, true);
  assert.equal(h.recorders.length, 1);
  h.recorder.stop();
  assertReleased(h, h.mic, late);
});

test('a cancelled rejection does not clear a newer pending start or report stale errors', async () => {
  const oldPermission = deferred();
  const newPermission = deferred();
  let calls = 0;
  const h = makeHarness({
    getUserMedia: () => (++calls === 1 ? oldPermission.promise : newPermission.promise),
  });
  const oldStart = h.recorder.start('microphone');
  h.recorder.stop();
  const newStart = h.recorder.start('microphone');
  oldPermission.reject(new Error('old permission denied'));
  await oldStart;
  const duplicate = h.recorder.start('both');
  assert.strictEqual(duplicate, newStart);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.errors, []);
  newPermission.resolve(h.mic);
  await Promise.all([newStart, duplicate]);
  h.recorder.stop();
  assertReleased(h, h.mic);
});

test('stop and restart during AudioContext.resume closes the old graph without starting its recorder', async () => {
  const resume = deferred();
  const h = makeHarness({ resume: () => resume.promise });
  const oldStart = h.recorder.start('both');
  await settle();
  assert.equal(h.contexts.length, 1);
  h.recorder.stop();
  assertReleased(h, h.display, h.mic);
  const newerMic = new Stream([new Track()]);
  h.settings.resume = null;
  h.settings.getUserMedia = async () => newerMic;
  await h.recorder.start('microphone');
  resume.resolve();
  await oldStart;
  assert.equal(h.recorder.isRecording, true);
  assert.equal(h.recorders.length, 1);
  assert.equal(h.contexts[1].closed, 0);
  assert.equal(newerMic.getAudioTracks()[0].stopped, 0);
  h.recorder.stop();
  assertReleased(h, h.display, h.mic, newerMic);
});

test('each interval immediately starts a fresh recorder and emits its own complete header on onstop', async () => {
  const h = makeHarness();
  await h.recorder.start('both');
  h.tick(4999);
  assert.equal(h.recorders.length, 1);
  assert.equal(h.segments.length, 0);
  h.tick(1);
  assert.equal(h.recorders.length, 2, 'next recorder starts before previous onstop');
  assert.equal(h.recorders[1].state, 'recording');
  assert.equal(h.segments.length, 0, 'do not emit before onstop');
  h.flushStops();
  assert.equal(h.segments.length, 1);
  for (let index = 1; index < 20; index++) {
    const current = h.recorders[index];
    current.emitEmpty();
    current.emit(`body-${current.id}|`);
    current.emit(`more-${current.id}|`);
    assert.equal(h.segments.length, index);
    h.tick();
    assert.equal(h.recorders.length, index + 2);
    assert.equal(h.timers.size, 1);
    h.flushStops();
    assert.equal(h.segments.length, index + 1);
  }
  for (let index = 0; index < h.segments.length; index++) {
    const recorder = h.recorders[index];
    const body = index === 0 ? '' : `body-${recorder.id}|more-${recorder.id}|`;
    const expected = Buffer.concat([recorder.header, Buffer.from(`${body}final-${recorder.id}`)]);
    assert.equal(h.segments[index].type, MIME_TYPE);
    assert.deepEqual(Buffer.from(await h.segments[index].arrayBuffer()), expected);
    assert.deepEqual(plain(recorder.options), { mimeType: MIME_TYPE, audioBitsPerSecond: 64000 });
    assert.equal(recorder.ondataavailable, null, 'finished chunks/callbacks are released');
    assert.equal(recorder.onstop, null);
  }
  assert.deepEqual(h.states, [true], 'rotation does not flicker recording state');
  h.recorder.stop();
  h.flushStops();
  assert.equal(h.segments.length, 20, 'unfinished last clip is discarded');
  assertReleased(h, h.display, h.mic);
});

test('synchronous onstop also emits complete clips and permits immediate rotation', async () => {
  const h = makeHarness({ synchronousStop: true });
  await h.recorder.start('microphone');
  h.tick();
  assert.equal(h.segments.length, 1);
  assert.equal(h.recorders.length, 2);
  assert.equal(h.recorder.isRecording, true);
  h.recorder.stop();
  assert.equal(h.segments.length, 1);
  assertReleased(h, h.mic);
});

test('empty completed audio is an error, not a segment or an automatic retry', async () => {
  const h = makeHarness({ emptyClips: true });
  await h.recorder.start('system');
  h.recorders[0].emitEmpty();
  h.tick();
  h.flushStops();
  assert.equal(h.segments.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /No audio was captured from computer audio/);
  assertReleased(h, h.display);
  h.tick(60000);
  assert.equal(h.calls.length, 1);
});

test('a stalled finalization is bounded to two recorders and tears down instead of accumulating', async () => {
  const h = makeHarness();
  await h.recorder.start('microphone');
  h.tick();
  assert.equal(h.recorders.length, 2);
  h.tick(); // Deliberately never deliver the previous stop event.
  assert.equal(h.recorders.length, 2);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /did not finish the previous audio clip/);
  assertReleased(h, h.mic);
  h.flushStops();
  assert.equal(h.segments.length, 0);
});

test('stop discards active and finalizing clips; saved old events/timers cannot contaminate a restart', async () => {
  const h = makeHarness();
  await h.recorder.start('both');
  h.recorders[0].emit('unfinished');
  const oldTimer = [...h.timers.values()][0].callback;
  const oldEnded = [...h.display.getAudioTracks()[0].listeners][0];
  h.tick();
  const stale = h.recorders.map((recorder) => ({
    data: recorder.ondataavailable,
    error: recorder.onerror,
    stop: recorder.onstop,
  }));
  const activeTimer = [...h.timers.values()][0].callback;
  h.recorder.stop();
  assertReleased(h, h.display, h.mic);
  const newerMic = new Stream([new Track()]);
  h.settings.getUserMedia = async () => newerMic;
  await h.recorder.start('microphone');
  oldTimer();
  activeTimer();
  oldEnded();
  for (const callbacks of stale) {
    callbacks.data({ data: new Blob(['stale header']) });
    callbacks.error({ error: new Error('stale failure') });
    callbacks.stop();
  }
  h.flushStops();
  assert.equal(h.recorder.isRecording, true);
  assert.equal(h.recorders.length, 3);
  assert.equal(h.timers.size, 1);
  assert.deepEqual(h.errors, []);
  assert.equal(h.segments.length, 0);
  h.tick();
  h.flushStops();
  assert.deepEqual(
    Buffer.from(await h.segments[0].arrayBuffer()),
    Buffer.concat([h.recorders[2].header, Buffer.from('final-3')]),
  );
  h.recorder.stop();
  h.flushStops();
  assertReleased(h, h.display, h.mic, newerMic);
  assert.deepEqual(h.states, [true, false, true, false]);
  assert.equal(h.segments.length, 1);
});

for (const [setting, message] of [
  ['constructorFailureAt', /encoder constructor failed/],
  ['startFailureAt', /encoder start failed/],
  ['stopFailureAt', /encoder stop failed/],
]) {
  test(`${setting} during rotation stops the entire session and discards pending audio`, async () => {
    const h = makeHarness({ [setting]: setting === 'stopFailureAt' ? 1 : 2 });
    await h.recorder.start('both');
    h.tick();
    assertReleased(h, h.display, h.mic);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], message);
    h.flushStops();
    assert.equal(h.segments.length, 0);
  });
}

for (const target of ['active', 'finalizing']) {
  test(`an error from the ${target} recorder stops every source`, async () => {
    const h = makeHarness();
    await h.recorder.start('both');
    if (target === 'finalizing') h.tick();
    h.recorders[0].error('encoder device disconnected');
    assertReleased(h, h.display, h.mic);
    assert.equal(h.errors.length, 1);
    assert.match(
      h.errors[0],
      /Microphone and computer audio recorder failed.*encoder device disconnected/,
    );
    assert.deepEqual(h.states, [true, false]);
    h.flushStops();
    assert.equal(h.segments.length, 0);
  });
}

test('a synchronous recorder error during start never announces recording', async () => {
  const h = makeHarness({ errorOnStart: true });
  await h.recorder.start('microphone');
  assertReleased(h, h.mic);
  assert.deepEqual(h.states, []);
  assert.equal(h.errors.length, 1);
});

test('unexpected recorder stop is a device/source error, not a completed segment', async () => {
  const h = makeHarness();
  await h.recorder.start('microphone');
  h.recorders[0].emit('partial');
  h.recorders[0].endUnexpectedly();
  assertReleased(h, h.mic);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /Microphone recorder stopped unexpectedly/);
  assert.equal(h.segments.length, 0);
});

for (const target of ['microphone', 'display', 'mixed']) {
  test(`${target} audio ending stops the session with a useful source error`, async () => {
    const h = makeHarness();
    await h.recorder.start('both');
    const stream =
      target === 'microphone'
        ? h.mic
        : target === 'display'
          ? h.display
          : h.contexts[0].output.stream;
    stream.getAudioTracks()[0].end();
    assertReleased(h, h.display, h.mic);
    assert.equal(h.errors.length, 1);
    assert.match(
      h.errors[0],
      target === 'microphone'
        ? /Microphone ended/
        : target === 'display'
          ? /Computer audio ended/
          : /Mixed audio ended/,
    );
    h.flushStops();
    assert.equal(h.segments.length, 0);
  });
}

test('display audio ending while microphone permission is pending cancels the whole acquisition', async () => {
  const permission = deferred();
  const h = makeHarness({ getUserMedia: () => permission.promise });
  const pending = h.recorder.start('both');
  await settle();
  h.display.getAudioTracks()[0].end();
  assertReleased(h, h.display);
  permission.resolve(h.mic);
  await pending;
  assertReleased(h, h.display, h.mic);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /Computer audio ended/);
});

test('an already-ended audio track rejects startup and releases other tracks', async () => {
  const ended = new Track();
  ended.readyState = 'ended';
  const h = makeHarness({ display: new Stream([ended, new Track(), new Track('video')]) });
  await assert.rejects(h.recorder.start('both'), /Computer audio ended before recording/);
  assertReleased(h, h.display);
  assert.equal(h.calls.length, 1);
});

test('multiple original/mixed tracks are all released, including unexpected microphone video', async () => {
  const h = makeHarness({
    mic: new Stream([new Track(), new Track(), new Track('video')]),
    display: new Stream([new Track(), new Track(), new Track('video'), new Track('video')]),
    mixed: new Stream([new Track(), new Track()]),
    closeRejects: true,
  });
  await h.recorder.start('both');
  assertMix(h, [h.display, h.mic], 0.5);
  h.recorder.stop();
  await settle(); // A rejected close() must not become an unhandled rejection.
  assertReleased(h, h.display, h.mic);
});

test('stop from the state callback prevents timers and segments', async () => {
  const h = makeHarness();
  h.recorder.onStateChange = (state) => {
    h.states.push(state);
    if (state) h.recorder.stop();
  };
  await h.recorder.start('microphone');
  assertReleased(h, h.mic);
  h.tick(60000);
  h.flushStops();
  assert.deepEqual(h.states, [true, false]);
  assert.equal(h.segments.length, 0);
});

test('stop from a synchronous segment callback does not start another recorder', async () => {
  const h = makeHarness({ synchronousStop: true });
  h.recorder.onSegment = (blob) => {
    h.segments.push(blob);
    h.recorder.stop();
  };
  await h.recorder.start('microphone');
  h.tick();
  assertReleased(h, h.mic);
  assert.equal(h.recorders.length, 1);
  assert.equal(h.segments.length, 1);
  h.tick(60000);
  assert.equal(h.segments.length, 1);
});

test('base64 handles empty, binary, and large multi-chunk blobs without a data URL prefix', async () => {
  const { blobToBase64 } = makeHarness();
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([0, 1, 127, 128, 254, 255]),
    Buffer.alloc(150000).map((_, i) => i % 256),
  ]) {
    const blob = new Blob([bytes.subarray(0, 32000), bytes.subarray(32000)], { type: MIME_TYPE });
    assert.equal(await blobToBase64(blob), bytes.toString('base64'));
  }
});
