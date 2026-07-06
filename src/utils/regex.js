const MAX_PATTERN_LENGTH = 500;
const MAX_INPUT_LENGTH = 100000;

const CATASTROPHIC_PATTERNS = [
  /\(\.[+*]\)[+*]/,
  /\(\.\*\)\*/,
  /\(\.\+\)\+/,
  /\(\.\*\?\)\*/,
  /\(\.\+\?\)\+/,
  /\([^)]+\)\s*[+*]\s*\)\s*[+*]/,
  /\([^)]+\)\s*[+*]\s*\)\s*\?/,
  /\(\?:\s*\w+\s*\|?\s*\)\s*\+/,
];

export function isRegexSafe(pattern, flags) {
  if (!pattern || typeof pattern !== 'string') return { safe: false, reason: 'Pattern must be a non-empty string' };
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { safe: false, reason: `Pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH})` };
  }
  for (const dangerous of CATASTROPHIC_PATTERNS) {
    if (dangerous.test(pattern)) {
      return { safe: false, reason: 'Pattern contains potentially catastrophic backtracking pattern' };
    }
  }
  try {
    const re = new RegExp(pattern, flags);
    if (!re) return { safe: false, reason: 'Failed to compile regex' };
    return { safe: true, re };
  } catch (e) {
    return { safe: false, reason: `Invalid regex: ${e.message}` };
  }
}

export function isInputSafe(text) {
  if (text && text.length > MAX_INPUT_LENGTH) return false;
  return true;
}
