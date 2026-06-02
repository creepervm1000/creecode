#!/usr/bin/env node

/**
 * CreeCode Bundler — merges the entire project into single executable JS files.
 * Bundles creecode (CLI), telegramo (Telegram bot), and discordo (Discord bot).
 *
 * Usage: node scripts/bundle.js [output-name]
 *   output-name: "creecode", "telegramo", or "discordo" to bundle just one
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const ENTRIES = [
  { entry: join(ROOT, 'bin', 'creecode.js'),  out: join(ROOT, 'dist', 'creecode.mjs') },
  { entry: join(ROOT, 'bin', 'telegramo.js'), out: join(ROOT, 'dist', 'telegramo.mjs') },
  { entry: join(ROOT, 'bin', 'discordo.js'),  out: join(ROOT, 'dist', 'discordo.mjs') },
];

const filter = process.argv[2];

async function bundle() {
  console.log('bundling creecode...\n');

  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });

  // Copy web UI static files into dist
  const publicSrc = join(ROOT, 'src', 'webui', 'public');
  const publicDest = join(outDir, 'public');
  if (existsSync(publicSrc)) {
    cpSync(publicSrc, publicDest, { recursive: true });
    console.log('  copied webui/public -> dist/public');
  }

  const targets = filter
    ? ENTRIES.filter(e => e.out.includes(filter))
    : ENTRIES;

  for (const { entry, out } of targets) {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      outfile: out,
      banner: {
        js: '#!/usr/bin/env node\nimport { createRequire as __ccCreateRequire } from "node:module";\nconst require = __ccCreateRequire(import.meta.url);\n',
      },
      external: [
        'node:*',
        'undici',
        'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram',
        'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'net',
        'os', 'path', 'perf_hooks', 'punycode', 'querystring', 'readline',
        'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty',
        'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
      ],
      packages: 'bundle',
      minify: false,
      sourcemap: false,
    });

    if (result.errors.length > 0) {
      console.error('  build errors:', result.errors);
      process.exit(1);
    }

    // Post-process the bundle
    let content = readFileSync(out, 'utf-8');
    content = content.replace(/^(#!\/usr\/bin\/env node\n)+/, '#!/usr/bin/env node\n');
    content = content.replace(
      /express\.static\([^)]+\)/g,
      `express.static(new URL('./public', import.meta.url).pathname)`
    );
    writeFileSync(out, content, 'utf-8');

    const { chmodSync } = await import('node:fs');
    chmodSync(out, 0o755);

    const stats = readFileSync(out);
    const sizeKB = (stats.length / 1024).toFixed(1);
    const name = out.split('/').pop();
    console.log(`  bundled ${name} (${sizeKB} KB)`);
  }

  console.log('\ndone! run with:');
  for (const { out } of targets) {
    console.log(`  node ${out.replace(ROOT + '/', '')}`);
  }
}

bundle().catch((err) => {
  console.error('bundle failed:', err.message);
  process.exit(1);
});
