import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { warn, dim } from './utils/logger.js';

export const TRUST_LEVELS = {
  'full-trust': { name: 'Full Trust', description: 'Allow all operations without prompting' },
  'agent-decides-trust': { name: 'Agent Decides', description: 'Safe ops auto-approved, risky ops prompt' },
  'prompt-trust': { name: 'Always Prompt', description: 'Always ask before executing' },
  'no-trust': { name: 'No Trust (Deny)', description: 'Deny all operations in this category' },
};

export const TRUST_CATEGORIES = {
  commands: 'Shell Commands',
  files:    'File Read/Write/Edit',
  network:  'HTTP / Downloads',
  git:      'Git Operations',
  process:  'Process / Env',
  notes:    'Scratchpad Notes',
  meta:     'Meta / Think',
  web:      'Web Search / Fetch',
  text:     'Text / Encoding / Hashing',
  data:     'CSV / YAML / TOML',
  time:     'Time / Cron',
  system:   'System Info / Project Tree',
};

export async function checkTrust(category, trustLevel, description, isSafe = false) {
  const categoryName = TRUST_CATEGORIES[category] || category;
  switch (trustLevel) {
    case 'full-trust': return true;
    case 'agent-decides-trust':
      if (isSafe) { dim(`  [auto-approved] ${description}`); return true; }
      return await promptUser(categoryName, description);
    case 'prompt-trust': return await promptUser(categoryName, description);
    case 'no-trust':
      warn(`Denied (${categoryName} disabled): ${description}`);
      return false;
    default: return await promptUser(categoryName, description);
  }
}

async function promptUser(categoryName, description) {
  console.log();
  console.log(chalk.yellow.bold(`  ⚡ ${categoryName} — Permission Required`));
  console.log(chalk.gray(`  ${description}`));
  console.log();
  const allowed = await confirm({ message: 'Allow this action?', default: true });
  return allowed;
}
