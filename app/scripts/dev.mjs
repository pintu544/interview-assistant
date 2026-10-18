import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, NODE_ENV: 'development' };
const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  server: { host: 'localhost', port: 5173, strictPort: true },
});
let electron;
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  electron?.kill();
  await server.close();
  process.exitCode = code;
};
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
try {
  // Never connect Electron to a stale/unrelated process occupying the development port.
  await server.listen();
  server.printUrls();
  electron = spawn(require('electron'), ['.'], { cwd, env, stdio: 'inherit' });
  electron.once('error', (error) => {
    console.error('Unable to launch Electron:', error.message);
    void stop(1);
  });
  electron.once('exit', (code) => {
    void stop(code ?? 0);
  });
} catch (error) {
  console.error('Unable to start development server:', error.message);
  await stop(1);
}
