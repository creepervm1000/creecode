import { checkTrust } from '../trust.js';

/**
 * Web tools: search the web, fetch & convert HTML, extract links/metadata.
 * Backed by raw HTTP — no external deps. Uses DuckDuckGo HTML for search
 * so no API key is required.
 */

function hostAllowed(url, config) {
  try {
    const u = new URL(url);
    const deny = config.networkDenyHosts || [];
    const allow = config.networkAllowHosts || [];
    if (deny.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return false;
    if (allow.length === 0) return true;
    return allow.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&copy;': '©', '&reg;': '®', '&trade;': '™',
  '&hellip;': '…', '&mdash;': '—', '&ndash;': '–', '&lsquo;': '\u2018', '&rsquo;': '\u2019',
  '&ldquo;': '\u201c', '&rdquo;': '\u201d', '&bull;': '•', '&middot;': '·',
  '&deg;': '°', '&para;': '¶', '&sect;': '§', '&euro;': '€', '&pound;': '£', '&yen;': '¥',
  '&cent;': '¢', '&times;': '×', '&divide;': '÷', '&micro;': 'µ', '&plusmn;': '±',
};

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp|copy|reg|trade|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo|bull|middot|deg|para|sect|euro|pound|yen|cent|times|divide|micro|plusmn);/g, (m) => HTML_ENTITIES[m] || m);
}

// Strip script/style/head blocks, then tags, then collapse whitespace.
function htmlToText(html, opts = {}) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  if (opts.markdown) {
    // crude markdown conversion
    s = s.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
    s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
    s = s.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
    s = s.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
    s = s.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
    s = s.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');
    s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1\n');
    s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
    s = s.replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr|td|th|blockquote|pre|figure|figcaption)\b[^>]*>/gi, '\n');
  } else {
    s = s.replace(/<(br|hr|p|div|li|tr|h[1-6])\b[^>]*\/?>/gi, '\n');
  }
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\s*\n\s*/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function stripTags(s) {
  if (!s) return '';
  return decodeEntities(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function attrExtract(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
         || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? m[1] : null;
}

async function fetchRaw(url, config, timeoutMs) {
  const fetchFn = config.fetchFn || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || config.networkTimeoutMs || 30000);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    const max = config.networkMaxBytes || 200000;
    return {
      status: res.status,
      ok: res.ok,
      finalUrl: res.url || url,
      headers: Object.fromEntries(res.headers.entries()),
      body: text.length > max ? text.slice(0, max) + `\n...(truncated ${text.length} total)` : text,
    };
  } finally { clearTimeout(t); }
}

// ---- Search backends ----

// DuckDuckGo HTML: no API key, but may captcha under load.
async function ddgSearch(query, limit, config) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchRaw(url, config);
  if (!res.ok) return { backend: 'ddg', error: `Search backend returned HTTP ${res.status}` };
  if (/anomaly-modal|Unfortunately, bots use/i.test(res.body)) {
    return { backend: 'ddg', error: 'DuckDuckGo blocked the request with a captcha.', captcha: true };
  }
  const html = res.body;
  const results = [];
  const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*\blinks\b[^"]*"/g;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < limit) {
    const block = m[1];
    const aMatch = block.match(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    let href = aMatch[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    const title = stripTags(aMatch[2]);
    const snipMatch = block.match(/<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
                   || block.match(/<div[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : '';
    if (title) results.push({ title, url: href, snippet });
  }
  return { backend: 'ddg', query, count: results.length, results };
}

// Bing HTML: works without an API key, but layout is heavier and links are
// wrapped in a redirector (/ck/a?u=<base64-url>). We unwrap those.
async function bingSearch(query, limit, config) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetchRaw(url, config);
  if (!res.ok) return { backend: 'bing', error: `Search backend returned HTTP ${res.status}` };
  if (/captcha|verify you are a human/i.test(res.body.slice(0, 5000))) {
    return { backend: 'bing', error: 'Bing blocked the request with a captcha.', captcha: true };
  }
  const html = res.body;
  const results = [];
  const blockRe = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < limit) {
    const block = m[1];
    const aMatch = block.match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const href = aMatch[1];
    const title = stripTags(aMatch[2]);
    if (!title) continue;
    let real = href;
    if (/^https?:\/\/(www\.)?bing\.com\/ck\/a\?/i.test(href)) {
      // The href is HTML-attribute-escaped (&amp;&amp; etc.). Decode first.
      const decoded = href.replace(/&amp;/g, '&');
      const u = decoded.match(/[?&]u=([^&]+)/);
      if (u) {
        try { real = Buffer.from(decodeURIComponent(u[1]), 'base64').toString('utf-8'); } catch {}
      }
    }
    if (!/^https?:/i.test(real)) continue;
    const pMatch = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = pMatch ? stripTags(pMatch[1]) : '';
    results.push({ title, url: real, snippet });
  }
  return { backend: 'bing', query, count: results.length, results };
}

// SearXNG JSON API. Requires a configured instance URL.
async function searxngSearch(query, limit, config) {
  const instance = (config.searchInstance || '').replace(/\/+$/, '');
  if (!instance) return { backend: 'searxng', error: 'No SearXNG instance configured. Set config.searchInstance, e.g. "https://search.example.org".' };
  const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`;
  const fetchFn = config.fetchFn || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.networkTimeoutMs || 30000);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } });
    if (!res.ok) return { backend: 'searxng', error: `SearXNG returned HTTP ${res.status}` };
    const data = await res.json();
    const results = (data.results || []).slice(0, limit).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || '',
    }));
    return { backend: 'searxng', query, count: results.length, results };
  } catch (e) { return { backend: 'searxng', error: e.message }; }
  finally { clearTimeout(t); }
}

// Wikipedia OpenSearch: free, no key, reliable. Only searches Wikipedia.
async function wikipediaSearch(query, limit, config) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${Math.min(50, limit)}&utf8=1&origin=*`;
  const fetchFn = config.fetchFn || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.networkTimeoutMs || 30000);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { backend: 'wikipedia', error: `Wikipedia API returned HTTP ${res.status}` };
    const data = await res.json();
    const hits = (data.query && data.query.search) || [];
    const results = hits.map(h => {
      const title = h.title || '';
      const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
      const snippet = stripTags(h.snippet || '');
      return { title, url, snippet, pageid: h.pageid };
    });
    return { backend: 'wikipedia', query, count: results.length, results, total: data.query?.searchinfo?.totalhits };
  } catch (e) { return { backend: 'wikipedia', error: e.message }; }
  finally { clearTimeout(t); }
}

export async function webSearch(args, trustLevel, config = {}) {
  const query = (args.query || '').trim();
  if (!query) return { error: 'query is required' };
  const limit = Math.max(1, Math.min(50, args.limit || 10));
  const requested = (args.backend || 'auto').toLowerCase();
  const allowed = await checkTrust('web', trustLevel, `Web search: "${query}" via ${requested} (max ${limit} results)`, false);
  if (!allowed) return { error: 'Permission denied' };

  const order = requested === 'auto'
    ? ['searxng', 'ddg', 'bing', 'wikipedia']
    : [requested];
  const tried = [];
  for (const backend of order) {
    let r;
    try {
      if (backend === 'ddg') r = await ddgSearch(query, limit, config);
      else if (backend === 'bing') r = await bingSearch(query, limit, config);
      else if (backend === 'searxng') r = await searxngSearch(query, limit, config);
      else if (backend === 'wikipedia') r = await wikipediaSearch(query, limit, config);
      else { r = { backend, error: `Unknown backend: ${backend}` }; }
    } catch (e) { r = { backend, error: e.message }; }
    tried.push({ backend, error: r.error, count: r.count, captcha: r.captcha });
    if (r && !r.error && r.count > 0) {
      r.tried = tried;
      return r;
    }
  }
  return {
    error: `All backends failed for "${query}".`,
    tried,
    hint: 'Set config.searchInstance to a self-hosted SearXNG URL for reliable general web search, or pass backend="wikipedia" to search Wikipedia only.',
  };
}

export async function webFetch(args, trustLevel, config = {}) {
  const url = (args.url || '').trim();
  if (!url) return { error: 'url is required' };
  if (!hostAllowed(url, config)) return { error: `Host not allowed by network policy: ${url}` };
  const format = (args.format || 'text').toLowerCase();
  const maxBytes = args.max_bytes || config.networkMaxBytes || 200000;
  const allowed = await checkTrust('web', trustLevel, `Web fetch: ${url} (${format})`, (args.method || 'GET').toUpperCase() === 'GET');
  if (!allowed) return { error: 'Permission denied' };
  try {
    const res = await fetchRaw(url, config, args.timeout);
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText || ''}`.trim(), status: res.status, finalUrl: res.finalUrl };
    const ctype = (res.headers['content-type'] || '').toLowerCase();
    if (!ctype.includes('html')) {
      // not HTML — return raw body (capped)
      const cap = res.body.length > maxBytes ? res.body.slice(0, maxBytes) + `\n...(truncated ${res.body.length} total)` : res.body;
      return { url, finalUrl: res.finalUrl, contentType: ctype, format: 'raw', body: cap };
    }
    if (format === 'html') {
      return { url, finalUrl: res.finalUrl, contentType: ctype, format: 'html', body: res.body };
    }
    const text = htmlToText(res.body, { markdown: format === 'markdown' });
    return { url, finalUrl: res.finalUrl, contentType: ctype, format, body: text };
  } catch (e) { return { error: `Fetch failed: ${e.message}` }; }
}

export async function webExtractLinks(args, trustLevel, config = {}) {
  const url = (args.url || '').trim();
  if (!url) return { error: 'url is required' };
  if (!hostAllowed(url, config)) return { error: `Host not allowed: ${url}` };
  const allowed = await checkTrust('web', trustLevel, `Extract links from: ${url}`, true);
  if (!allowed) return { error: 'Permission denied' };
  try {
    const res = await fetchRaw(url, config, args.timeout);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const links = [];
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    const baseUrl = res.finalUrl || url;
    let baseOrigin = null;
    try { baseOrigin = new URL(baseUrl).origin; } catch {}
    while ((m = re.exec(res.body)) !== null) {
      const attrs = m[1];
      const inner = m[2];
      const href = attrExtract(attrs, 'href');
      if (!href) continue;
      const text = stripTags(inner);
      let abs = href;
      try { abs = new URL(href, baseUrl).href; } catch {}
      let kind = 'external';
      try {
        const u = new URL(abs);
        if (baseOrigin && u.origin === baseOrigin) kind = 'internal';
      } catch {}
      links.push({ href: abs, text, kind });
      if (links.length >= 500) break;
    }
    return { url, finalUrl: res.finalUrl, count: links.length, links };
  } catch (e) { return { error: e.message }; }
}

export async function webExtractMeta(args, trustLevel, config = {}) {
  const url = (args.url || '').trim();
  if (!url) return { error: 'url is required' };
  if (!hostAllowed(url, config)) return { error: `Host not allowed: ${url}` };
  const allowed = await checkTrust('web', trustLevel, `Extract metadata from: ${url}`, true);
  if (!allowed) return { error: 'Permission denied' };
  try {
    const res = await fetchRaw(url, config, args.timeout);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const html = res.body;
    const meta = {};
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) meta.title = stripTags(titleMatch[1]);
    const descMatch = html.match(/<meta\b[^>]*name\s*=\s*"description"[^>]*content\s*=\s*"([^"]*)"/i)
                   || html.match(/<meta\b[^>]*content\s*=\s*"([^"]*)"[^>]*name\s*=\s*"description"/i);
    if (descMatch) meta.description = descMatch[1];
    // og:* tags
    const ogRe = /<meta\b([^>]*\bproperty\s*=\s*"og:([^"]+)"[^>]*)>/gi;
    let m;
    while ((m = ogRe.exec(html)) !== null) {
      const attrs = m[1];
      const key = m[2];
      const content = attrExtract(attrs, 'content');
      if (content) meta[`og:${key}`] = content;
    }
    // twitter:* tags
    const twRe = /<meta\b([^>]*\bname\s*=\s*"twitter:([^"]+)"[^>]*)>/gi;
    while ((m = twRe.exec(html)) !== null) {
      const attrs = m[1];
      const key = m[2];
      const content = attrExtract(attrs, 'content');
      if (content) meta[`twitter:${key}`] = content;
    }
    // canonical
    const canonMatch = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i)
                    || html.match(/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']canonical["']/i);
    if (canonMatch) meta.canonical = canonMatch[1];
    // lang
    const htmlTag = html.match(/<html\b([^>]*)>/i);
    if (htmlTag) {
      const lang = attrExtract(htmlTag[1], 'lang');
      if (lang) meta.lang = lang;
    }
    // headings
    const headings = [];
    const headRe = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
    while ((m = headRe.exec(html)) !== null) {
      const t = stripTags(m[2]);
      if (t) headings.push({ level: parseInt(m[1].slice(1), 10), text: t });
      if (headings.length >= 50) break;
    }
    return { url, finalUrl: res.finalUrl, meta, headings };
  } catch (e) { return { error: e.message }; }
}
