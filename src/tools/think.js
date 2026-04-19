export async function think(args) {
  return { ok: true, thought: (args.thought || '').slice(0, 2000) };
}
