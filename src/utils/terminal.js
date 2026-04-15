export function canToggleRawMode(stream = process.stdin) {
  return Boolean(stream?.isTTY && typeof stream.setRawMode === 'function');
}

export function setRawMode(enabled, stream = process.stdin) {
  if (!canToggleRawMode(stream)) return;
  if (Boolean(stream.isRaw) === enabled) return;
  stream.setRawMode(enabled);
}
