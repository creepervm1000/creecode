#!/usr/bin/env node
import { startTelegramBot } from '../src/telegram.js';

const args = process.argv.slice(2);
const configPath = args.find(a => a.startsWith('--config='))?.split('=')[1] || 'config.json';

startTelegramBot(configPath).catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
