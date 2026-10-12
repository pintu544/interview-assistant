import fs from 'fs';
import os from 'os';
import path from 'path';

// Config: LLM credentials live in a local file, never in source.
// Path: ~/.interview-assistant/config.json (mode 600 on POSIX).

export type ProviderKind = 'azure' | 'openai-compatible';

export interface AssistantConfig {
  /** 'azure' for Azure OpenAI, 'openai-compatible' for FastRouter / OpenAI direct. */
  provider: ProviderKind;
  /** Base endpoint, no trailing slash. Azure: https://<resource>.openai.azure.com */
  endpoint: string;
  apiKey: string;
  /** Chat model (vision-capable). Azure: deployment name. Others: model id, e.g. openai/gpt-4o. */
  chatModel: string;
  /** Whisper model/deployment for transcription. */
  whisperModel: string;
  /** Azure only, e.g. 2024-10-21. */
  apiVersion?: string;
}

const REQUIRED_KEYS = ['provider', 'endpoint', 'apiKey', 'chatModel', 'whisperModel'] as const;

const CONFIG_PATH = path.join(os.homedir(), '.interview-assistant', 'config.json');

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): AssistantConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing config at ${CONFIG_PATH}. Create it as JSON with: provider ("azure" | "openai-compatible"), endpoint, apiKey, chatModel, whisperModel, apiVersion (azure only).`,
    );
  }
  let cfg: Partial<AssistantConfig>;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<AssistantConfig>;
  } catch (err) {
    throw new Error(
      `Config at ${CONFIG_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const key of REQUIRED_KEYS) {
    if (!cfg[key]) throw new Error(`Config missing required field: ${key}`);
  }
  if (cfg.provider !== 'azure' && cfg.provider !== 'openai-compatible') {
    throw new Error(`Config provider must be "azure" or "openai-compatible".`);
  }
  if (cfg.provider === 'azure' && !cfg.apiVersion) {
    throw new Error(`Config missing required field for azure provider: apiVersion`);
  }
  return cfg as AssistantConfig;
}
