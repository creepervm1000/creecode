#!/usr/bin/env node

/**
 * CreeCode Bundler — merges the entire project into a single executable JS file.
 * Uses esbuild to bundle all source files, then prepends the shebang.
 * 
 * Usage: node scripts/bundle.js [output]
 *   output: path for the bundled file (default: dist/creecode.mjs)
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const outFile = process.argv[2] || join(ROOT, 'dist', 'creecode.mjs');

async function bundle() {
  console.log('📦 Bundling CreeCode...\n');

  const outDir = dirname(outFile);
  mkdirSync(outDir, { recursive: true });

  // Copy web UI static files into dist
  const publicSrc = join(ROOT, 'src', 'webui', 'public');
  const publicDest = join(outDir, 'public');
  if (existsSync(publicSrc)) {
    cpSync(publicSrc, publicDest, { recursive: true });
    console.log('  ✔ Copied webui/public → dist/public');
  }

  // Bundle with esbuild
  const result = await build({
    entryPoints: [join(ROOT, 'bin', 'creecode.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: outFile,
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __ccCreateRequire } from "node:module";\nconst require = __ccCreateRequire(import.meta.url);\n',
    },
    // Mark node builtins as external (both node: and bare forms for CJS compat)
    external: [
      'node:*',
      'undici',
      // Bare builtins for CJS packages bundled in ESM
      'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram',
      'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'net',
      'os', 'path', 'perf_hooks', 'punycode', 'querystring', 'readline',
      'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty',
      'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
    ],
    // Inline all local modules + npm deps
    packages: 'bundle',
    minify: false, // Keep readable for debugging
    sourcemap: false,
  });

  if (result.errors.length > 0) {
    console.error('  ✖ Build errors:', result.errors);
    process.exit(1);
  }

  // Post-process the bundle
  let content = readFileSync(outFile, 'utf-8');

  // Fix duplicate shebangs (entry point has one + banner adds one)
  content = content.replace(/^(#!\/usr\/bin\/env node\n)+/, '#!/usr/bin/env node\n');


  // Patch the webui server's static path to be relative to the bundle
  content = content.replace(
    /express\.static\([^)]+\)/g,
    `express.static(new URL('./public', import.meta.url).pathname)`
  );
  writeFileSync(outFile, content, 'utf-8');

  // Make executable
  const { chmodSync } = await import('node:fs');
  chmodSync(outFile, 0o755);

  const stats = readFileSync(outFile);
  const sizeKB = (stats.length / 1024).toFixed(1);

  console.log(`  ✔ Bundled to ${outFile} (${sizeKB} KB)`);
  console.log('\n✅ Done! Run with:');
  console.log(`   node ${outFile}`);
  console.log(`   # or: chmod +x ${outFile} && ./${outFile.replace(ROOT + '/', '')}`);
}

bundle().catch((err) => {
  console.error('Bundle failed:', err.message);
  process.exit(1);
});
