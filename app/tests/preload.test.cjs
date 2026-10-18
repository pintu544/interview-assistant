const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function bridge() {
  const events = new EventEmitter();
  const sent = [];
  events.send = (channel, payload) => sent.push({ channel, payload });
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/main/preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron', 'sandbox preload must not require any local/Node module');
      return {
        ipcRenderer: events,
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'assistant');
            api = value;
          },
        },
      };
    },
  });
  return { api, events, sent };
}

test('bundled preload exposes a minimal bridge in the sandbox', () => {
  const { api, sent } = bridge();
  api.requestSolve();
  api.toggleOverlay();
  assert.equal(sent[0].channel, 'solve:request');
  assert.equal(sent[1].channel, 'overlay:toggle');
});

test('preload validates incoming IPC and unsubscribes listeners', () => {
  const { api, events } = bridge();
  const received = [];
  const offDelta = api.onSolveDelta((value) => received.push(value));
  const offDone = api.onSolveDone((ok, error) => received.push({ ok, error }));
  const offInteraction = api.onInteractionChanged((value) => received.push(value));
  events.emit('solve:delta', {}, null);
  events.emit('solve:delta', {}, { delta: 42 });
  events.emit('solve:done', {}, { ok: 'true' });
  events.emit('overlay:interaction', {}, { interactive: 'true' });
  assert.equal(received.length, 0);
  events.emit('solve:delta', {}, { delta: 'code' });
  events.emit('solve:done', {}, { ok: false, error: 'failed' });
  events.emit('overlay:interaction', {}, { interactive: true });
  assert.equal(received.length, 3);
  assert.equal(received[0], 'code');
  assert.equal(received[1].error, 'failed');
  assert.equal(received[2], true);
  offDelta();
  offDone();
  offInteraction();
  assert.equal(events.listenerCount('solve:delta'), 0);
  assert.equal(events.listenerCount('solve:done'), 0);
  assert.equal(events.listenerCount('overlay:interaction'), 0);
});

test('preload bounds outgoing audio responses', () => {
  const { api, sent } = bridge();
  api.sendAudioResponse('id', 'YQ==');
  api.sendAudioResponse('id', 'x'.repeat(8 * 1024 * 1024 + 1));
  api.sendAudioResponse('id', 123);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'audio:response');
});
