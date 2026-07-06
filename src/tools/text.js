import { createHash, randomBytes } from 'node:crypto';
import { safeJsonParse } from '../utils/safe_json.js';
import { isRegexSafe, isInputSafe } from '../utils/regex.js';

/**
 * Text / encoding / hashing utilities. All operate on strings in memory —
 * they don't touch the filesystem.
 */

function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function strToBuf(s, encoding) {
  if (encoding === 'utf-8' || !encoding) return Buffer.from(s, 'utf-8');
  if (encoding === 'latin1' || encoding === 'binary') return Buffer.from(s, 'latin1');
  if (encoding === 'hex') return Buffer.from(s.replace(/\s+/g, ''), 'hex');
  return Buffer.from(s, 'utf-8');
}

function bufToStr(buf, encoding) {
  if (encoding === 'utf-8' || !encoding) return buf.toString('utf-8');
  if (encoding === 'latin1' || encoding === 'binary') return buf.toString('latin1');
  if (encoding === 'hex') return buf.toString('hex');
  if (encoding === 'base64') return buf.toString('base64');
  if (encoding === 'base64url') return buf.toString('base64url');
  return buf.toString('utf-8');
}

export async function base64Encode(args) {
  const input = args.input == null ? '' : String(args.input);
  const enc = args.input_encoding || 'utf-8';
  const out = args.url_safe ? 'base64url' : 'base64';
  try {
    const buf = strToBuf(input, enc);
    return { input_encoding: enc, output_encoding: out, output: buf.toString(out) };
  } catch (e) { return { error: e.message }; }
}

export async function base64Decode(args) {
  const input = args.input == null ? '' : String(args.input);
  const out = args.output_encoding || 'utf-8';
  // auto-detect base64url by charset
  const looksUrl = /[-_]/.test(input) && !/[/+=]/.test(input);
  const fmt = args.url_safe || looksUrl ? 'base64url' : 'base64';
  try {
    const buf = fmt === 'base64url' ? b64urlToBuf(input) : Buffer.from(input, 'base64');
    return { input_encoding: fmt, output_encoding: out, output: bufToStr(buf, out) };
  } catch (e) { return { error: e.message }; }
}

const SUPPORTED_HASHES = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];

export async function hashText(args) {
  const algo = (args.algorithm || 'sha256').toLowerCase();
  if (!SUPPORTED_HASHES.includes(algo)) return { error: `Unsupported algorithm: ${algo}. Use one of: ${SUPPORTED_HASHES.join(', ')}` };
  const input = args.input == null ? '' : String(args.input);
  const enc = args.encoding || 'utf-8';
  let buf;
  try { buf = strToBuf(input, enc); } catch (e) { return { error: e.message }; }
  const h = createHash(algo).update(buf).digest('hex');
  return { algorithm: algo, encoding: enc, length: buf.length, hex: h };
}

export async function urlEncode(args) {
  const input = args.input == null ? '' : String(args.input);
  const component = args.component !== false; // default true
  return { output: component ? encodeURIComponent(input) : encodeURI(input), mode: component ? 'component' : 'uri' };
}

export async function urlDecode(args) {
  const input = args.input == null ? '' : String(args.input);
  const component = args.component !== false;
  try {
    return { output: component ? decodeURIComponent(input) : decodeURI(input), mode: component ? 'component' : 'uri' };
  } catch (e) { return { error: `Invalid URL encoding: ${e.message}` }; }
}

export async function jsonFormat(args) {
  const input = args.input == null ? '' : String(args.input);
  const indent = args.indent == null ? 2 : args.indent;
  try {
    const parsed = safeJsonParse(input);
    return { output: JSON.stringify(parsed, null, indent), valid: true };
  } catch (e) { return { error: `Invalid JSON: ${e.message}`, valid: false }; }
}

export async function jsonValidate(args) {
  const input = args.input == null ? '' : String(args.input);
  try {
    const parsed = safeJsonParse(input);
    return {
      valid: true,
      type: Array.isArray(parsed) ? 'array' : typeof parsed,
      length: Array.isArray(parsed) ? parsed.length : (typeof parsed === 'object' && parsed ? Object.keys(parsed).length : null),
    };
  } catch (e) { return { valid: false, error: e.message }; }
}

export async function uuidGenerate(args) {
  // RFC 4122 v4. crypto.randomUUID is available on Node 16.7+; fall back manually.
  let id;
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    id = globalThis.crypto.randomUUID();
  } else {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    id = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }
  return { uuid: id, version: 4, variant: 'rfc4122' };
}

export async function randomString(args) {
  const length = Math.max(1, Math.min(1024, args.length || 16));
  const alphabet = args.alphabet || 'alphanumeric';
  let chars;
  switch (alphabet) {
    case 'hex': chars = '0123456789abcdef'; break;
    case 'base64': chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; break;
    case 'base64url': chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; break;
    case 'numeric': chars = '0123456789'; break;
    case 'alpha': chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; break;
    case 'alphanumeric':
    default: chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  }
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length];
  return { length, alphabet, value: out };
}

export async function jwtDecode(args) {
  const token = (args.token || '').trim();
  if (!token) return { error: 'token is required' };
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'Not a 3-part JWT (header.payload.signature)' };
  let header, payload, sigRaw;
  try {
    header = safeJsonParse(b64urlToBuf(parts[0]).toString('utf-8'));
  } catch (e) { return { error: `Bad header: ${e.message}` }; }
  try {
    payload = safeJsonParse(b64urlToBuf(parts[1]).toString('utf-8'));
  } catch (e) { return { error: `Bad payload: ${e.message}` }; }
  try { sigRaw = b64urlToBuf(parts[2]).toString('hex'); } catch (e) { sigRaw = null; }
  // Surface standard claims with normalized types.
  const claims = {};
  for (const k of ['exp', 'nbf', 'iat']) {
    if (payload[k] != null) {
      const n = Number(payload[k]);
      claims[k] = { value: payload[k], iso: new Date(n * 1000).toISOString(), expired: k === 'exp' ? (n * 1000 < Date.now()) : undefined };
    }
  }
  return {
    header,
    payload,
    signature_hex: sigRaw,
    algorithm: header.alg || null,
    claims,
    note: 'Decoded without signature verification. Do not trust the contents until verified.',
  };
}

export async function regexTest(args) {
  const pattern = args.pattern;
  const text = args.input == null ? '' : String(args.input);
  if (!pattern) return { error: 'pattern is required' };
  const flags = (args.flags || '').replace(/[^gimsuyd]/g, '');
  if (!isInputSafe(text)) return { error: `Input too long (${text.length} chars)` };
  const checked = isRegexSafe(pattern, flags);
  if (!checked.safe) return { error: checked.reason };
  const re = checked.re;
  if (flags.includes('g')) {
    const matches = [];
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
      matches.push({ match: m[0], index: m.index, groups: m.groups || null });
      if (++guard > 1000) break;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return { matches, count: matches.length };
  }
  const m = re.exec(text);
  return { matches: m ? [{ match: m[0], index: m.index, groups: m.groups || null }] : [], count: m ? 1 : 0 };
}
