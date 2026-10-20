const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { IPC } = require('../dist/shared/ipc.js');
const lifecycle = require('../dist/main/lifecycle.js');

const INDEX = fs.readFileSync(path.join(__dirname, '../dist/main/index.js'), 'utf8');
const RENDERER_URL = pathToFileURL(path.resolve(__dirname, '../dist/renderer/index.html')).href;
const MAX_AUDIO = 2 * 1024 * 1024;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const channel = (h, name) => h.events.filter((event) => event.channel === name);
const payloads = (h, name) => channel(h, name).map((event) => ({ ...event.payload }));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clock() {
  let now = 0,
    next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++next;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => timers.size,
  };
}

async function boot(t, options = {}) {
  const c = clock();
  const events = [],
    errors = [],
    captures = [],
    solves = [],
    transcriptions = [],
    sourceRequests = [];
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, handler) => {
    assert.equal(handlers.has(name), false, `duplicate invoke handler: ${name}`);
    handlers.set(name, handler);
  };
  const app = new EventEmitter();
  const loading = deferred();
  let overlay,
    url = options.development ? 'http://localhost:5173' : RENDERER_URL;
  let isLoading = true,
    contentsDestroyed = false,
    sessionNumber = 0;
  const sender = new EventEmitter();
  sender.mainFrame = { url };
  sender.isDestroyed = () => contentsDestroyed;
  sender.isLoading = () => isLoading;
  sender.setWindowOpenHandler = (handler) => {
    sender.windowOpenHandler = handler;
  };
  sender.getURL = () => url;
  sender.send = (name, payload) => events.push({ channel: name, payload });
  const finishLoad = () => {
    isLoading = false;
    sender.emit('did-finish-load');
    loading.resolve();
  };
  const register = new Map();
  const globalShortcut = {
    register(key, handler) {
      register.set(key, handler);
      return options.hotkeyFailure !== key;
    },
    unregisterAll() {
      events.push({ kind: 'unregister' });
    },
  };
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.webContents = sender;
      this.visible = false;
      this.destroyed = false;
      overlay = this;
    }
    setContentProtection(value) {
      this.protected = value;
    }
    setIgnoreMouseEvents(value) {
      this.ignore = value;
    }
    setVisibleOnAllWorkspaces() {}
    loadFile(file) {
      this.loadedFile = file;
      sender.emit('did-start-loading');
      if (options.loadReject) {
        isLoading = false;
        loading.reject(new Error('load failed'));
      } else if (!options.loading) queueMicrotask(finishLoad);
      return loading.promise;
    }
    loadURL(value) {
      this.loadedURL = value;
      return this.loadFile(undefined);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    showInactive() {
      this.visible = true;
      events.push({ kind: 'show' });
    }
    hide() {
      this.visible = false;
      events.push({ kind: 'hide' });
      this.emit('hide');
    }
    minimize() {
      this.visible = false;
      this.emit('minimize');
    }
    close() {
      this.destroyed = true;
      this.visible = false;
      contentsDestroyed = true;
      sender.emit('destroyed');
      this.emit('closed');
    }
  }
  const permissions = {
    setPermissionRequestHandler(handler) {
      this.request = handler;
    },
    setPermissionCheckHandler(handler) {
      this.check = handler;
    },
    setDisplayMediaRequestHandler(handler) {
      this.display = handler;
    },
  };
  const sources = [{ id: 'screen:0:0', name: 'Primary screen' }];
  const electron = {
    app,
    BrowserWindow,
    globalShortcut,
    ipcMain,
    desktopCapturer: {
      async getSources(request) {
        sourceRequests.push(request);
        return options.getSources ? options.getSources(request) : sources;
      },
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
    session: { defaultSession: permissions },
  };
  app.requestSingleInstanceLock = () => true;
  app.quit = () => events.push({ kind: 'quit' });
  app.whenReady = () => Promise.resolve();
  const cfg = {
    provider: 'azure',
    endpoint: 'https://example.test',
    apiKey: 'test-key',
    chatModel: 'chat',
    whisperModel: 'whisper',
    ...options.config,
  };
  const provider = {
    async transcribe(audio, filename, signal, context) {
      transcriptions.push({ audio, filename, signal, context });
      return options.transcribe
        ? options.transcribe(transcriptions.length, signal, context)
        : 'spoken context';
    },
    async solve(shot, context, cb, signal) {
      solves.push({ shot, context, cb, signal });
      if (options.solve) return options.solve(solves.length, cb, signal);
      cb.onDelta('delta');
    },
  };
  const mocks = {
    electron,
    './capture': {
      async captureScreen() {
        captures.push(c.now());
        return options.capture
          ? options.capture(captures.length)
          : { base64: 'PNG', width: 10, height: 10 };
      },
    },
    './config': {
      loadConfig() {
        if (options.configError) throw options.configError;
        return cfg;
      },
    },
    './providers': {
      createProvider() {
        if (options.providerError) throw options.providerError;
        return provider;
      },
    },
    './lifecycle': lifecycle,
    '../shared/ipc': require('../dist/shared/ipc.js'),
    crypto: { randomUUID: () => `session-${++sessionNumber}` },
  };
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [c.now()]));
    }
    static now() {
      return c.now();
    }
  }
  vm.runInNewContext(
    INDEX,
    {
      console: { ...console, error: (...args) => errors.push(args.join(' ')) },
      Error,
      URL,
      Buffer,
      AbortController,
      Date: FakeDate,
      process: {
        platform: options.platform ?? 'win32',
        env: { NODE_ENV: options.development ? 'development' : 'production' },
      },
      setTimeout: c.setTimeout,
      clearTimeout: c.clearTimeout,
      __dirname: path.resolve(__dirname, '../dist/main'),
      exports: {},
      require: (id) => mocks[id] || require(id),
    },
    { filename: path.resolve(__dirname, '../dist/main/index.js') },
  );
  await flush();
  t.after(async () => {
    app.emit('will-quit');
    await flush();
  });
  const owner = { sender, senderFrame: sender.mainFrame };
  return {
    c,
    events,
    errors,
    sender,
    overlay,
    register,
    app,
    cfg,
    handlers,
    permissions,
    captures,
    solves,
    transcriptions,
    sources,
    sourceRequests,
    owner,
    finishLoad,
    setURL(value) {
      url = value;
      sender.mainFrame.url = value;
    },
    reload() {
      isLoading = true;
      sender.emit('did-start-loading');
    },
    invoke(name, payload, event = owner) {
      assert.ok(handlers.has(name), `missing invoke handler: ${name}`);
      return Promise.resolve().then(() => handlers.get(name)(event, payload));
    },
    send(name, payload, event = owner) {
      ipcMain.emit(name, event, payload);
    },
    async solve() {
      register.get('CommandOrControl+Alt+S')();
      await flush();
    },
    requestPermission(permission, details = {}, contents = sender) {
      let allowed;
      permissions.request(
        contents,
        permission,
        (value) => {
          allowed = value;
        },
        { isMainFrame: true, requestingUrl: url, ...details },
      );
      assert.equal(typeof allowed, 'boolean');
      return allowed;
    },
    checkPermission(permission, details = {}, contents = sender) {
      return permissions.check(contents, permission, url, {
        isMainFrame: true,
        requestingUrl: url,
        ...details,
      });
    },
    display(request = {}) {
      return new Promise((resolve) =>
        permissions.display(
          {
            frame: sender.mainFrame,
            userGesture: true,
            audioRequested: true,
            videoRequested: false,
            ...request,
          },
          resolve,
        ),
      );
    },
  };
}

async function start(h, source = 'microphone') {
  const result = await h.invoke(IPC.LISTEN_START, source);
  assert.equal(result.ok, true, result.error);
  assert.equal(typeof result.sessionId, 'string');
  assert.ok(result.sessionId.length);
  return result.sessionId;
}
const clip = (h, sessionId, sequence = 0, base64 = 'YQ==') =>
  h.invoke(IPC.AUDIO_CHUNK, { sessionId, sequence, base64 });

function assertLoadListenersRemoved(h) {
  for (const name of ['did-finish-load', 'did-fail-load', 'destroyed'])
    assert.equal(h.sender.listenerCount(name), 0, name);
}

test('overlay starts interactive, secure and hidden until its renderer loads', async (t) => {
  const h = await boot(t, { loading: true });
  assert.equal(h.overlay.ignore, false);
  assert.equal(h.overlay.isVisible(), false);
  assert.equal(h.overlay.opts.show, false);
  assert.equal(h.overlay.opts.focusable, true);
  assert.equal(h.overlay.opts.skipTaskbar, true);
  assert.equal(h.overlay.protected, true);
  assert.deepEqual(
    { ...h.overlay.opts.webPreferences },
    {
      preload: path.resolve(__dirname, '../dist/main/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  );
  assert.equal(pathToFileURL(h.overlay.loadedFile).href, RENDERER_URL);
  assert.equal(h.sender.mainFrame.url, RENDERER_URL);
  assert.equal(h.sender.getURL(), RENDERER_URL);
  assert.equal(h.transcriptions.length, 0);
  assert.equal(h.requestPermission('media', { mediaTypes: ['audio'] }), false);
  h.finishLoad();
  await flush();
  assert.equal(h.overlay.isVisible(), true);
  assert.equal(h.events.filter((event) => event.kind === 'show').length, 1);
});

test('screenshot-only solve never requests or transcribes audio and reports all stages', async (t) => {
  const h = await boot(t);
  await h.solve();
  assert.equal(h.captures.length, 1);
  assert.equal(h.solves.length, 1);
  assert.equal(h.transcriptions.length, 0);
  assert.equal(h.solves[0].shot, 'PNG');
  assert.equal(h.solves[0].context, undefined);
  assert.deepEqual(
    h.events.filter((event) => event.channel).map((event) => event.channel),
    [
      IPC.SOLVE_START,
      IPC.SOLVE_PROGRESS,
      IPC.SOLVE_PROGRESS,
      IPC.SOLVE_PROGRESS,
      IPC.SOLVE_DELTA,
      IPC.SOLVE_PROGRESS,
      IPC.SOLVE_DONE,
    ],
  );
  assert.deepEqual(payloads(h, IPC.SOLVE_PROGRESS), [
    { stage: 'capture' },
    { stage: 'answer', captureMs: 0 },
    { stage: 'answer', captureMs: 0, firstTokenMs: 0 },
    { stage: 'complete', captureMs: 0, firstTokenMs: 0, totalMs: 0 },
  ]);
  assert.deepEqual(payloads(h, IPC.SOLVE_DONE), [{ ok: true }]);
  assert.equal(channel(h, IPC.SOLVE_DELTA)[0].payload.delta, 'delta');
  assert.equal(h.solves[0].signal.aborted, true);
  assert.equal(h.c.pending(), 0);
});

test('solve timing uses the fake clock and duplicate solves do not overlap', async (t) => {
  const capture = deferred(),
    answer = deferred();
  const h = await boot(t, { capture: () => capture.promise, solve: () => answer.promise });
  await h.solve();
  await h.solve();
  assert.equal(h.captures.length, 1);
  await h.c.advance(40);
  capture.resolve({ base64: 'PNG' });
  await flush();
  await h.c.advance(75);
  h.solves[0].cb.onDelta('first');
  await h.c.advance(30);
  h.solves[0].cb.onDelta('second');
  answer.resolve();
  await flush();
  assert.deepEqual(payloads(h, IPC.SOLVE_PROGRESS), [
    { stage: 'capture' },
    { stage: 'answer', captureMs: 40 },
    { stage: 'answer', captureMs: 40, firstTokenMs: 115 },
    { stage: 'complete', captureMs: 40, firstTokenMs: 115, totalMs: 145 },
  ]);
  assert.equal(channel(h, IPC.SOLVE_DONE).length, 1);
  assert.equal(h.c.pending(), 0);
});

for (const source of ['microphone', 'system', 'both']) {
  test(`explicit ${source} start creates one session without automatically transcribing`, async (t) => {
    const h = await boot(t);
    const id = await start(h, source);
    assert.equal(h.transcriptions.length, 0);
    assert.equal(h.overlay.ignore, false);
    assert.equal(channel(h, IPC.INTERACTION_CHANGED)[0].payload.interactive, true);
    const duplicate = await h.invoke(IPC.LISTEN_START, source);
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /already active/);
    h.send(IPC.LISTEN_STOP, id);
    assert.notEqual(await start(h, source), id);
  });
}

test('completed chunks are decoded, cached, and passed as the fourth ASR prompt argument', async (t) => {
  const h = await boot(t, {
    transcribe: (n) => ['  first phrase  ', 'second phrase', '   '][n - 1],
  });
  const id = await start(h);
  assert.deepEqual({ ...(await clip(h, id)) }, { ok: true, text: 'first phrase' });
  assert.deepEqual({ ...(await clip(h, id, 1)) }, { ok: true, text: 'first phrase second phrase' });
  assert.deepEqual({ ...(await clip(h, id, 2)) }, { ok: true, text: 'first phrase second phrase' });
  assert.deepEqual(h.transcriptions[0].audio, Buffer.from('a'));
  assert.equal(h.transcriptions[0].filename, 'audio.webm');
  assert.ok(h.transcriptions[0].signal instanceof AbortSignal);
  assert.deepEqual(
    h.transcriptions.map((call) => call.context),
    ['', 'first phrase', 'first phrase second phrase'],
  );
  await h.solve();
  assert.equal(h.solves[0].context, 'first phrase second phrase');
  assert.equal(h.transcriptions.length, 3);
  assert.equal(h.c.pending(), 0);
});

for (const hasCompleted of [false, true]) {
  test(`solve does not wait for pending ASR (${hasCompleted ? 'completed cache' : 'no cache'})`, async (t) => {
    const pending = deferred();
    const h = await boot(t, {
      transcribe: (n) => (hasCompleted && n === 1 ? 'cached' : pending.promise),
    });
    const id = await start(h);
    if (hasCompleted) await clip(h, id);
    let settled = false;
    const transcription = clip(h, id, hasCompleted ? 1 : 0).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    await h.solve();
    assert.equal(settled, false);
    assert.equal(h.solves[0].context, hasCompleted ? 'cached' : undefined);
    assert.deepEqual(payloads(h, IPC.SOLVE_DONE), [{ ok: true }]);
    assert.equal(h.transcriptions.at(-1).signal.aborted, false);
    assert.equal(h.c.pending(), 1, 'only the ASR deadline remains');
    pending.resolve('later');
    assert.equal((await transcription).ok, true);
    await h.solve();
    assert.equal(h.solves[1].context, hasCompleted ? 'cached later' : 'later');
  });
}

for (const status of [401, 404]) {
  test(`ASR ${status} is returned to the listener without blocking screenshot solves`, async (t) => {
    const h = await boot(t, {
      transcribe: (n) => {
        if (n === 1) throw new Error(`ASR ${status}`);
        return 'recovered';
      },
    });
    const id = await start(h);
    const result = await clip(h, id);
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(String(status)));
    assert.equal(h.c.pending(), 0);
    await h.solve();
    assert.equal(h.solves[0].context, undefined);
    assert.equal(channel(h, IPC.SOLVE_DONE)[0].payload.ok, true);
    assert.equal((await clip(h, id, 1)).text, 'recovered');
  });
}

for (const config of [
  { transcriptionEnabled: false },
  { endpoint: 'https://integrate.api.nvidia.com/v1' },
]) {
  test(`disabled transcription rejects listening but permits screenshot solves: ${JSON.stringify(config)}`, async (t) => {
    const h = await boot(t, { config });
    const result = await h.invoke(IPC.LISTEN_START, 'microphone');
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled/);
    await h.solve();
    assert.equal(h.transcriptions.length, 0);
    assert.equal(h.solves[0].context, undefined);
    assert.equal(channel(h, IPC.SOLVE_DONE)[0].payload.ok, true);
    assert.equal((await h.invoke(IPC.RUNTIME_INFO)).transcriptionEnabled, false);
  });
}

test('runtime info reflects live/mock configuration and transcription status', async (t) => {
  const h = await boot(t);
  assert.deepEqual(
    { ...(await h.invoke(IPC.RUNTIME_INFO)) },
    { mode: 'live', model: 'chat', transcriptionEnabled: true },
  );
  h.cfg.chatModel = 'mock-vision';
  assert.equal((await h.invoke(IPC.RUNTIME_INFO)).mode, 'mock');
});

test('invalid sources and hidden windows cannot start a session', async (t) => {
  const h = await boot(t);
  for (const source of [undefined, null, '', 'camera', 'MICROPHONE', 1, {}, ['microphone']]) {
    const result = await h.invoke(IPC.LISTEN_START, source);
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid audio source/);
  }
  h.overlay.hide();
  assert.match((await h.invoke(IPC.LISTEN_START, 'microphone')).error, /Open the app/);
  assert.equal(h.transcriptions.length, 0);
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform} denies computer sources but allows an explicit microphone session`, async (t) => {
    const h = await boot(t, { platform });
    for (const source of ['system', 'both']) {
      const result = await h.invoke(IPC.LISTEN_START, source);
      assert.equal(result.ok, false);
      assert.match(result.error, /Windows only/);
    }
    await start(h);
  });
}

for (const key of ['configError', 'providerError']) {
  test(`listening reports ${key} without granting permissions`, async (t) => {
    const h = await boot(t, { [key]: new Error('configuration unavailable') });
    assert.deepEqual(
      { ...(await h.invoke(IPC.LISTEN_START, 'microphone')) },
      { ok: false, error: 'configuration unavailable' },
    );
    assert.equal(h.requestPermission('media', { mediaTypes: ['audio'] }), false);
  });
}

for (const attack of [
  'sender',
  'frame',
  'https://evil.test/',
  'file:///untrusted/index.html',
  'not a URL',
]) {
  test(`owner-only IPC rejects an untrusted ${attack}`, async (t) => {
    const h = await boot(t);
    const id = await start(h);
    const event = { ...h.owner };
    if (attack === 'sender')
      event.sender = { getURL: () => RENDERER_URL, mainFrame: h.sender.mainFrame };
    else if (attack === 'frame') event.senderFrame = { url: RENDERER_URL };
    else h.setURL(attack);
    assert.match((await h.invoke(IPC.LISTEN_START, 'microphone', event)).error, /Open the app/);
    assert.deepEqual(
      {
        ...(await h.invoke(IPC.AUDIO_CHUNK, { sessionId: id, sequence: 0, base64: 'YQ==' }, event)),
      },
      { ok: false, error: 'Untrusted caller.' },
    );
    await assert.rejects(h.invoke(IPC.RUNTIME_INFO, undefined, event), /Untrusted caller/);
    const ended = channel(h, IPC.LISTEN_ENDED).length;
    h.send(IPC.LISTEN_STOP, id, event);
    h.send(IPC.SOLVE_REQUEST, undefined, event);
    h.send(IPC.OVERLAY_TOGGLE, undefined, event);
    await flush();
    assert.equal(h.captures.length, 0);
    assert.equal(h.overlay.isVisible(), true);
    assert.equal(channel(h, IPC.LISTEN_ENDED).length, ended);
    h.setURL(RENDERER_URL);
    assert.equal((await clip(h, id)).ok, true, 'unauthorized stop must leave the session intact');
  });
}

test('trusted renderer query/hash and development origin work, other navigation is denied', async (t) => {
  const h = await boot(t);
  h.setURL(`${RENDERER_URL}?view=practice#answer`);
  await start(h);
  h.send(IPC.SOLVE_REQUEST);
  await flush();
  assert.equal(h.solves.length, 1);
  assert.equal(h.sender.windowOpenHandler().action, 'deny');
  for (const [url, denied] of [
    [RENDERER_URL, false],
    ['https://evil.test', true],
    [`${RENDERER_URL}.other`, true],
  ]) {
    let prevented = false;
    h.sender.emit(
      'will-navigate',
      {
        preventDefault() {
          prevented = true;
        },
      },
      url,
    );
    assert.equal(prevented, denied);
  }
  const dev = await boot(t, { development: true });
  assert.equal(dev.overlay.loadedURL, 'http://localhost:5173');
  dev.setURL('http://localhost:5173/practice#answer');
  await start(dev);
  dev.setURL('http://localhost:5174');
  await assert.rejects(dev.invoke(IPC.RUNTIME_INFO), /Untrusted/);
});

test('audio chunks reject malformed payloads, invalid base64, unsafe sequences and stale IDs', async (t) => {
  const h = await boot(t);
  assert.equal((await clip(h, 'no-session')).ok, false);
  const sessionId = await start(h);
  const valid = { sessionId, sequence: 0, base64: 'YQ==' };
  const invalid = [
    undefined,
    null,
    42,
    'audio',
    {},
    [],
    { ...valid, sessionId: 'stale' },
    { ...valid, sessionId: 1 },
    ...[undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'].map((sequence) => ({
      ...valid,
      sequence,
    })),
    ...[
      undefined,
      null,
      42,
      '',
      'not base64!',
      'YQ=',
      'Y===',
      'Y=Q=',
      'YQ==\n',
      '____',
      'A'.repeat(MAX_AUDIO + 4),
    ].map((base64) => ({ ...valid, base64 })),
  ];
  for (const payload of invalid) {
    const result = await h.invoke(IPC.AUDIO_CHUNK, payload);
    assert.equal(result.ok, false, `accepted invalid clip: ${String(payload)}`);
  }
  assert.equal(h.transcriptions.length, 0);
  assert.equal((await clip(h, sessionId)).ok, true, 'invalid payloads must not consume sequence 0');
  assert.equal((await clip(h, sessionId)).ok, false, 'replayed sequence');
  assert.equal(
    (await clip(h, sessionId, 4)).ok,
    true,
    'monotonically increasing sequences may have gaps',
  );
  assert.equal((await clip(h, sessionId, 3)).ok, false, 'out-of-order sequence');
  assert.equal(h.transcriptions.length, 2);
});

test('audio payload limit is inclusive at 2 MiB of base64', async (t) => {
  const h = await boot(t);
  const id = await start(h);
  assert.equal((await clip(h, id, 0, 'A'.repeat(MAX_AUDIO))).ok, true);
  assert.equal(h.transcriptions[0].audio.length, (MAX_AUDIO * 3) / 4);
});

test('one in-flight transcription rejects concurrent clips without consuming their sequence', async (t) => {
  const pending = deferred();
  const h = await boot(t, { transcribe: (n) => (n === 1 ? pending.promise : 'next') });
  const id = await start(h);
  const first = clip(h, id);
  await flush();
  assert.match((await clip(h, id, 1)).error, /still busy/);
  assert.equal(h.transcriptions.length, 1);
  pending.resolve('first');
  await first;
  assert.equal((await clip(h, id, 1)).text, 'first next');
  assert.equal(h.c.pending(), 0);
});

test('ASR aborts at 15 seconds, ignores late results and permits a retry', async (t) => {
  const late = deferred();
  const h = await boot(t, { transcribe: (n) => (n === 1 ? late.promise : 'retry') });
  const id = await start(h);
  const pending = clip(h, id);
  await flush();
  await h.c.advance(14999);
  assert.equal(h.transcriptions[0].signal.aborted, false);
  await h.c.advance(1);
  assert.equal(h.transcriptions[0].signal.aborted, true);
  assert.match((await pending).error, /timed out or was stopped/);
  assert.equal(h.c.pending(), 0);
  late.resolve('must not be cached');
  await flush();
  assert.equal((await clip(h, id, 1)).text, 'retry');
  assert.equal(h.transcriptions[1].context, '');
});

test('only a matching stop aborts ASR; old cache and late work cannot leak into a new session', async (t) => {
  const oldPending = deferred(),
    newPending = deferred();
  const h = await boot(t, {
    transcribe: (n) => (n === 1 ? 'old cache' : n === 2 ? oldPending.promise : newPending.promise),
  });
  const oldId = await start(h);
  await clip(h, oldId);
  const oldClip = clip(h, oldId, 1);
  await flush();
  h.send(IPC.LISTEN_STOP, 'wrong-id');
  assert.equal(h.transcriptions[1].signal.aborted, false);
  h.send(IPC.LISTEN_STOP, oldId);
  assert.equal(h.transcriptions[1].signal.aborted, true);
  assert.equal((await oldClip).ok, false);
  assert.equal(h.c.pending(), 0);
  const newId = await start(h);
  assert.notEqual(newId, oldId);
  assert.equal((await clip(h, oldId, 2)).ok, false);
  const newClip = clip(h, newId);
  await flush();
  assert.equal(h.transcriptions[2].context, '');
  oldPending.resolve('late old words');
  await flush();
  assert.match((await clip(h, newId, 1)).error, /still busy/);
  assert.equal(h.transcriptions[2].signal.aborted, false);
  newPending.resolve('new cache');
  assert.equal((await newClip).text, 'new cache');
  await h.solve();
  assert.equal(h.solves[0].context, 'new cache');
});

for (const action of ['hide', 'minimize', 'reload', 'crash']) {
  test(`${action} ends recording, aborts pending ASR and clears the transcript cache`, async (t) => {
    const late = deferred();
    const h = await boot(t, { transcribe: (n) => (n === 1 ? 'old cache' : late.promise) });
    const id = await start(h);
    await clip(h, id);
    const pending = clip(h, id, 1);
    await flush();
    const ended = channel(h, IPC.LISTEN_ENDED).length;
    if (action === 'reload') h.reload();
    else if (action === 'crash') h.sender.emit('render-process-gone', {}, { reason: 'crashed' });
    else h.overlay[action]();
    assert.equal(h.transcriptions[1].signal.aborted, true);
    assert.equal((await pending).ok, false);
    assert.equal(channel(h, IPC.LISTEN_ENDED).length, ended + 1);
    assert.equal(h.requestPermission('media', { mediaTypes: ['audio'] }), false);
    assert.equal((await clip(h, id, 2)).ok, false);
    if (action === 'reload') h.finishLoad();
    h.overlay.showInactive();
    await start(h);
    late.resolve('stale words');
    await flush();
    await h.solve();
    assert.equal(h.solves[0].context, undefined);
    assert.equal(h.c.pending(), 0);
  });
}

test('transcripts expire exactly at 60 seconds and expired words are not ASR prompts', async (t) => {
  const h = await boot(t, { transcribe: (n) => (n === 1 ? 'expired' : 'fresh') });
  const id = await start(h);
  await clip(h, id);
  await h.c.advance(59999);
  await h.solve();
  assert.equal(h.solves[0].context, 'expired');
  await h.c.advance(1);
  await h.solve();
  assert.equal(h.solves[1].context, undefined);
  assert.equal((await clip(h, id, 1)).text, 'fresh');
  assert.equal(h.transcriptions[1].context, '');
});

test('cache expiration retains newer entries and disabled config excludes completed cache from solves', async (t) => {
  const h = await boot(t, { transcribe: (n) => (n === 1 ? 'old' : 'recent') });
  const id = await start(h);
  await clip(h, id);
  await h.c.advance(30000);
  await clip(h, id, 1);
  await h.c.advance(30000);
  await h.solve();
  assert.equal(h.solves[0].context, 'recent');
  h.cfg.transcriptionEnabled = false;
  await h.solve();
  assert.equal(h.solves[1].context, undefined);
});

test('transcript storage and ASR context have bounded sizes', async (t) => {
  const h = await boot(t, { transcribe: (n) => String(n).repeat(5000) });
  const id = await start(h);
  assert.equal((await clip(h, id)).text.length, 4000);
  const second = await clip(h, id, 1);
  assert.equal(h.transcriptions[1].context, '1'.repeat(1000));
  assert.equal(second.text.length, 8000);
  assert.ok(second.text.endsWith('2'.repeat(4000)));
  await h.solve();
  assert.equal(h.solves[0].context, second.text);
  const short = await boot(t, { transcribe: (n) => `word${n}` });
  const shortId = await start(short);
  let result;
  for (let sequence = 0; sequence < 13; sequence++) result = await clip(short, shortId, sequence);
  assert.equal(result.text, Array.from({ length: 12 }, (_, i) => `word${i + 2}`).join(' '));
});

test('media and display permissions are denied by default, including camera requests', async (t) => {
  const h = await boot(t);
  for (const mediaTypes of [[], ['audio'], ['video'], ['audio', 'video']])
    assert.equal(h.requestPermission('media', { mediaTypes }), false);
  for (const mediaType of ['audio', 'video', 'unknown'])
    assert.equal(h.checkPermission('media', { mediaType }), false);
  assert.equal(h.checkPermission('display-capture'), false);
  assert.deepEqual({ ...(await h.display()) }, {});
  assert.equal(h.sourceRequests.length, 0);
});

for (const source of ['microphone', 'system', 'both']) {
  test(`${source} session permits only its intended audio permissions, never camera or foreign contents`, async (t) => {
    const h = await boot(t);
    const id = await start(h, source);
    const microphone = source !== 'system';
    assert.equal(h.requestPermission('media', { mediaTypes: ['audio'] }), microphone);
    assert.equal(h.checkPermission('media', { mediaType: 'audio' }), microphone);
    assert.equal(h.checkPermission('display-capture'), source !== 'microphone');
    assert.equal(h.requestPermission('display-capture'), source !== 'microphone');
    assert.equal(h.requestPermission('media', { mediaTypes: [] }), source !== 'microphone');
    for (const details of [
      { isMainFrame: false },
      { requestingUrl: 'https://evil.test' },
      { requestingUrl: '' },
    ]) {
      assert.equal(h.requestPermission('media', { mediaTypes: ['audio'], ...details }), false);
      assert.equal(h.checkPermission('media', { mediaType: 'audio', ...details }), false);
      assert.equal(h.requestPermission('display-capture', details), false);
      assert.equal(h.checkPermission('display-capture', details), false);
    }
    for (const mediaTypes of [['video'], ['audio', 'video']])
      assert.equal(h.requestPermission('media', { mediaTypes }), false);
    for (const mediaType of ['video', 'unknown', undefined])
      assert.equal(h.checkPermission('media', { mediaType }), false);
    assert.equal(h.requestPermission('notifications', { mediaTypes: ['audio'] }), false);
    assert.equal(h.checkPermission('notifications', { mediaType: 'audio' }), false);
    const foreign = { getURL: () => RENDERER_URL };
    assert.equal(h.requestPermission('media', { mediaTypes: ['audio'] }, foreign), false);
    assert.equal(h.checkPermission('display-capture', {}, foreign), false);
    h.setURL('https://evil.test');
    assert.equal(h.requestPermission('media', { mediaTypes: ['audio'] }), false);
    assert.equal(h.checkPermission('media', { mediaType: 'audio' }), false);
    assert.equal(h.checkPermission('display-capture'), false);
    h.setURL(RENDERER_URL);
    h.send(IPC.LISTEN_STOP, id);
    assert.equal(h.requestPermission('media', { mediaTypes: ['audio'] }), false);
    assert.equal(h.checkPermission('display-capture'), false);
  });
}

for (const source of ['system', 'both']) {
  test(`Windows ${source} display capture returns loopback only for a trusted gestured audio request`, async (t) => {
    const h = await boot(t);
    await start(h, source);
    for (const request of [
      { frame: { url: RENDERER_URL } },
      { userGesture: false },
      { audioRequested: false },
    ])
      assert.deepEqual({ ...(await h.display(request)) }, {});
    h.sender.mainFrame.url = 'https://evil.test';
    assert.deepEqual({ ...(await h.display()) }, {});
    h.sender.mainFrame.url = RENDERER_URL;
    assert.equal(h.sourceRequests.length, 0);
    const accepted = await h.display();
    assert.equal(accepted.audio, 'loopback');
    assert.equal(accepted.video, h.sources[0]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.sourceRequests)), [
      { types: ['screen'], thumbnailSize: { width: 0, height: 0 } },
    ]);
    h.overlay.hide();
    assert.deepEqual({ ...(await h.display()) }, {});
    assert.equal(h.sourceRequests.length, 1);
  });
}

test('microphone-only session cannot request display capture', async (t) => {
  const h = await boot(t);
  await start(h);
  assert.deepEqual({ ...(await h.display()) }, {});
  assert.equal(h.sourceRequests.length, 0);
});

for (const outcome of ['empty', 'error', 'session-replaced', 'hidden']) {
  test(`display source lookup denies ${outcome} instead of granting stale loopback`, async (t) => {
    const lookup = deferred();
    const h = await boot(t, { getSources: () => lookup.promise });
    const id = await start(h, 'system');
    const result = h.display();
    if (outcome === 'session-replaced') {
      h.send(IPC.LISTEN_STOP, id);
      await start(h, 'system');
    }
    if (outcome === 'hidden') h.overlay.hide();
    if (outcome === 'error') lookup.reject(new Error('capture unavailable'));
    else lookup.resolve(outcome === 'empty' ? [] : h.sources);
    assert.deepEqual({ ...(await result) }, {});
  });
}

test('listening keeps stop controls interactive and overlay toggle actually stops recording', async (t) => {
  const h = await boot(t);
  const toggle = h.register.get('CommandOrControl+Alt+I');
  toggle();
  assert.equal(h.overlay.ignore, true);
  assert.equal(channel(h, IPC.INTERACTION_CHANGED).at(-1).payload.interactive, false);
  const id = await start(h);
  assert.equal(h.overlay.ignore, false);
  const changes = channel(h, IPC.INTERACTION_CHANGED).length;
  toggle();
  assert.equal(h.overlay.ignore, false);
  assert.equal(channel(h, IPC.INTERACTION_CHANGED).length, changes);
  h.send(IPC.OVERLAY_TOGGLE);
  assert.equal(h.overlay.isVisible(), false);
  assert.ok(channel(h, IPC.LISTEN_ENDED).length);
  assert.equal((await clip(h, id)).ok, false);
  h.register.get('CommandOrControl+Alt+H')();
  assert.equal(h.overlay.isVisible(), true);
  toggle();
  assert.equal(h.overlay.ignore, true);
  assert.equal(channel(h, IPC.INTERACTION_CHANGED).at(-1).payload.interactive, false);
});

test('deadline covers pending capture and the next solve works', async (t) => {
  const late = deferred();
  const h = await boot(t, { capture: (n) => (n === 1 ? late.promise : { base64: 'PNG' }) });
  await h.solve();
  await h.c.advance(25000);
  assert.match(channel(h, IPC.SOLVE_DONE)[0].payload.error, /Timed out/);
  assert.equal(h.solves.length, 0);
  assert.equal(h.c.pending(), 0);
  await h.solve();
  assert.equal(h.solves.length, 1);
  late.resolve({ base64: 'OLD' });
  await flush();
  assert.equal(h.solves.length, 1);
});

test('deadline covers a hung provider, ignores late deltas, and permits retry', async (t) => {
  const late = deferred();
  const h = await boot(t, { solve: (n, cb) => (n === 1 ? late.promise : cb.onDelta('retry')) });
  await h.solve();
  await h.c.advance(25000);
  assert.equal(h.solves[0].signal.aborted, true);
  assert.match(channel(h, IPC.SOLVE_DONE)[0].payload.error, /Timed out/);
  h.solves[0].cb.onDelta('stale');
  late.reject(new Error('late provider failure'));
  await flush();
  assert.equal(channel(h, IPC.SOLVE_DELTA).length, 0);
  await h.solve();
  assert.equal(channel(h, IPC.SOLVE_DELTA)[0].payload.delta, 'retry');
  assert.equal(channel(h, IPC.SOLVE_DONE).at(-1).payload.ok, true);
});

test('deadline covers renderer load, removes listeners, and later load permits retry', async (t) => {
  const h = await boot(t, { loading: true });
  await h.solve();
  assert.equal(channel(h, IPC.SOLVE_START).length, 0);
  await h.c.advance(25000);
  assert.match(channel(h, IPC.SOLVE_DONE)[0].payload.error, /Timed out/);
  assertLoadListenersRemoved(h);
  h.finishLoad();
  await h.solve();
  assert.equal(h.solves.length, 1);
});

test('renderer load completion resumes solve and ignores aborted navigation failures', async (t) => {
  const h = await boot(t, { loading: true });
  await h.solve();
  h.sender.emit('did-fail-load', {}, -3, 'ERR_ABORTED');
  await flush();
  assert.equal(channel(h, IPC.SOLVE_DONE).length, 0);
  h.finishLoad();
  await flush();
  assert.equal(h.solves.length, 1);
  assertLoadListenersRemoved(h);
  assert.equal(h.c.pending(), 0);
});

test('renderer load errors end the solve, clean up listeners, and allow retry', async (t) => {
  const h = await boot(t, { loading: true });
  await h.solve();
  h.sender.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED');
  await flush();
  assert.match(
    channel(h, IPC.SOLVE_DONE)[0].payload.error,
    /Overlay failed to load: ERR_NAME_NOT_RESOLVED/,
  );
  assertLoadListenersRemoved(h);
  assert.equal(h.c.pending(), 0);
  h.finishLoad();
  await h.solve();
  assert.equal(h.solves.length, 1);
});

test('initial renderer load rejection is reported without showing a broken overlay', async (t) => {
  const h = await boot(t, { loadReject: true });
  assert.equal(h.overlay.isVisible(), false);
  assert.match(h.errors[0], /Unable to load overlay: load failed/);
});

for (const loading of [false, true]) {
  test(`closing the overlay aborts ${loading ? 'renderer load' : 'capture'} without sending to destroyed contents`, async (t) => {
    const h = await boot(t, { loading, capture: () => new Promise(() => {}) });
    await h.solve();
    h.overlay.close();
    await flush();
    assert.equal(channel(h, IPC.SOLVE_DONE).length, 0);
    assert.equal(h.c.pending(), 0);
    assertLoadListenersRemoved(h);
    assert.equal(h.events.filter((event) => event.kind === 'quit').length, 1);
  });
}

test('quit aborts active solve and transcription and unregisters all hotkeys', async (t) => {
  const h = await boot(t, {
    solve: () => new Promise(() => {}),
    transcribe: () => new Promise(() => {}),
  });
  const id = await start(h);
  const transcription = clip(h, id);
  await h.solve();
  h.app.emit('will-quit');
  assert.equal(h.solves[0].signal.aborted, true);
  assert.equal(h.transcriptions[0].signal.aborted, true);
  assert.equal((await transcription).ok, false);
  await flush();
  assert.equal(h.c.pending(), 0);
  assert.equal(h.events.filter((event) => event.kind === 'unregister').length, 1);
});

test('hotkey registration failure is deferred until loading finishes', async (t) => {
  const key = 'CommandOrControl+Alt+S';
  const h = await boot(t, { loading: true, hotkeyFailure: key });
  assert.equal(channel(h, IPC.SOLVE_DONE).length, 0);
  h.finishLoad();
  await flush();
  assert.match(channel(h, IPC.SOLVE_DONE)[0].payload.error, /already taken/);
  assert.equal(h.overlay.isVisible(), true);
  assert.equal(h.sender.listenerCount('did-finish-load'), 0);
  assert.match(h.errors[0], /Hotkey registration failed/);
});
