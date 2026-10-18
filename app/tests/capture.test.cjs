const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadCapture(display, sources) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron')
      return {
        screen: {
          getCursorScreenPoint: () => ({ x: 1, y: 1 }),
          getDisplayNearestPoint: () => display,
        },
        desktopCapturer: { getSources: async () => sources },
      };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../dist/main/capture.js')];
    return require('../dist/main/capture.js');
  } finally {
    Module._load = original;
  }
}
function source(id, name, width, height) {
  const image = {
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth, height: nextHeight }) => sourceImage(nextWidth, nextHeight),
    toPNG: () => Buffer.from('png'),
  };
  function sourceImage(nextWidth, nextHeight) {
    return {
      getSize: () => ({ width: nextWidth, height: nextHeight }),
      resize: ({ width: w, height: h }) => sourceImage(w, h),
      toPNG: () => Buffer.from('png'),
    };
  }
  return { display_id: id, name, thumbnail: image };
}

test('capture rejects an empty thumbnail and never falls back to an unrelated source', async () => {
  const capture = loadCapture(
    { id: 1, label: 'A', size: { width: 100, height: 100 }, scaleFactor: 1 },
    [source('2', 'B', 90, 90)],
  );
  await assert.rejects(capture.captureScreen(), /uniquely identify/);
  const empty = loadCapture(
    { id: 1, label: 'A', size: { width: 100, height: 100 }, scaleFactor: 1 },
    [source('1', 'A', 0, 0)],
  );
  await assert.rejects(empty.captureScreen(), /empty thumbnail/);
});

test('capture rejects ambiguous dimension matches and bounds the largest side', async () => {
  const capture = loadCapture(
    { id: 1, label: '', size: { width: 2000, height: 1000 }, scaleFactor: 1 },
    [source('x', 'one', 2000, 1000), source('y', 'two', 2000, 1000)],
  );
  await assert.rejects(capture.captureScreen(), /Ambiguous/);
  const unique = loadCapture(
    { id: 1, label: 'A', size: { width: 2000, height: 1000 }, scaleFactor: 1 },
    [source('1', 'A', 2000, 1000)],
  );
  const result = await unique.captureScreen();
  assert.ok(Math.max(result.width, result.height) <= 1568);
});
