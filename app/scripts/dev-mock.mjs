import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-provider.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.env.INTERVIEW_ASSISTANT_CONFIG = path.join(root, 'config.mock.json');

const mock = await startMockServer();
// The mock must not outlive Electron or keep the process alive after it exits.
mock.server.unref();
console.log(`mock provider on ${mock.url} (mode=${process.env.MOCK_MODE ?? 'ok'})`);
console.log(`config override: ${process.env.INTERVIEW_ASSISTANT_CONFIG}`);

await import('./dev.mjs');
