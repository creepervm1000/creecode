import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.creecode');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function getConfigDir() {
  return CONFIG_DIR;
}

export function getConfigPath() {
  return CONFIG_PATH;
}

export function configExists() {
  return existsSync(CONFIG_PATH);
}

export function loadConfig() {
  if (!configExists()) {
    return {};
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveConfig(data) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function mergeConfig(saved, cli) {
  // CLI flags override saved config
  const merged = { ...saved };
  for (const [key, value] of Object.entries(cli)) {
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  return merged;
}
