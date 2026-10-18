const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-config-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const dir = path.join(home, '.interview-assistant');
fs.mkdirSync(dir, { mode: 0o700 });
const file = path.join(dir, 'config.json');
function write(value, mode = 0o400) {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify(value));
  fs.chmodSync(file, mode);
}
const config = require('../dist/main/config.js');
const base = {
  provider: 'openai-compatible',
  endpoint: 'https://compatible.example/v1',
  apiKey: 'secret',
  chatModel: 'vision',
  whisperModel: 'whisper',
};
try {
  write(base);
  assert.equal(config.loadConfig().endpoint, base.endpoint);
  const disabled = { ...base, transcriptionEnabled: false };
  delete disabled.whisperModel;
  write(disabled);
  assert.equal(config.loadConfig().transcriptionEnabled, false);
  write({ ...base, endpoint: 'http://127.0.0.1:1234/v1', allowInsecureLocalhost: true });
  assert.equal(config.loadConfig().endpoint.startsWith('http:'), true);
  for (const endpoint of [
    'http://public.example/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?key=x',
    'https://example.com/v1#x',
  ]) {
    write({ ...base, endpoint, allowInsecureLocalhost: true });
    assert.throws(() => config.loadConfig(), /HTTPS|embedded credentials/);
  }
  for (const value of ['', 123, [], {}]) {
    write({ ...base, chatModel: value });
    assert.throws(() => config.loadConfig(), /chatModel.*nonempty/);
  }
  write(null);
  assert.throws(() => config.loadConfig(), /JSON object/);
  write({ ...base, provider: 'azure' });
  assert.throws(() => config.loadConfig(), /apiVersion/);
  write({ ...base, provider: 'azure', apiVersion: '2024-10-21' });
  assert.equal(config.loadConfig().provider, 'azure');
  if (process.platform !== 'win32') {
    write(base, 0o644);
    assert.throws(() => config.loadConfig(), /owner-readable.*group\/others/);
    write(base, 0o400);
    assert.equal(config.loadConfig().endpoint, base.endpoint);
    const target = path.join(dir, 'target.json');
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    assert.throws(() => config.loadConfig(), /symbolic link/);
  }
  console.log('config tests: ok');
} finally {
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  fs.rmSync(home, { recursive: true, force: true });
}
