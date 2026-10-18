const test = require('node:test');
const assert = require('node:assert/strict');
const { abortable, abortError } = require('../dist/main/lifecycle.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('abortError has the stable AbortError shape', () => {
  const error = abortError();
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'Operation cancelled');
  assert.ok(error instanceof Error);
});

test('abortable resolves and removes its abort listener on success', async () => {
  const controller = new AbortController();
  const result = await abortable(Promise.resolve('ok'), controller.signal);
  assert.equal(result, 'ok');
  controller.abort();
  await tick();
  assert.equal(result, 'ok');
});

test('abortable rejects promptly when the signal aborts', async () => {
  const controller = new AbortController();
  const pending = abortable(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error.name === 'AbortError' && error.message === 'Operation cancelled',
  );
});

test('abortable handles an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    abortable(Promise.resolve('late'), controller.signal),
    (error) => error.name === 'AbortError',
  );
});

test('abortable forwards operation rejection and consumes late rejection after abort', async () => {
  const controller = new AbortController();
  let rejectOperation;
  const operation = new Promise((_, reject) => {
    rejectOperation = reject;
  });
  const wrapped = abortable(operation, controller.signal);
  controller.abort();
  await assert.rejects(wrapped, (error) => error.name === 'AbortError');
  rejectOperation(new Error('late failure'));
  await tick();
});
