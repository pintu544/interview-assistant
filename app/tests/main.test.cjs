const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const INDEX = fs.readFileSync(path.join(__dirname, '../dist/main/index.js'), 'utf8');
const IPC = {
  SOLVE_START: 'solve:start',
  SOLVE_REQUEST: 'solve:request',
  SOLVE_DELTA: 'solve:delta',
  SOLVE_DONE: 'solve:done',
  OVERLAY_TOGGLE: 'overlay:toggle',
  INTERACTION_CHANGED: 'interaction:changed',
  AUDIO_REQUEST: 'audio:request',
  AUDIO_RESPONSE: 'audio:response',
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function clock() {
  let now = 0,
    next = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++next;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      now += ms;
      let again = true;
      while (again) {
        again = false;
        for (const [id, t] of [...timers])
          if (t.at <= now) {
            timers.delete(id);
            t.fn();
            again = true;
            await Promise.resolve();
          }
      }
      await flush();
    },
    pending() {
      return timers.size;
    },
  };
}

async function boot(options = {}) {
  const c = clock();
  const events = [];
  const ipcMain = new EventEmitter();
  const app = new EventEmitter();
  let overlay;
  let solveCalls = 0;
  let transcribeCalls = 0;
  let captureCalls = 0;
  const providerCalls = [];
  const sender = new EventEmitter();
  sender.mainFrame = { id: 1 };
  sender.isDestroyed = () => false;
  sender.isLoading = () => !!options.loading;
  sender.setWindowOpenHandler = () => ({ action: 'deny' });
  sender.getURL = () => 'file:///workspace/interview-assistant/app/dist/renderer/index.html';
  sender.send = (channel, payload) => {
    events.push({ channel, payload });
    if (channel === IPC.AUDIO_REQUEST && options.audio !== 'never')
      queueMicrotask(() =>
        ipcMain.emit(
          IPC.AUDIO_RESPONSE,
          { sender, senderFrame: sender.mainFrame },
          { requestId: payload.requestId, base64: options.audio ?? 'YQ==' },
        ),
      );
  };
  const register = new Map();
  const globalShortcut = {
    register(key, fn) {
      register.set(key, fn);
      return options.hotkeyFailure !== key;
    },
    unregisterAll() {
      events.push({ kind: 'unregister' });
    },
  };
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.webContents = sender;
      this.visible = false;
      this.destroyed = false;
      overlay = this;
    }
    setContentProtection() {}
    setIgnoreMouseEvents(value) {
      this.ignore = value;
    }
    setVisibleOnAllWorkspaces() {}
    loadFile() {
      return options.loadReject ? Promise.reject(new Error('load failed')) : Promise.resolve();
    }
    loadURL() {
      return Promise.resolve();
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
    }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
    emit(...args) {
      return EventEmitter.prototype.emit.apply(this, args);
    }
    on(...args) {
      if (!this._events) EventEmitter.call(this);
      return EventEmitter.prototype.on.apply(this, args);
    }
  }
  // BrowserWindow needs EventEmitter methods while retaining the simple mock above.
  Object.setPrototypeOf(BrowserWindow.prototype, EventEmitter.prototype);
  const electron = {
    app,
    BrowserWindow,
    globalShortcut,
    ipcMain,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
    session: {
      defaultSession: {
        setPermissionRequestHandler(fn) {
          this.request = fn;
        },
        setPermissionCheckHandler(fn) {
          this.check = fn;
        },
      },
    },
  };
  app.requestSingleInstanceLock = () => true;
  app.quit = () => events.push({ kind: 'quit' });
  app.whenReady = () => Promise.resolve();
  const capture = {
    captureScreen: () => {
      captureCalls++;
      if (options.capture === 'hang' && captureCalls === 1) return new Promise(() => {});
      return Promise.resolve({ base64: 'PNG', width: 10, height: 10 });
    },
  };
  const config = {
    loadConfig: () => ({
      provider: 'azure',
      endpoint: options.nvidia ? 'https://integrate.api.nvidia.com/v1' : 'https://example.test',
      apiKey: 'key',
      chatModel: 'chat',
      whisperModel: 'whisper',
      transcriptionEnabled: options.transcriptionEnabled,
    }),
  };
  class ProviderError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ProviderError';
      this.status = status;
    }
  }
  const provider = {
    transcribe: async () => {
      transcribeCalls++;
      providerCalls.push('transcribe');
      if (options.asrStatus) throw new ProviderError(`ASR ${options.asrStatus}`, options.asrStatus);
      return 'spoken context';
    },
    solve: async (_shot, context, cb) => {
      solveCalls++;
      providerCalls.push(['solve', context]);
      cb.onDelta('delta');
    },
  };
  const providers = { ProviderError, createProvider: () => provider };
  const lifecycle = require('../dist/main/lifecycle.js');
  const mocks = {
    electron,
    './capture': capture,
    './config': config,
    './providers': providers,
    './lifecycle': lifecycle,
    '../shared/ipc': { IPC },
    path,
    crypto: { randomUUID: () => 'request-1' },
    url: require('url'),
  };
  const context = {
    console,
    Error,
    URL,
    process: { ...process, env: { ...process.env, NODE_ENV: 'production' } },
    Buffer,
    AbortController,
    setImmediate,
    queueMicrotask,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    __dirname: path.join(__dirname, '../dist/main'),
    exports: {},
    module: { exports: {} },
    require(id) {
      return mocks[id] || require(id);
    },
  };
  context.global = context;
  vm.runInNewContext(
    `(function(require,module,exports,__dirname){${INDEX}\n})(require,module,module.exports,__dirname)`,
    context,
    { filename: 'dist/main/index.js' },
  );
  await flush();
  await flush();
  async function solve() {
    register.get('CommandOrControl+Alt+S')();
    await flush();
    await flush();
  }
  return {
    c,
    events,
    ipcMain,
    sender,
    overlay,
    register,
    app,
    solve,
    providerCalls,
    counts: () => ({ solveCalls, transcribeCalls, captureCalls }),
  };
}
const channel = (h, name) => h.events.filter((e) => e.channel === name);

test('normal solve streams deltas and transcribes audio', async () => {
  const h = await boot();
  await h.solve();
  assert.equal(channel(h, IPC.SOLVE_START).length, 1);
  assert.deepEqual(
    channel(h, IPC.SOLVE_DELTA).map((e) => e.payload.delta),
    ['delta'],
  );
  assert.equal(channel(h, IPC.SOLVE_DONE)[0].payload.ok, true);
  assert.deepEqual(h.providerCalls, ['transcribe', ['solve', 'spoken context']]);
});

test('404 ASR degrades to screenshot-only solve, while 401 blocks it', async () => {
  const optional = await boot({ asrStatus: 404 });
  await optional.solve();
  assert.equal(optional.counts().solveCalls, 1);
  assert.equal(optional.providerCalls[1][1], undefined);
  assert.equal(channel(optional, IPC.SOLVE_DONE)[0].payload.ok, true);
  const auth = await boot({ asrStatus: 401 });
  await auth.solve();
  assert.equal(auth.counts().solveCalls, 0);
  assert.match(channel(auth, IPC.SOLVE_DONE)[0].payload.error, /401/);
});

test('Nvidia endpoint skips ASR', async () => {
  const h = await boot({ nvidia: true });
  await h.solve();
  assert.equal(h.counts().transcribeCalls, 0);
  assert.equal(h.counts().solveCalls, 1);
});

test('deadline covers pending capture and the next solve works', async () => {
  const h = await boot({ capture: 'hang', audio: '' });
  await h.solve();
  await h.c.advance(25000);
  await flush();
  assert.match(channel(h, IPC.SOLVE_DONE)[0].payload.error, /Timed out/);
  assert.equal(h.counts().solveCalls, 0);
  await h.solve();
  assert.equal(h.counts().solveCalls, 1);
});

test('deadline covers renderer load and later load completion permits retry', async () => {
  const h = await boot({ loading: true });
  await h.solve();
  await h.c.advance(25000);
  assert.match(channel(h, IPC.SOLVE_DONE)[0].payload.error, /Timed out/);
  h.sender.isLoading = () => false;
  await h.solve();
  assert.equal(h.counts().solveCalls, 1);
});

test('destroyed overlay aborts and cleans up without sending', async () => {
  const h = await boot({ capture: 'hang', audio: '' });
  await h.solve();
  h.overlay.close();
  assert.equal(h.app.listenerCount('will-quit'), 1);
  await h.c.advance(25000);
  assert.equal(channel(h, IPC.SOLVE_DONE).length, 0);
  assert.equal(h.events.filter((e) => e.kind === 'quit').length, 1);
});

test('audio IPC rejects wrong sender, wrong frame, and malformed base64', async () => {
  const h = await boot({ audio: 'never' });
  const pending = h.solve();
  await flush();
  const request = channel(h, IPC.AUDIO_REQUEST)[0].payload.requestId;
  const foreign = { sender: {}, senderFrame: h.sender.mainFrame };
  h.ipcMain.emit(IPC.AUDIO_RESPONSE, foreign, { requestId: request, base64: 'YQ==' });
  h.ipcMain.emit(
    IPC.AUDIO_RESPONSE,
    { sender: h.sender, senderFrame: {} },
    { requestId: request, base64: 'YQ==' },
  );
  h.ipcMain.emit(
    IPC.AUDIO_RESPONSE,
    { sender: h.sender, senderFrame: h.sender.mainFrame },
    { requestId: request, base64: 'not base64!' },
  );
  await h.c.advance(5000);
  await pending;
  assert.equal(h.counts().transcribeCalls, 0);
  assert.equal(h.counts().solveCalls, 1);
});

test('interaction hotkey toggles mouse passthrough and notifies renderer', async () => {
  const h = await boot();
  h.register.get('CommandOrControl+Alt+I')();
  assert.equal(h.overlay.ignore, false);
  assert.equal(channel(h, IPC.INTERACTION_CHANGED)[0].payload.interactive, true);
  h.register.get('CommandOrControl+Alt+I')();
  assert.equal(h.overlay.ignore, true);
});
