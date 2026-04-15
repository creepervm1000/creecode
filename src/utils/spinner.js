import ora from 'ora';

export function createSpinner(text = 'Thinking...') {
  return ora({
    text,
    spinner: 'dots',
    color: 'cyan',
  });
}
