import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { warn, dim } from './utils/logger.js';

/**
 * Trust levels for tool categories.
 * 
 * full-trust:          Allow everything silently
 * agent-decides-trust: Agent decides if it's safe — skips prompt for safe ops, prompts for risky ones
 * prompt-trust:        Always prompt the user before executing
 * no-trust:            Deny the category entirely
 */
export const TRUST_LEVELS = {
  'full-trust': {
    name: 'Full Trust',
    description: 'Allow all operations without prompting',
  },
  'agent-decides-trust': {
    name: 'Agent Decides',
    description: 'Agent decides when to prompt (safe ops auto-approved, risky ops prompt)',
  },
  'prompt-trust': {
    name: 'Always Prompt',
    description: 'Always ask before executing',
  },
  'no-trust': {
    name: 'No Trust (Deny)',
    description: 'Deny all operations in this category',
  },
};

export const TRUST_CATEGORIES = {
  commands: 'Shell Commands',
  files: 'File Read/Write/Edit',
};

/**
 * Check if an action is allowed under the given trust level.
 * Returns true if allowed, false if denied.
 * May prompt the user interactively.
 * 
 * @param {string} category - 'commands' or 'files'
 * @param {string} trustLevel - one of the TRUST_LEVELS keys
 * @param {string} description - human-readable description of what's about to happen
 * @param {boolean} isSafe - whether the agent considers this action safe (for agent-decides)
 */
export async function checkTrust(category, trustLevel, description, isSafe = false) {
  const categoryName = TRUST_CATEGORIES[category] || category;

  switch (trustLevel) {
    case 'full-trust':
      return true;

    case 'agent-decides-trust':
      if (isSafe) {
        dim(`  [auto-approved] ${description}`);
        return true;
      }
      // Fall through to prompt
      return await promptUser(categoryName, description);

    case 'prompt-trust':
      return await promptUser(categoryName, description);

    case 'no-trust':
      warn(`Denied (${categoryName} disabled): ${description}`);
      return false;

    default:
      return await promptUser(categoryName, description);
  }
}

async function promptUser(categoryName, description) {
  console.log();
  console.log(chalk.yellow.bold(`  ⚡ ${categoryName} — Permission Required`));
  console.log(chalk.gray(`  ${description}`));
  console.log();

  const allowed = await confirm({
    message: 'Allow this action?',
    default: true,
  });

  return allowed;
}
