import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeJsonParse } from './utils/safe_json.js';

const CONFIG_DIR = join(homedir(), '.creecode');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  provider: null,
  model: null,
  baseUrl: null,
  proxy: null,
  allowOutsideWorkspace: false,

  temperature: 0.2,
  maxTokens: 4096,
  topP: 1,
  systemPromptAppendix: '',
  toolCallMode: 'xml',

  maxIterations: Infinity, // No cap. Cap-free agent loop.
  historyMaxMessages: 200,
  autoCompactHistory: true,

  commandTimeoutMs: 30000,
  commandMaxOutputBytes: 10000,
  networkTimeoutMs: 30000,
  networkMaxBytes: 200000,
  networkAllowHosts: [],
  networkDenyHosts: ['169.254.169.254', 'metadata.google.internal'],

  searchInstance: null,

  memoryFile: null,

  dangerousPaths: [],
  skillsDir: null,

  disabledTools: [],
  enabledTools: null,

  trust: {
    files: 'agent-decides-trust',
    commands: 'prompt-trust',
    network: 'prompt-trust',
    git: 'prompt-trust',
    process: 'prompt-trust',
    notes: 'full-trust',
    meta: 'full-trust',
    web: 'prompt-trust',
    text: 'full-trust',
    data: 'agent-decides-trust',
    time: 'full-trust',
    system: 'agent-decides-trust',
    memory: 'full-trust',
    skills: 'prompt-trust',
    subagents: 'full-trust',
  },

  theme: 'dark',
  logLevel: 'info',
  telemetry: false,

  editor: process.env.EDITOR || 'nano',
  webui: false,
  webuiPort: 3000,
  webuiHost: '127.0.0.1',
  webuiAuthToken: null,

  notesFile: null,
  envDenyKeys: ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'CREDENTIAL'],

  apiKeys: [],
  accounts: [],
};

export function getConfigDir() { return CONFIG_DIR; }
export function getConfigPath() { return CONFIG_PATH; }
export function configExists() { return existsSync(CONFIG_PATH); }

export function loadConfig() {
  if (!configExists()) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = safeJsonParse(raw);
    return { ...DEFAULT_CONFIG, ...parsed, trust: { ...DEFAULT_CONFIG.trust, ...(parsed.trust || {}) } };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export function saveConfig(data) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function mergeConfig(saved, cli) {
  const merged = { ...saved };
  for (const [key, value] of Object.entries(cli)) {
    if (key === '__proto__' || key === 'constructor') continue;
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

export function setConfigValue(config, keyPath, value) {
  const parts = keyPath.split('.');
  let cur = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`Invalid config key path: ${key}`);
    }
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey === '__proto__' || lastKey === 'constructor' || lastKey === 'prototype') {
    throw new Error(`Invalid config key: ${lastKey}`);
  }
  cur[lastKey] = value;
  return config;
}
