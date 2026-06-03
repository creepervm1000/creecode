import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { checkTrust } from '../trust.js';

/**
 * Custom SKILL system.
 *
 * Skills live in ~/.creecode/skills/<name>/SKILL.md. Each skill is a folder
 * with a SKILL.md (markdown + YAML front-matter describing name, description,
 * and argument schema) and a run script — run.js (Node) or run.sh (Bash).
 *
 * The skill runner is invoked with:
 *   - CREE_SKILL: skill name
 *   - CREE_ARGS: JSON-encoded args the agent passed
 *   - CREE_CONFIG: minimal JSON of relevant config (networkAllowHosts etc.)
 *   - stdin: same as CREE_ARGS (convenient for run.js that just reads stdin)
 *
 * Output: stdout is captured as the result. Stderr is included on failure.
 * Exit code 0 = success, anything else = failure.
 */

const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

function parseFrontMatter(text) {
  const m = text.match(FRONT_MATTER_RE);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      const v = kv[2].trim();
      meta[kv[1]] = v.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: m[2] };
}

export function getSkillsDir(config = {}) {
  return config.skillsDir || join(homedir(), '.creecode', 'skills');
}

export function ensureSkillsDir(config = {}) {
  const dir = getSkillsDir(config);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function discoverSkills(config = {}) {
  const dir = getSkillsDir(config);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    const mdPath = join(p, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    let text;
    try { text = readFileSync(mdPath, 'utf-8'); } catch { continue; }
    const { meta, body } = parseFrontMatter(text);
    out.push({
      name,
      dir: p,
      description: meta.description || body.split('\n')[0] || name,
      meta,
      body: body.trim(),
      runner: existsSync(join(p, 'run.js')) ? 'run.js'
            : existsSync(join(p, 'run.sh')) ? 'run.sh'
            : null,
    });
  }
  return out;
}

// Build OpenAI-compatible tool parameter schema from a simple YAML-ish args
// block in the front-matter:
//   args:
//     - name: query
//       description: Search query
//       required: true
//     - name: limit
//       description: Max results
//       type: number
function argsToSchema(args) {
  if (!Array.isArray(args)) return {};
  const out = {};
  for (const a of args) {
    if (!a || !a.name) continue;
    out[a.name] = {
      type: a.type || 'string',
      required: a.required !== false,
      description: a.description || '',
    };
  }
  return out;
}

export function skillToToolDef(skill) {
  return {
    name: `skill_${skill.name}`,
    description: `[Skill] ${skill.description}\n\n${skill.body}`.slice(0, 1500),
    category: 'skills',
    parameters: argsToSchema(skill.meta.args),
    handler: async (args, trustLevel, config) => runSkill({ skill: skill.name, ...args }, trustLevel, config),
    _isSkill: true,
  };
}

export async function runSkill(args, trustLevel, config = {}) {
  const name = args.skill;
  const dir = join(getSkillsDir(config), name);
  if (!existsSync(dir)) return { error: `Skill not found: ${name}` };
  const mdPath = join(dir, 'SKILL.md');
  if (!existsSync(mdPath)) return { error: `Skill ${name} has no SKILL.md` };
  const text = readFileSync(mdPath, 'utf-8');
  const { meta, body } = parseFrontMatter(text);

  const allowed = await checkTrust('skills', trustLevel, `Run skill: ${name}`, false);
  if (!allowed) return { error: 'Permission denied' };

  const runJs = join(dir, 'run.js');
  const runSh = join(dir, 'run.sh');
  let cmd, cmdArgs, runner;
  if (existsSync(runJs)) { cmd = process.execPath; cmdArgs = [runJs]; runner = 'run.js'; }
  else if (existsSync(runSh)) { cmd = 'bash'; cmdArgs = [runSh]; runner = 'run.sh'; }
  else return { error: `Skill ${name} has no run.js or run.sh in ${dir}` };

  // Strip the meta-only fields from args; pass the rest.
  const { skill: _omit, ...passthrough } = args || {};
  const argsJson = JSON.stringify(passthrough);
  const safeConfig = {
    networkAllowHosts: config.networkAllowHosts,
    networkDenyHosts: config.networkDenyHosts,
    workspaceRoot: config._workspaceRoot,
  };
  const env = {
    ...process.env,
    CREE_SKILL: name,
    CREE_ARGS: argsJson,
    CREE_CONFIG: JSON.stringify(safeConfig),
  };

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', settled = false;
    const finish = (code, errMsg) => {
      if (settled) return;
      settled = true;
      const max = 200000;
      const trunc = (s) => s.length > max ? s.slice(0, max) + `\n... (truncated at ${max})` : s;
      resolve({
        skill: name,
        runner,
        exitCode: typeof code === 'number' ? code : -1,
        stdout: trunc(stdout),
        stderr: trunc(errMsg ? (stderr ? stderr + '\n' + errMsg : errMsg) : stderr),
        error: errMsg || null,
      });
    };
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => finish(-1, e.message));
    child.on('close', code => finish(code));
    try { child.stdin.write(argsJson); child.stdin.end(); } catch {}
  });
}

export function initSkillDir(config = {}) {
  const dir = ensureSkillsDir(config);
  const example = join(dir, 'example-hello');
  if (!existsSync(example)) {
    mkdirSync(example, { recursive: true });
    writeFileSync(join(example, 'SKILL.md'), `---
name: example-hello
description: A minimal example skill that greets the user.
args:
  - name: name
    description: Who to greet
    required: true
---

# Example Hello Skill

Reads the \`name\` arg and prints a greeting.

Useful as a template for new skills.
`);
    writeFileSync(join(example, 'run.js'), `#!/usr/bin/env node
const args = JSON.parse(process.env.CREE_ARGS || '{}');
const name = args.name || 'world';
console.log(\`hello, \${name}!\`);
console.error('[example-hello] done');
`);
  }
  return dir;
}
