#!/usr/bin/env node
import { startCreeChatBot } from '../src/creechat.js';

const args = process.argv.slice(2);
const configPath = args.find(a => a.startsWith('--config='))?.split('=')[1] || 'config.json';

startCreeChatBot(configPath).catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
