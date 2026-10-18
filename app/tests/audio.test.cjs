const fs = require('fs');
const vm = require('vm');
const ts = require('../node_modules/typescript');

const sourcePath = require('path').resolve(__dirname, '../src/renderer/audio.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

class Track {
  constructor() {
    this.stopped = 0;
  }
  stop() {
    this.stopped++;
  }
}
class Stream {
  constructor() {
    this.track = new Track();
  }
  getTracks() {
    return [this.track];
  }
}
class FakeRecorder {
  static instances = [];
  static ctorThrows = false;
  static startThrows = false;
  static isTypeSupported() {
    return true;
  }
  constructor(stream, opts) {
    if (FakeRecorder.ctorThrows) throw new Error('ctor boom');
    this.stream = stream;
    this.opts = opts;
    this.ondataavailable = null;
    this.onerror = null;
    this.onstop = null;
    this.started = 0;
    this.stopped = 0;
    FakeRecorder.instances.push(this);
  }
  start(ms) {
    if (FakeRecorder.startThrows) throw new Error('start boom');
    this.started = ms;
  }
  stop() {
    this.stopped++;
    this.onstop?.();
  }
  emit(data) {
    this.ondataavailable?.({ data: new Blob([data], { type: 'audio/webm' }) });
  }
  error() {
    this.onerror?.(new Error('device loss'));
  }
}

function makeContext(getUserMedia) {
  const context = {
    console,
    Blob,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    navigator: { mediaDevices: { getUserMedia } },
    MediaRecorder: FakeRecorder,
    setTimeout,
    clearTimeout,
    Uint8Array,
    Date,
    Promise,
  };
  context.globalThis = context;
  vm.createContext(context);
  const mod = { exports: {} };
  context.module = mod;
  context.exports = mod.exports;
  context.require = undefined;
  new vm.Script(transpiled, { filename: sourcePath }).runInContext(context, { timeout: 5000 });
  return mod.exports;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
async function text(blob) {
  return Buffer.from(await blob.arrayBuffer()).toString('utf8');
}
async function expectReject(promise) {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('expected promise rejection');
}
async function run() {
  // A stream acquired before either MediaRecorder failure must be released.
  for (const kind of ['constructor', 'start']) {
    FakeRecorder.instances = [];
    FakeRecorder.ctorThrows = kind === 'constructor';
    FakeRecorder.startThrows = kind === 'start';
    const stream = new Stream();
    const { MicRecorder } = makeContext(async () => stream);
    await expectReject(new MicRecorder().start());
    if (stream.track.stopped !== 1) throw new Error(`${kind}: acquired track leaked`);
  }
  FakeRecorder.ctorThrows = false;
  FakeRecorder.startThrows = false;

  // Normal capture keeps the first chunk as the header without duplicating it.
  {
    FakeRecorder.instances = [];
    const stream = new Stream();
    const { MicRecorder } = makeContext(async () => stream);
    const m = new MicRecorder();
    await m.start();
    const r = FakeRecorder.instances[0];
    r.emit('HEADER');
    r.emit('BODY');
    if ((await text(await m.getRecentAudio())) !== 'HEADERBODY')
      throw new Error('header duplicated');
    m.stop();
    if (m.isRecording || stream.track.stopped !== 1) throw new Error('normal stop failed');
  }

  // Concurrent starts share one acquisition and one recorder.
  {
    FakeRecorder.instances = [];
    const d = deferred();
    let calls = 0;
    const stream = new Stream();
    const { MicRecorder } = makeContext(() => {
      calls++;
      return d.promise;
    });
    const m = new MicRecorder();
    const p1 = m.start();
    const p2 = m.start();
    if (calls !== 1) throw new Error('concurrent getUserMedia duplicated');
    d.resolve(stream);
    await Promise.all([p1, p2]);
    if (FakeRecorder.instances.length !== 1 || !m.isRecording)
      throw new Error('concurrent start duplicated recorder');
    m.stop();
  }

  // stop invalidates a pending start; a later start may proceed safely.
  {
    FakeRecorder.instances = [];
    const first = deferred();
    const streams = [new Stream(), new Stream()];
    let calls = 0;
    const { MicRecorder } = makeContext(() =>
      calls++ === 0 ? first.promise : Promise.resolve(streams[1]),
    );
    const m = new MicRecorder();
    const pending = m.start();
    m.stop();
    const second = m.start();
    first.resolve(streams[0]);
    await Promise.all([pending, second]);
    if (streams[0].track.stopped !== 1 || streams[1].track.stopped !== 0 || !m.isRecording)
      throw new Error('pending stop/start race leaked or lost new session');
    m.stop();
  }

  // Old recorder callbacks cannot contaminate or tear down a newer session.
  {
    FakeRecorder.instances = [];
    const streams = [new Stream(), new Stream()];
    let i = 0;
    const { MicRecorder } = makeContext(async () => streams[i++]);
    const m = new MicRecorder();
    await m.start();
    const old = FakeRecorder.instances[0];
    old.emit('OLD-HEADER');
    m.stop();
    await m.start();
    const newer = FakeRecorder.instances[1];
    const lateData = old.ondataavailable;
    const lateError = old.onerror;
    const lateStop = old.onstop;
    old.emit('OLD-LATE');
    lateData?.({ data: new Blob(['OLD-CAPTURED']) });
    lateError?.();
    lateStop?.();
    newer.emit('NEW');
    if ((await text(await m.getRecentAudio())) !== 'NEW' || !m.isRecording)
      throw new Error('stale callback contaminated new session');
    m.stop();
  }

  // Rolling pruning remains ~35s while the pinned header stays available.
  {
    FakeRecorder.instances = [];
    const realNow = Date.now;
    let now = 100000;
    Date.now = () => now;
    try {
      const { MicRecorder } = makeContext(async () => new Stream());
      const m = new MicRecorder();
      await m.start();
      const r = FakeRecorder.instances[0];
      r.emit('H');
      now += 31000;
      r.emit('N');
      if ((await text(await m.getRecentAudio())) !== 'HN')
        throw new Error('rolling/header behavior changed');
      m.stop();
    } finally {
      Date.now = realNow;
    }
  }
}

run()
  .then(() => console.log('audio tests: ok'))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
