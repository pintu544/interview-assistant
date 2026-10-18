const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.resolve(__dirname, '..');
test('build emits renderer and bundled preload artifacts', () => {
  assert.ok(fs.existsSync(path.join(app, 'dist/main/index.js')));
  assert.ok(fs.existsSync(path.join(app, 'dist/main/preload.js')));
  assert.ok(fs.existsSync(path.join(app, 'dist/renderer/index.html')));
  assert.match(
    fs.readFileSync(path.join(app, 'dist/renderer/index.html'), 'utf8'),
    /(?:\.\/|src=)/,
  );
});
