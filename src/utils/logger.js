import chalk from 'chalk';
import { APP_VERSION } from '../version.js';

const BANNER = `
  ██████╗██████╗ ███████╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗
 ██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██║     ██████╔╝█████╗  █████╗  ██║     ██║   ██║██║  ██║█████╗  
 ██║     ██╔══██╗██╔══╝  ██╔══╝  ██║     ██║   ██║██║  ██║██╔══╝  
 ╚██████╗██║  ██║███████╗███████╗╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
`;

export function banner() {
  console.log(chalk.cyan(BANNER));
  console.log(chalk.gray(`  CLI Coding Assistant — v${APP_VERSION}\n`));
}

export function info(msg) {
  console.log(chalk.blue('ℹ ') + msg);
}

export function success(msg) {
  console.log(chalk.green('✔ ') + msg);
}

export function warn(msg) {
  console.log(chalk.yellow('⚠ ') + msg);
}

export function error(msg) {
  console.log(chalk.red('✖ ') + msg);
}

export function dim(msg) {
  console.log(chalk.gray(msg));
}

export function highlight(msg) {
  console.log(chalk.magenta.bold(msg));
}

export function label(key, value) {
  console.log(chalk.gray(`  ${key}: `) + chalk.white(value));
}
