import fs from 'fs';
import os from 'os';
import path from 'path';

export type ProviderKind = 'azure' | 'openai-compatible';

export interface AssistantConfig {
  provider: ProviderKind;
  endpoint: string;
  apiKey: string;
  chatModel: string;
  /** Required only when transcriptionEnabled is true (the backwards-compatible default). */
  whisperModel?: string;
  /** If false, audio transcription is skipped and whisperModel may be omitted. */
  transcriptionEnabled?: boolean;
  /** Azure API version. Optional for compatible Azure gateways. */
  apiVersion?: string;
  /** Permit plain HTTP only for loopback endpoints used for local development. */
  allowInsecureLocalhost?: boolean;
}

const REQUIRED_KEYS = ['provider', 'endpoint', 'apiKey', 'chatModel'] as const;
const CONFIG_PATH = path.join(os.homedir(), '.interview-assistant', 'config.json');

export function configPath(): string {
  return CONFIG_PATH;
}

function requiredString(value: unknown, key: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`Config field ${key} must be a nonempty string.`);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function validateEndpoint(endpoint: unknown, allowInsecure: unknown): void {
  requiredString(endpoint, 'endpoint');
  if (typeof allowInsecure !== 'undefined' && typeof allowInsecure !== 'boolean') {
    throw new Error('Config field allowInsecureLocalhost must be a boolean.');
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Config field endpoint must be a valid URL.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'Config endpoint must not contain embedded credentials, a query, or a fragment.',
    );
  }
  if (
    !parsed.hostname ||
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && allowInsecure === true && isLoopback(parsed.hostname)))
  ) {
    throw new Error(
      'Config field endpoint must use HTTPS (HTTP is allowed only for loopback with allowInsecureLocalhost: true).',
    );
  }
}

function validateConfigFile(): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(CONFIG_PATH);
  } catch (err) {
    throw new Error(
      `Cannot read config at ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`Config at ${CONFIG_PATH} must be a regular file, not a symbolic link.`);
  // On POSIX, owner-readable files such as 0400 are valid; reject group/world access.
  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`Config at ${CONFIG_PATH} must be owned by the current user.`);
    }
    if ((mode & 0o077) !== 0 || (mode & 0o400) === 0) {
      throw new Error(
        `Config at ${CONFIG_PATH} must be owner-readable and inaccessible to group/others (0600 or stricter, e.g. 0400).`,
      );
    }
  }
}

export function loadConfig(): AssistantConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing config at ${CONFIG_PATH}. Create it as JSON with provider, endpoint, apiKey, chatModel, and (unless transcriptionEnabled is false) whisperModel.`,
    );
  }
  validateConfigFile();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Config at ${CONFIG_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`Config at ${CONFIG_PATH} must contain a JSON object.`);
  const cfg = raw as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) requiredString(cfg[key], key);
  if (cfg.provider !== 'azure' && cfg.provider !== 'openai-compatible')
    throw new Error('Config provider must be "azure" or "openai-compatible".');
  validateEndpoint(cfg.endpoint, cfg.allowInsecureLocalhost);
  if (
    typeof cfg.transcriptionEnabled !== 'undefined' &&
    typeof cfg.transcriptionEnabled !== 'boolean'
  )
    throw new Error('Config field transcriptionEnabled must be a boolean.');
  const transcriptionEnabled = cfg.transcriptionEnabled !== false;
  if (transcriptionEnabled) requiredString(cfg.whisperModel, 'whisperModel');
  if (typeof cfg.apiVersion !== 'undefined') requiredString(cfg.apiVersion, 'apiVersion');
  if (cfg.provider === 'azure') requiredString(cfg.apiVersion, 'apiVersion');
  return { ...cfg, transcriptionEnabled } as AssistantConfig;
}
