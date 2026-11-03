/**
 * overleaf-client.js
 *
 * A self-contained ES module that drives an Overleaf Community-Edition
 * deployment (verified against https://latex.cstcloud.cn) so that a local
 * LaTeX project folder can be compiled server-side with no local TeX install.
 *
 * Design constraints:
 *   - Pure Node ESM. Only `node:` builtins (fs/promises, path, zlib, crypto,
 *     url, stream). No npm dependencies, no DSH/harness imports.
 *   - All network access goes through an injectable `fetchImpl` so the module
 *     is fully testable offline against a fake server.
 *   - Credentials and cookies are never logged; they are redacted from error
 *     detail strings.
 *
 * @module overleaf-client
 */

import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';

/* ------------------------------------------------------------------------- *
 * Error type
 * ------------------------------------------------------------------------- */

/**
 * Error codes this client throws.
 * @readonly
 * @enum {string}
 */
export const ErrorCode = Object.freeze({
  /** Credentials were rejected (HTTP 401 on /login). */
  AUTH_INVALID: 'AUTH_INVALID',
  /** CSRF token missing/expired/rejected (HTTP 403 on a mutating request). */
  AUTH_CSRF: 'AUTH_CSRF',
  /** A route required a session and we do not have a usable one (302 -> /login). */
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  /** Client-side usage error (bad arguments, missing file, ...). */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** Server rejected the request payload (HTTP 422). */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Any other non-2xx HTTP response. */
  HTTP_ERROR: 'HTTP_ERROR',
  /** Transport-level failure: DNS, TLS, timeout, socket reset. */
  NETWORK: 'NETWORK',
  /** Compile ran and reported a non-success status (LaTeX error, timeout, ...). */
  COMPILE_FAILED: 'COMPILE_FAILED',
  /** A downloaded artifact was not what we expected (e.g. not a PDF). */
  BAD_ARTIFACT: 'BAD_ARTIFACT',
});

/**
 * Error thrown by every client operation that fails.
 *
 * @property {string} code       One of {@link ErrorCode}.
 * @property {number} [status]   HTTP status, when the failure came from a response.
 * @property {string} detail     Human-readable, credential-redacted detail.
 */
export class OverleafError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.code]
   * @param {number} [opts.status]
   * @param {string} [opts.detail]
   * @param {unknown} [opts.cause]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'OverleafError';
    this.code = opts.code || ErrorCode.HTTP_ERROR;
    this.status = opts.status;
    this.detail = opts.detail || '';
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  /** Compact single-line rendering, safe for logs. */
  toString() {
    const bits = [`[${this.code}]`, this.message];
    if (this.status) bits.push(`(HTTP ${this.status})`);
    if (this.detail) bits.push(`- ${this.detail}`);
    return bits.join(' ');
  }
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_USER_AGENT =
  'overleaf-client/1.0 (+node; automated compile helper)';

/** Bytes of a response body retained in `OverleafError.detail`. */
const DETAIL_LIMIT = 1200;

/**
 * Truncate a string for inclusion in an error detail.
 * @param {string} s
 * @param {number} [limit]
 * @returns {string}
 */
function truncate(s, limit = DETAIL_LIMIT) {
  if (typeof s !== 'string') s = String(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= limit ? s : s.slice(0, limit) + '…';
}

/**
 * Escape control chars/newlines so a detail is single-line in logs.
 * @param {string} s
 */
function oneLine(s) {
  return String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** Normalize a base URL: no trailing slash. @param {string} s */
function normalizeBaseUrl(s) {
  return String(s || '').replace(/\/+$/, '');
}

/**
 * Join a base URL and an absolute-or-relative path.
 * @param {string} baseUrl
 * @param {string} pathOrUrl
 * @returns {{url: URL, sameOrigin: boolean}}
 */
function resolveTarget(baseUrl, pathOrUrl) {
  const base = new URL(baseUrl);
  let url;
  try {
    url = new URL(pathOrUrl, baseUrl + '/');
  } catch (err) {
    throw new OverleafError(`Cannot resolve URL: ${pathOrUrl}`, {
      code: ErrorCode.INVALID_ARGUMENT,
      cause: err,
    });
  }
  return { url, sameOrigin: url.origin === base.origin };
}

/**
 * Build a `node:zlib`-free CRC-32 fallback table. `zlib.crc32` exists on
 * Node >= 20.15 / 22.2, but we support a table implementation for safety.
 */
let _crcTable = null;
/** @returns {Uint32Array} */
function crcTable() {
  if (_crcTable) return _crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  _crcTable = t;
  return t;
}

/**
 * CRC-32 (IEEE 802.3, the polynomial used by ZIP). Prefers the native
 * `zlib.crc32` when the running Node exposes it, else a table implementation.
 *
 * @param {Buffer} buf
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------------- *
 * Cookie jar
 * ------------------------------------------------------------------------- */

/**
 * A deliberately small cookie jar: enough for the handful of cookies Overleaf
 * sets (`overleaf.sid`, `latex-session`, `_gid`, ...). It is origin-agnostic
 * because a client instance is bound to exactly one deployment.
 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, string>} */
    this._cookies = new Map();
  }

  /**
   * Parse and store `Set-Cookie` header values from a response.
   * Handles multiple cookies, `Max-Age=0` / past `Expires` deletion, and
   * ignores attributes (`Path`, `Domain`, `Secure`, `HttpOnly`, `SameSite`).
   *
   * @param {Headers|{getSetCookie?:()=>string[], get?:(n:string)=>string|null}} headers
   */
  absorb(headers) {
    /** @type {string[]} */
    let setCookies = [];
    if (headers && typeof headers.getSetCookie === 'function') {
      setCookies = headers.getSetCookie() || [];
    }
    if ((!setCookies || setCookies.length === 0) && headers && typeof headers.get === 'function') {
      const joined = headers.get('set-cookie');
      if (joined) setCookies = splitCombinedSetCookie(joined);
    }
    for (const raw of setCookies) this._absorbOne(raw);
    return this;
  }

  /** @param {string} raw */
  _absorbOne(raw) {
    if (!raw) return;
    const parts = String(raw).split(';');
    const pair = parts.shift() || '';
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return;

    let expired = value === '';
    for (const attr of parts) {
      const [k, ...rest] = attr.split('=');
      const key = k.trim().toLowerCase();
      const val = rest.join('=').trim();
      if (key === 'max-age') {
        const n = Number(val);
        if (Number.isFinite(n) && n <= 0) expired = true;
      } else if (key === 'expires') {
        const t = Date.parse(val);
        if (Number.isFinite(t) && t <= Date.now()) expired = true;
      }
    }

    if (expired) this._cookies.delete(name);
    else this._cookies.set(name, value);
  }

  /** @returns {Map<string,string>} a copy of current cookies */
  toMap() {
    return new Map(this._cookies);
  }

  /** @param {string} name */
  get(name) {
    return this._cookies.get(name);
  }

  /** @param {string} name */
  has(name) {
    return this._cookies.has(name);
  }

  /** Remove every cookie. */
  clear() {
    this._cookies.clear();
  }

  /** Number of stored cookies. */
  get size() {
    return this._cookies.size;
  }

  /**
   * Render the `Cookie` request header value.
   * @returns {string} empty string when the jar is empty
   */
  header() {
    const out = [];
    for (const [k, v] of this._cookies) out.push(`${k}=${v}`);
    return out.join('; ');
  }

  /**
   * Snapshot with values masked, safe for logs and error details.
   * @returns {Record<string,string>}
   */
  redacted() {
    /** @type {Record<string,string>} */
    const out = {};
    for (const k of this._cookies.keys()) out[k] = '***';
    return out;
  }
}

/**
 * Split a combined `Set-Cookie` header (some runtimes/proxies fold several
 * cookies into one comma-joined header). Commas inside `Expires` dates are the
 * hazard, so only split on `,` followed by `name=`.
 *
 * @param {string} header
 * @returns {string[]}
 */
export function splitCombinedSetCookie(header) {
  const out = [];
  let cur = '';
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === ',') {
      const rest = header.slice(i + 1);
      // RFC 7230 tchar set, with the backtick escaped so it cannot be read as
      // the start of a template literal.
      const isTokenStart = /^\s*[!#$%&'*+\-.^_\u0060|~0-9A-Za-z]+=/.test(rest);
      if (isTokenStart) {
        out.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* ------------------------------------------------------------------------- *
 * Stored (no-compression) ZIP writer
 * ------------------------------------------------------------------------- */

/**
 * Deterministic DOS date/time for a JS date. ZIP stores local time; using UTC
 * keeps archives byte-reproducible across machines/timezones.
 *
 * @param {Date} d
 * @returns {{time: number, date: number}}
 */
function dosDateTime(d) {
  const year = d.getUTCFullYear();
  // ZIP's DOS epoch starts in 1980 and the field is 7 bits wide (1980..2107).
  const y = Math.min(Math.max(year, 1980), 2107) - 1980;
  const time =
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = (y << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/**
 * Build a ZIP archive in memory using **stored** (method 0, no compression)
 * entries. Stored entries need no compressor, make the archive trivially
 * inspectable and avoid zlib-version-dependent output.
 *
 * Layout per the PKWARE APPNOTE: local file header, file data, then a central
 * directory, then the end-of-central-directory record. CRC-32 and sizes are
 * written in both the local header and the central directory.
 *
 * @param {Array<{name: string, data: Buffer, mtime?: Date}>} entries
 *   `name` must already be normalized to forward slashes and be relative.
 * @returns {Buffer}
 */
export function createStoredZip(entries) {
  if (!Array.isArray(entries)) {
    throw new OverleafError('createStoredZip expects an array of entries', {
      code: ErrorCode.INVALID_ARGUMENT,
    });
  }

  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Array<object>} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name).replace(/\\/g, '/');
    if (!name || name.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(name)) {
      throw new OverleafError(`Refusing unsafe ZIP entry name: ${name}`, {
        code: ErrorCode.INVALID_ARGUMENT,
      });
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.mtime instanceof Date ? entry.mtime : new Date());

    // General purpose bit 11 (0x0800) => filename is UTF-8.
    const flags = /[^\x00-\x7f]/.test(name) ? 0x0800 : 0x0000;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(flags, 6); // general purpose bit flag
    local.writeUInt16LE(0, 8); // compression method: 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, nameBuf, data);

    central.push({
      nameBuf,
      flags,
      time,
      date,
      crc,
      size: data.length,
      offset,
    });

    offset += local.length + nameBuf.length + data.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); // central directory header signature
    h.writeUInt16LE(20, 4); // version made by
    h.writeUInt16LE(20, 6); // version needed to extract
    h.writeUInt16LE(c.flags, 8);
    h.writeUInt16LE(0, 10); // stored
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.size, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt16LE(0, 30); // extra length
    h.writeUInt16LE(0, 32); // comment length
    h.writeUInt16LE(0, 34); // disk number start
    h.writeUInt16LE(0, 36); // internal attributes
    h.writeUInt32LE(0, 38); // external attributes
    h.writeUInt32LE(c.offset, 42);
    chunks.push(h, c.nameBuf);
    offset += h.length + c.nameBuf.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(central.length, 8); // entries on this disk
  eocd.writeUInt16LE(central.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------------- *
 * Default ignore policy for buildZipFromDirectory
 * ------------------------------------------------------------------------- */

/**
 * Overleaf's own `fileIgnorePattern` (read from the live deployment's
 * `ol-ExposedSettings` meta tag) restated as explicit predicates, plus the
 * generated-LaTeX-artifact set. Note that user-supplied `*.pdf` files are
 * NOT ignored by default: the deployment itself does not ignore PDFs, and a
 * bibliography or figure PDF is legitimate project content.
 */
export const DEFAULT_IGNORE = Object.freeze({
  /** Directory names skipped at any depth. */
  dirs: Object.freeze([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '.texpadtmp',
    '__MACOSX',
    '.Rproj.user',
    '.DS_Store',
  ]),
  /** File extensions (lowercase, with dot) skipped at any depth. */
  exts: Object.freeze([
    '.aux', '.log', '.toc', '.out', '.pdfsync', '.synctex', '.synctex.gz',
    '.synctex(busy)', '.fdb_latexmk', '.fls', '.nlo', '.ind', '.glo', '.gls',
    '.glg', '.bbl', '.blg', '.dvi', '.doc', '.docx', '.gz', '.swp', '.swo',
    '.bak', '.tmp', '.orig', '.rej',
  ]),
  /** Exact file names skipped at any depth. */
  files: Object.freeze(['.DS_Store', 'Thumbs.db', 'latexmkrc.lock']),
});

/**
 * Compile a glob-ish pattern list into a predicate over a normalized relative
 * path (forward slashes, no leading slash).
 *
 * Supports: exact basename, `*.ext`, `dir/`, `prefix/`, a leading globstar
 * segment, and plain substring-free path prefixes. This is intentionally small
 * rather than a full gitignore implementation.
 *
 * @param {string[]} patterns
 * @returns {(relPath: string) => boolean} true when the path should be ignored
 */
export function makeIgnoreMatcher(patterns) {
  const matchers = [];
  for (const raw of patterns) {
    let p = String(raw).trim().replace(/\\/g, '/');
    if (!p) continue;
    if (p.startsWith('./')) p = p.slice(2);
    if (p.endsWith('/')) p = p.slice(0, -1);
    const isDir = String(raw).trim().endsWith('/');

    // **/name  ->  matches basename at any depth
    if (p.startsWith('**/')) {
      const base = p.slice(3);
      matchers.push((rel) => rel === base || rel.endsWith('/' + base));
      continue;
    }
    if (p.startsWith('*.')) {
      const ext = p.slice(1).toLowerCase(); // ".aux"
      matchers.push((rel) => rel.toLowerCase().endsWith(ext));
      continue;
    }
    if (p.includes('*') || p.includes('?')) {
      // Escape a single character so it is literal inside a RegExp. Implemented
      // as an explicit membership test rather than a regex character class:
      // a nested `[` / `]` inside a class is legal but easy to misread and was
      // the source of a genuine parse failure during development.
      const REGEX_SPECIALS = '\\^$.|?*+()[]{}';
      const escapeRe = (ch) => (REGEX_SPECIALS.includes(ch) ? '\\' + ch : ch);
      const source = p
        .split('')
        .map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : escapeRe(c)))
        .join('');
      const re = new RegExp('^' + source + '$');
      matchers.push((rel) => re.test(rel) || re.test(rel.split('/').pop() || ''));
      continue;
    }
    if (p.includes('/')) {
      matchers.push((rel) => rel === p || rel.startsWith(p + '/'));
      continue;
    }
    // Bare name: matches a directory segment or the basename.
    matchers.push((rel) => {
      if (rel === p) return true;
      const segs = rel.split('/');
      if (isDir && segs.includes(p)) return true;
      return segs.slice(0, -1).includes(p);
    });
  }
  return (relPath) => matchers.some((m) => m(relPath));
}

/**
 * Build the default ignore predicate from {@link DEFAULT_IGNORE}.
 * @returns {(relPath: string) => boolean}
 */
function defaultIgnorePredicate() {
  const dirs = new Set(DEFAULT_IGNORE.dirs.map((d) => d.toLowerCase()));
  const exts = DEFAULT_IGNORE.exts;
  const files = new Set(DEFAULT_IGNORE.files.map((f) => f.toLowerCase()));
  return (rel) => {
    const segs = rel.split('/');
    const base = segs[segs.length - 1];
    const baseLower = base.toLowerCase();
    if (files.has(baseLower)) return true;
    for (const dir of segs.slice(0, -1)) {
      if (dirs.has(dir.toLowerCase())) return true;
    }
    const lower = rel.toLowerCase();
    for (const ext of exts) {
      if (ext === '.synctex.gz') {
        if (lower.endsWith('.synctex.gz')) return true;
        continue;
      }
      if (lower.endsWith(ext)) return true;
    }
    return false;
  };
}

/* ------------------------------------------------------------------------- *
 * The client
 * ------------------------------------------------------------------------- */

/**
 * @typedef {object} ClientOptions
 * @property {string} [baseUrl]      Deployment root, default 'https://latex.cstcloud.cn'.
 * @property {Function} [fetchImpl]  Injected fetch (for tests).
 * @property {number} [timeoutMs]    Per-request timeout, default 120000.
 * @property {string} [userAgent]    User-Agent header.
 * @property {boolean} [debug]       When true, log request lines to stderr (never credentials/cookies).
 */

/**
 * @typedef {object} OutputFile
 * @property {string} path       e.g. 'output.pdf'
 * @property {string} [url]      Absolute URL, or same-origin path, per the deployment build.
 * @property {string} [type]     'pdf' | 'log' | 'zip' | ...
 * @property {string} [build]    Build id (newer deployments put it here instead of top level).
 */

/**
 * @typedef {object} CompileResult
 * @property {string} status                 'success' | 'failure' | 'error' | 'validation-problems' | 'timedout' | ...
 * @property {string|null} buildId           Derived from entry.build, a response field, or outputFiles[].url.
 * @property {string|null} clsiServerId
 * @property {OutputFile[]} outputFiles
 * @property {{url: string, path: string}|null} pdf   Downloadable descriptor for output.pdf.
 * @property {string|null} log               Text of the compile log when available.
 * @property {object} raw                    The parsed compile response, unmodified.
 * @property {object|null} validationProblems
 * @property {string|null} outputUrlPrefix
 * @property {string|null} pdfDownloadDomain
 */

export class OverleafClient {
  /**
   * @param {ClientOptions} [options]
   */
  constructor(options = {}) {
    if (typeof options.fetchImpl !== 'function' && typeof globalThis.fetch !== 'function') {
      throw new OverleafError(
        'No fetch implementation available: pass options.fetchImpl',
        { code: ErrorCode.INVALID_ARGUMENT }
      );
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl || 'https://latex.cstcloud.cn');
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.debug = Boolean(options.debug);

    /** @type {CookieJar} */
    this.cookies = new CookieJar();
    /** @type {string|null} */
    this._csrfToken = null;
    /** @type {{email?: string}|null} */
    this._identity = null;
    /** Secret strings scrubbed from error details. @type {Set<string>} */
    this._secrets = new Set();
  }

  /* ---------------------------------------------------------------- *
   * Debug / redaction
   * ---------------------------------------------------------------- */

  /** @param {string} msg */
  _debug(msg) {
    if (this.debug) {
      // Never include cookies, passwords or tokens here.
      process.stderr.write(`[overleaf-client] ${oneLine(msg)}\n`);
    }
  }

  /**
   * Scrub known secrets (password, cookie values, CSRF tokens) from text
   * destined for an error message.
   * @param {string} text
   * @returns {string}
   */
  _redact(text) {
    let out = String(text == null ? '' : text);
    for (const secret of this._secrets) {
      if (!secret || secret.length < 3) continue;
      out = out.split(secret).join('***');
    }
    // Catch generic credential-looking JSON fields as a belt-and-braces measure.
    out = out.replace(/("?password"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"');
    return out;
  }

  /** Register a secret for later redaction. @param {string} value */
  _rememberSecret(value) {
    if (typeof value === 'string' && value.length >= 3) this._secrets.add(value);
  }

  /* ---------------------------------------------------------------- *
   * Low-level HTTP
   * ---------------------------------------------------------------- */

  /**
   * @typedef {object} RequestOptions
   * @property {string} path                 Path or absolute URL.
   * @property {string} [method]             Defaults to GET.
   * @property {HeadersInit|object} [headers]
   * @property {BodyInit|string|Buffer} [body]
   * @property {boolean} [mutating]          Attach the CSRF token.
   * @property {boolean} [retried]           Internal retry marker.
   */

  /**
   * Perform one HTTP request with cookie jar integration, timeout and
   * credential-redacted error mapping.
   *
   * @param {RequestOptions} opts
   * @returns {Promise<Response>}
   */
  async _fetch(opts) {
    const method = (opts.method || 'GET').toUpperCase();
    const { url, sameOrigin } = resolveTarget(this.baseUrl, opts.path);

    /** @type {Record<string,string>} */
    const headers = {
      'user-agent': this.userAgent,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (opts.headers) {
      const h = opts.headers;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) {
        h.forEach((v, k) => {
          headers[String(k).toLowerCase()] = String(v);
        });
      } else {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
      }
    }

    // Only attach the session cookie to our own origin; never leak it to a
    // separate CLSI host.
    if (sameOrigin) {
      const cookie = this.cookies.header();
      if (cookie) headers.cookie = cookie;
    }

    if (opts.mutating && this._csrfToken) {
      headers['x-csrf-token'] = this._csrfToken;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      this._debug(`${method} ${url.pathname}${url.search}`);
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
      throw new OverleafError(
        isAbort ? `Request timed out after ${this.timeoutMs} ms` : 'Network request failed',
        {
          code: ErrorCode.NETWORK,
          detail: this._redact(oneLine(err && err.message ? err.message : String(err))),
          cause: err,
        }
      );
    } finally {
      clearTimeout(timer);
    }

    // Persist cookies from every response, successful or not.
    this.cookies.absorb(res.headers);

    // A redirect to /login (or /restricted, which bounces anonymous users to
    // /login) means the session is absent or expired.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (/\/login(\?|#|$)/.test(loc) || /\/restricted(\?|#|$)/.test(loc)) {
        throw new OverleafError('Not signed in (server redirected to /login)', {
          code: ErrorCode.AUTH_REQUIRED,
          status: res.status,
          detail: this._redact(`redirected to ${truncate(loc, 200)}`),
        });
      }
    }

    if (res.status >= 200 && res.status < 300) return res;

    // --- error mapping ------------------------------------------------
    const detail = this._redact(truncate(await safeText(res)));

    if (res.status === 401) {
      throw new OverleafError('Authentication failed', {
        code: ErrorCode.AUTH_INVALID,
        status: 401,
        detail,
      });
    }
    if (res.status === 403) {
      // On Overleaf, 403 is emitted both by the CSRF middleware (with a body
      // mentioning the token) and by `ensureUserCanReadProject` when a real
      // session lacks access to the project ("restricted"). A 403 on a
      // mutating request that never carried a token is unambiguously CSRF.
      const mentionsCsrf = /csrf|invalid token|invalid or missing|token/i.test(detail);
      const code =
        opts.mutating && (!this._csrfToken || mentionsCsrf)
          ? ErrorCode.AUTH_CSRF
          : ErrorCode.HTTP_ERROR;
      throw new OverleafError('Request forbidden (HTTP 403)', {
        code,
        status: 403,
        detail,
      });
    }
    if (res.status === 422) {
      throw new OverleafError('Server rejected the request (HTTP 422)', {
        code: ErrorCode.VALIDATION_FAILED,
        status: 422,
        detail: extractServerMessage(detail) || detail,
      });
    }
    if (res.status === 404) {
      throw new OverleafError('Endpoint not found (HTTP 404)', {
        code: ErrorCode.HTTP_ERROR,
        status: 404,
        detail,
      });
    }
    throw new OverleafError(`Unexpected HTTP ${res.status}`, {
      code: ErrorCode.HTTP_ERROR,
      status: res.status,
      detail,
    });
  }

  /**
   * Run a request factory with CSRF handling: guarantee a token exists, then
   * retry exactly once after refreshing the token if the server answers 403.
   * The factory receives the current token so it can also embed it in a form
   * body — important because a retry must rebuild that body, not replay a
   * stale `_csrf` value.
   *
   * @param {(csrf: string) => Promise<Response>} makeRequest
   * @returns {Promise<Response>}
   */
  async _withCsrfRetry(makeRequest) {
    let csrf = this._csrfToken;
    if (!csrf) csrf = await this.csrfToken({ force: true });
    try {
      return await makeRequest(csrf);
    } catch (err) {
      const retriable =
        err instanceof OverleafError &&
        (err.code === ErrorCode.AUTH_CSRF || err.status === 403);
      if (!retriable) throw err;
      this._debug('CSRF retry: refreshing token and retrying once');
      csrf = await this.csrfToken({ force: true });
      return makeRequest(csrf);
    }
  }

  /**
   * Issue a mutating request, ensuring a CSRF token is present and retrying
   * exactly once after refreshing the token if the first attempt is rejected.
   *
   * @param {RequestOptions} opts
   * @returns {Promise<Response>}
   */
  async _fetchMutating(opts) {
    return this._withCsrfRetry((csrf) =>
      this._fetch({
        ...opts,
        mutating: true,
        headers: {
          ...(opts.headers || {}),
          // Always use the freshly minted token, overriding any stale one.
          'x-csrf-token': csrf,
        },
      })
    );
  }

  /**
   * Parse a JSON response body, throwing a classified error on malformed JSON.
   * @param {Response} res
   * @param {string} what
   * @returns {Promise<any>}
   */
  async _json(res, what) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new OverleafError(`Expected JSON from ${what} but got something else`, {
        code: ErrorCode.HTTP_ERROR,
        status: res.status,
        detail: this._redact(truncate(text)),
        cause: err,
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * CSRF
   * ---------------------------------------------------------------- */

  /**
   * Fetch a CSRF token from `GET /dev/csrf`.
   *
   * The endpoint returns a bare token as `text/plain`. As a fallback for
   * variants that embed the token only in HTML, the `ol-csrfToken` meta tag or
   * a `_csrf` form field is accepted.
   *
   * @param {{force?: boolean}} [opts] `force` refetches even when cached.
   * @returns {Promise<string>}
   */
  async csrfToken(opts = {}) {
    if (!opts.force && this._csrfToken) return this._csrfToken;
    const res = await this._fetch({ path: '/dev/csrf' });
    const text = (await res.text()).trim();

    let token = '';
    // The overwhelming common case: a bare token as plain text.
    if (/^[A-Za-z0-9_\-+/=.:]{16,200}$/.test(text)) {
      token = text;
    } else {
      const meta = text.match(/name=["']ol-csrfToken["'][^>]*content=["']([^"']+)["']/i)
        || text.match(/content=["']([^"']+)["'][^>]*name=["']ol-csrfToken["']/i);
      const field = text.match(/name=["']_csrf["'][^>]*value=["']([^"']+)["']/i)
        || text.match(/value=["']([^"']+)["'][^>]*name=["']_csrf["']/i);
      token = (meta && meta[1]) || (field && field[1]) || '';
    }

    if (!token) {
      throw new OverleafError('Could not extract a CSRF token from /dev/csrf', {
        code: ErrorCode.AUTH_CSRF,
        status: res.status,
        detail: this._redact(truncate(text)),
      });
    }
    this._csrfToken = token;
    this._rememberSecret(token);
    return token;
  }

  /* ---------------------------------------------------------------- *
   * Auth
   * ---------------------------------------------------------------- */

  /**
   * Sign in with an email/password pair.
   *
   * `POST /login` is CSRF-protected: urlencoded `_csrf`, `email`, `password`.
   * Success is a 200 (often after an internal redirect to /project); failure is
   * 401 with `{"message":{"type":"error","key":"invalid-password-retry-or-reset"}}`.
   *
   * @param {{email: string, password: string}} creds
   * @returns {Promise<{ok: true}>}
   */
  async login({ email, password } = {}) {
    if (!email || !password) {
      throw new OverleafError('login requires both email and password', {
        code: ErrorCode.INVALID_ARGUMENT,
      });
    }
    this._rememberSecret(password);

    let res;
    try {
      res = await this._withCsrfRetry(async (csrf) => {
        const body = new URLSearchParams();
        body.set('_csrf', csrf);
        body.set('email', email);
        body.set('password', password);
        return this._fetch({
          path: '/login',
          method: 'POST',
          mutating: true,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json, text/html;q=0.9',
            // Send the token both as a header and a form field: builds differ
            // in which one the CSRF middleware inspects.
            'x-csrf-token': csrf,
            // Ask for JSON so a failure comes back as the documented error
            // object instead of an HTML login page.
            'x-requested-with': 'XMLHttpRequest',
          },
          body: body.toString(),
        });
      });
    } catch (err) {
      if (err instanceof OverleafError && err.status === 401) {
        const key = extractServerKey(err.detail);
        throw new OverleafError(
          key === 'invalid-password-retry-or-reset'
            ? 'Incorrect email or password'
            : 'Login rejected by the server',
          { code: ErrorCode.AUTH_INVALID, status: 401, detail: err.detail, cause: err }
        );
      }
      if (err instanceof OverleafError && err.status === 403) {
        throw new OverleafError('Login POST was blocked by CSRF protection', {
          code: ErrorCode.AUTH_CSRF,
          status: 403,
          detail: err.detail,
          cause: err,
        });
      }
      throw err;
    }

    // Sanity check: a 200 with a JSON `message.type === 'error'` is a failure.
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* an HTML redirect page is a success case here */
    }
    if (parsed && parsed.message && parsed.message.type === 'error') {
      throw new OverleafError(
        'Incorrect email or password',
        {
          code: ErrorCode.AUTH_INVALID,
          status: res.status,
          detail: this._redact(truncate(JSON.stringify(parsed))),
        }
      );
    }

    this._identity = { email };
    this._debug('login ok');
    return { ok: true };
  }

  /**
   * Clear the local session and best-effort tell the server.
   * @returns {Promise<{ok: boolean}>}
   */
  async logout() {
    try {
      await this.csrfToken();
      await this._fetchMutating({
        path: '/logout',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: '',
      });
    } catch (err) {
      // Logout failing (already expired, no session) is not an error for callers.
      this._debug(`logout request failed: ${err && err.code}`);
    } finally {
      this.cookies.clear();
      this._csrfToken = null;
      this._identity = null;
    }
    return { ok: true };
  }

  /**
   * Cheap authenticated probe: `GET /user/projects` must return 2xx.
   * @returns {Promise<boolean>}
   */
  async isLoggedIn() {
    try {
      await this._fetch({
        path: '/user/projects',
        headers: { accept: 'application/json' },
      });
      return true;
    } catch (err) {
      if (
        err instanceof OverleafError &&
        (err.code === ErrorCode.AUTH_REQUIRED ||
          err.code === ErrorCode.AUTH_INVALID ||
          err.status === 401)
      ) {
        return false;
      }
      throw err;
    }
  }

  /* ---------------------------------------------------------------- *
   * Session import / export
   *
   * The deployment sets `Settings.allowPublicAccess:false`, and accounts that
   * belong to a group or organization using SSO cannot set a local password at
   * all (the reset page answers "You can't reset your password because your
   * group or organization uses SSO"). For those accounts the only usable
   * credential is the signed session cookie itself, which the user copies from
   * a signed-in browser. Overleaf does not distinguish a cookie-bearing
   * server-side request from a browser one, so a stored `overleaf.sid` drives
   * every route this client needs.
   * ---------------------------------------------------------------- */

  /**
   * Parse a pasted cookie value into `name=value` pairs.
   *
   * Accepts a raw `Cookie:` header, a single `name=value`, or a full
   * `Set-Cookie` line, ignoring attributes (`Path`, `Domain`, `Expires`,
   * `HttpOnly`, `Secure`, `SameSite`). Unknown attribute words are dropped so a
   * pasted DevTools line does not produce bogus cookies.
   *
   * @param {string} raw
   * @returns {Array<{name: string, value: string}>}
   */
  static parseSessionCookie(raw) {
    const text = String(raw == null ? '' : raw)
      .replace(/^\s*cookie\s*:/i, '')
      .trim();
    if (!text) return [];

    const ATTRIBUTES = new Set([
      'path', 'domain', 'expires', 'max-age', 'httponly', 'secure',
      'samesite', 'priority', 'partitioned', 'version', 'comment',
    ]);

    // A bare value pasted straight from a DevTools cookie cell: no name and no
    // attributes. Overleaf's session value always looks like `s%3A<sid>.<hmac>`
    // (or `s:<sid>.<hmac>` once decoded), so require that shape before guessing.
    if (!text.includes('=') && !text.includes(';')) {
      if (/^s(%3A|:)[A-Za-z0-9%._\-+/=]+$/.test(text)) {
        return [{ name: 'overleaf.sid', value: text }];
      }
      return [];
    }

    const out = [];
    const seen = new Set();
    for (const part of text.split(';')) {
      const piece = part.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      const name = piece.slice(0, eq).trim();
      const value = piece.slice(eq + 1).trim();
      if (!name || !value) continue;
      if (ATTRIBUTES.has(name.toLowerCase())) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, value });
    }
    return out;
  }

  /**
   * Install a pasted session cookie and verify it against the deployment.
   *
   * @param {string} raw        Cookie header / `overleaf.sid=…` / pasted line.
   * @param {{verify?: boolean}} [opts]
   * @returns {Promise<{ok: true, cookieNames: string[], account: string|null}>}
   */
  async importSession(raw, opts = {}) {
    const pairs = OverleafClient.parseSessionCookie(raw);
    if (pairs.length === 0) {
      throw new OverleafError(
        'That does not look like a session cookie: expected `overleaf.sid=…`',
        { code: ErrorCode.INVALID_ARGUMENT }
      );
    }
    this.cookies.clear();
    this._csrfToken = null;
    this._identity = null;
    for (const { name, value } of pairs) {
      this.cookies.absorb(
        new Headers([['set-cookie', `${name}=${value}; Path=/`]])
      );
      this._rememberSecret(value);
    }

    const verify = opts.verify !== false;
    let account = null;
    if (verify) {
      // Throws AUTH_REQUIRED / AUTH_INVALID when the cookie is stale.
      account = await this.whoAmI();
      if (!account) {
        throw new OverleafError(
          'The pasted session is not valid any more: sign in again in the browser and copy a fresh cookie',
          { code: ErrorCode.AUTH_REQUIRED, status: 401 }
        );
      }
    }
    this._identity = account ? { email: account } : null;
    this._debug('session imported');
    return {
      ok: true,
      cookieNames: [...this.cookies.toMap().keys()],
      account,
    };
  }

  /**
   * Read the signed-in identity from a page that only a session can render.
   *
   * `GET /user/personal_info` is the cheapest JSON route, but a deployment may
   * gate it; the rendered project dashboard always embeds `ol-usersEmail`, so
   * that is the fallback. Returns `null` when no email can be recovered.
   *
   * @returns {Promise<string|null>}
   */
  async whoAmI() {
    try {
      const res = await this._fetch({
        path: '/user/personal_info',
        headers: { accept: 'application/json' },
      });
      const data = await this._json(res, 'GET /user/personal_info');
      const email = data && (data.email || (data.user && data.user.email));
      if (typeof email === 'string' && email) return email;
    } catch (err) {
      if (err instanceof OverleafError && err.code === ErrorCode.NETWORK) throw err;
      // Not gated for us: fall through to the dashboard scrape.
    }

    const res = await this._fetch({
      path: '/project',
      headers: { accept: 'text/html' },
    });
    const html = await res.text();
    const m =
      html.match(/name="ol-usersEmail"\s+content="([^"]*)"/i) ||
      html.match(/<meta[^>]+name="ol-usersEmail"[^>]+content="([^"]*)"/i);
    const email = m && m[1] ? m[1].trim() : '';
    return email || null;
  }

  /** @returns {string} the current `Cookie` header value (may be empty) */
  exportSession() {
    return this.cookies.header();
  }

  /* ---------------------------------------------------------------- *
   * Projects
   * ---------------------------------------------------------------- */

  /**
   * List projects visible to the session.
   * @returns {Promise<Array<{_id: string, name: string, accessLevel?: string}>>}
   */
  async listProjects() {
    const res = await this._fetch({
      path: '/user/projects',
      headers: { accept: 'application/json' },
    });
    const data = await this._json(res, 'GET /user/projects');
    if (!data || !Array.isArray(data.projects)) {
      throw new OverleafError('Unexpected shape from /user/projects', {
        code: ErrorCode.HTTP_ERROR,
        status: res.status,
        detail: this._redact(truncate(JSON.stringify(data))),
      });
    }
    return data.projects.map((p) => ({
      _id: String(p._id),
      name: String(p.name || ''),
      accessLevel: p.accessLevel,
    }));
  }

  /**
   * Create a project by uploading a ZIP archive.
   *
   * `POST /project/new/upload`, multipart/form-data with exactly one file part
   * named `qqfile`, a `name` field, and a `_csrf` field plus the header.
   *
   * @param {{name: string, zipBuffer: Buffer|Uint8Array|ArrayBuffer, fileName?: string}} args
   * @returns {Promise<string>} the new project id
   */
  async createProjectFromZip({ name, zipBuffer, fileName } = {}) {
    if (!name) {
      throw new OverleafError('createProjectFromZip requires a name', {
        code: ErrorCode.INVALID_ARGUMENT,
      });
    }
    const buf = toBuffer(zipBuffer);
    if (!buf || buf.length === 0) {
      throw new OverleafError('createProjectFromZip requires a non-empty zipBuffer', {
        code: ErrorCode.INVALID_ARGUMENT,
      });
    }
    if (buf.length > 500 * 1024 * 1024) {
      throw new OverleafError('zipBuffer exceeds the 500 MiB upload limit', {
        code: ErrorCode.INVALID_ARGUMENT,
        detail: `${buf.length} bytes`,
      });
    }

    const res = await this._withCsrfRetry(async (csrf) => {
      // The form must be rebuilt on each attempt: `_csrf` is embedded in the
      // body as well as sent as a header, and a stale token would fail.
      const form = new FormData();
      // The field name must be exactly `qqfile`; the server reads it first.
      const blob = new Blob([buf], { type: 'application/zip' });
      form.append('qqfile', blob, fileName || `${name}.zip`);
      form.append('name', name);
      form.append('_csrf', csrf);
      return this._fetch({
        path: '/project/new/upload',
        method: 'POST',
        mutating: true,
        headers: {
          // Let fetch set the multipart boundary itself.
          accept: 'application/json',
          'x-csrf-token': csrf,
        },
        body: form,
      });
    });

    const data = await this._json(res, 'POST /project/new/upload');
    const projectId = data && (data.project_id || data.projectId);
    if (!projectId) {
      throw new OverleafError('Upload succeeded but no project_id was returned', {
        code: ErrorCode.HTTP_ERROR,
        status: res.status,
        detail: this._redact(truncate(JSON.stringify(data))),
      });
    }
    return String(projectId);
  }

  /**
   * List the files/folders in a project.
   * @param {string} projectId
   * @returns {Promise<Array<{path: string, type: string}>>}
   */
  async projectEntities(projectId) {
    requireProjectId(projectId);
    const res = await this._fetch({
      path: `/project/${encodeURIComponent(projectId)}/entities`,
      headers: { accept: 'application/json' },
    });
    const data = await this._json(res, 'GET /project/:id/entities');
    if (!data || !Array.isArray(data.entities)) {
      throw new OverleafError('Unexpected shape from /project/:id/entities', {
        code: ErrorCode.HTTP_ERROR,
        status: res.status,
        detail: this._redact(truncate(JSON.stringify(data))),
      });
    }
    return data.entities.map((e) => ({
      path: String(e.path),
      type: String(e.type),
    }));
  }

  /**
   * Project metadata.
   * @param {string} projectId
   * @returns {Promise<any>}
   */
  async projectMetadata(projectId) {
    requireProjectId(projectId);
    const res = await this._fetch({
      path: `/project/${encodeURIComponent(projectId)}/metadata`,
      headers: { accept: 'application/json' },
    });
    return this._json(res, 'GET /project/:id/metadata');
  }

  /**
   * Permanently delete a project.
   * @param {string} projectId
   * @returns {Promise<{ok: boolean}>}
   */
  async deleteProject(projectId) {
    requireProjectId(projectId);
    await this._fetchMutating({
      path: `/Project/${encodeURIComponent(projectId)}`,
      method: 'DELETE',
      headers: { accept: 'application/json' },
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------- *
   * Compile
   * ---------------------------------------------------------------- */

  /**
   * Compile a project server-side.
   *
   * `POST /project/:id/compile` with a JSON body. The response is normalised
   * across CE versions:
   *   - new builds: `outputFiles[].url` is a **same-origin path**
   *     (`/project/<pid>/user/<uid>/build/<bid>/output/output.pdf`) and there is
   *     no top-level `buildId`;
   *   - old builds: `outputFiles[].url` may be an absolute CLSI URL, and
   *     `buildId` may be present.
   * `buildId` is derived defensively from `entry.build`, top-level `buildId`, or
   * a `/build/<id>/output/` segment inside any `outputFiles[].url`.
   *
   * @param {{projectId: string, rootResourcePath?: string, compiler?: string, draft?: boolean}} args
   * @returns {Promise<CompileResult>}
   */
  async compile({ projectId, rootResourcePath = 'main.tex', compiler = 'xelatex', draft = false } = {}) {
    requireProjectId(projectId);
    const payload = { compiler, draft };
    if (rootResourcePath) payload.rootResourcePath = rootResourcePath;

    const res = await this._fetchMutating({
      path: `/project/${encodeURIComponent(projectId)}/compile`,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await this._json(res, 'POST /project/:id/compile');
    const outputFiles = Array.isArray(data.outputFiles) ? data.outputFiles : [];

    // Derive a build id from every place CE versions have put it.
    let buildId = data.buildId || data.build_id || null;
    if (!buildId) {
      for (const f of outputFiles) {
        if (f && f.build) {
          buildId = String(f.build);
          break;
        }
      }
    }
    if (!buildId) {
      for (const f of outputFiles) {
        const m = typeof f?.url === 'string' && f.url.match(/\/build\/([^/]+)\/output\//);
        if (m) {
          buildId = m[1];
          break;
        }
      }
    }
    if (!buildId && data.outputFilesArchive && typeof data.outputFilesArchive.url === 'string') {
      const m = data.outputFilesArchive.url.match(/\/build\/([^/]+)\/output\//);
      if (m) buildId = m[1];
    }

    const clsiServerId = data.clsiServerId || null;

    // Locate the PDF entry. `path` is authoritative; some builds only expose it
    // via `type: 'pdf'` or a `.pdf` suffix.
    const pdfEntry =
      outputFiles.find((f) => f && f.path === 'output.pdf') ||
      outputFiles.find((f) => f && f.type === 'pdf') ||
      outputFiles.find((f) => f && /\.pdf$/i.test(String(f.path || ''))) ||
      null;

    let pdf = null;
    if (pdfEntry && pdfEntry.url) {
      try {
        const { url, sameOrigin } = resolveTarget(this.baseUrl, pdfEntry.url);
        pdf = { url: sameOrigin ? url.pathname + url.search : url.toString(), path: String(pdfEntry.path || 'output.pdf') };
      } catch {
        pdf = null;
      }
    }

    const status = String(data.status || 'unknown');
    const logEntry =
      outputFiles.find((f) => f && f.path === 'output.log') ||
      outputFiles.find((f) => f && f.type === 'log') ||
      null;

    /** @type {CompileResult} */
    const result = {
      status,
      buildId: buildId ? String(buildId) : null,
      clsiServerId: clsiServerId ? String(clsiServerId) : null,
      outputFiles,
      pdf,
      log: null,
      raw: data,
      validationProblems: data.validationProblems || null,
      outputUrlPrefix: data.outputUrlPrefix || null,
      pdfDownloadDomain: data.pdfDownloadDomain || null,
    };

    if (status !== 'success') {
      // Try to surface the compiler log, which is where the useful message is.
      let logText = null;
      if (logEntry) {
        try {
          const buf = await this.downloadOutputFile({
            projectId,
            buildId: result.buildId,
            clsiServerId: result.clsiServerId,
            file: 'output.log',
            entry: logEntry,
          });
          logText = buf.toString('utf8');
        } catch {
          /* log unavailable; the status is still accurate */
        }
      }
      result.log = logText;
      const err = new OverleafError(`Compile did not succeed: ${status}`, {
        code: ErrorCode.COMPILE_FAILED,
        status: res.status,
        detail: this._redact(
          truncate(
            (data.validationProblems ? `validationProblems=${JSON.stringify(data.validationProblems)}; ` : '') +
              (logText ? lastLines(logText, 40) : JSON.stringify(data).slice(0, 800))
          )
        ),
      });
      // Attach the normalised result so callers can inspect it.
      err.result = result;
      throw err;
    }

    // Fetch the log opportunistically (never fatal).
    if (logEntry) {
      try {
        const buf = await this.downloadOutputFile({
          projectId,
          buildId: result.buildId,
          clsiServerId: result.clsiServerId,
          file: 'output.log',
          entry: logEntry,
        });
        result.log = buf.toString('utf8');
      } catch {
        /* non-fatal */
      }
    }

    return result;
  }

  /**
   * Resolve a descriptor for one build artifact.
   *
   * Prefers the entry's own `url` from the compile response (a same-origin path
   * on current deployments, an absolute URL on old ones), and falls back to the
   * documented build route when only a build id is available.
   *
   * @param {object} args
   * @param {string} args.projectId
   * @param {string|null} [args.buildId]
   * @param {string|null} [args.clsiServerId]
   * @param {string} [args.file]        e.g. 'output.pdf'
   * @param {OutputFile} [args.entry]   the compiled outputFiles entry, if known
   * @returns {string} path relative to baseUrl, or absolute URL
   */
  _outputPath({ projectId, buildId, clsiServerId, file, entry }) {
    if (entry && entry.url) {
      const { url, sameOrigin } = resolveTarget(this.baseUrl, entry.url);
      if (sameOrigin) {
        const q = url.searchParams;
        if (clsiServerId && !q.get('clsiserverid')) q.set('clsiserverid', clsiServerId);
        const qs = q.toString();
        return url.pathname + (qs ? `?${qs}` : '');
      }
      return url.toString();
    }
    if (!buildId) {
      throw new OverleafError(
        `Cannot download ${file}: no outputFiles entry and no buildId available`,
        { code: ErrorCode.INVALID_ARGUMENT }
      );
    }
    const q = clsiServerId ? `?clsiserverid=${encodeURIComponent(clsiServerId)}` : '';
    return `/project/${encodeURIComponent(projectId)}/build/${encodeURIComponent(buildId)}/output/${encodeURIComponent(file)}${q}`;
  }

  /**
   * Download an arbitrary build artifact.
   *
   * @param {object} args
   * @param {string} args.projectId
   * @param {string|null} [args.buildId]
   * @param {string|null} [args.clsiServerId]
   * @param {string} args.file       e.g. 'output.pdf', 'output.log', 'output.blg'
   * @param {OutputFile} [args.entry] matching outputFiles entry from compile()
   * @returns {Promise<Buffer>}
   */
  async downloadOutputFile({ projectId, buildId, clsiServerId, file, entry } = {}) {
    requireProjectId(projectId);
    if (!file) {
      throw new OverleafError('downloadOutputFile requires a file name', {
        code: ErrorCode.INVALID_ARGUMENT,
      });
    }
    // When no explicit entry was passed, look one up only if the caller gave a
    // build id (otherwise the build route alone is enough).
    const path = this._outputPath({
      projectId,
      buildId: buildId || null,
      clsiServerId: clsiServerId || null,
      file,
      entry,
    });
    const res = await this._fetch({ path, headers: { accept: '*/*' } });
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Download the compiled PDF for a build and verify it really is a PDF.
   *
   * @param {object} args
   * @param {string} args.projectId
   * @param {string|null} [args.buildId]
   * @param {string|null} [args.clsiServerId]
   * @param {OutputFile} [args.entry] outputFiles entry from compile()
   * @returns {Promise<Buffer>}
   */
  async downloadPdf({ projectId, buildId, clsiServerId, entry } = {}) {
    requireProjectId(projectId);
    const buf = await this.downloadOutputFile({
      projectId,
      buildId: buildId || null,
      clsiServerId: clsiServerId || null,
      file: 'output.pdf',
      entry,
    });
    if (!isPdf(buf)) {
      throw new OverleafError('Downloaded output.pdf is not a PDF', {
        code: ErrorCode.BAD_ARTIFACT,
        detail: this._redact(
          `first bytes: ${JSON.stringify(buf.subarray(0, 16).toString('latin1'))}`
        ),
      });
    }
    return buf;
  }

  /**
   * Download the whole `output.zip` of a build.
   *
   * @param {object} args
   * @returns {Promise<Buffer>}
   */
  async downloadOutputZip({ projectId, buildId, clsiServerId, entry } = {}) {
    requireProjectId(projectId);
    const path = this._outputPath({
      projectId,
      buildId: buildId || null,
      clsiServerId: clsiServerId || null,
      file: 'output.zip',
      entry,
    });
    const res = await this._fetch({ path, headers: { accept: '*/*' } });
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Convenience: compile one project and return the PDF bytes plus the log.
   * This is the one-call path most callers want.
   *
   * @param {object} args  see {@link compile}
   * @returns {Promise<{pdf: Buffer, log: string|null, result: CompileResult}>}
   */
  async compileToPdf({ projectId, rootResourcePath = 'main.tex', compiler = 'xelatex', draft = false } = {}) {
    const result = await this.compile({ projectId, rootResourcePath, compiler, draft });
    const entry = pickEntry(result.outputFiles, 'output.pdf');
    const pdf = await this.downloadPdf({
      projectId,
      buildId: result.buildId,
      clsiServerId: result.clsiServerId,
      entry,
    });
    return { pdf, log: result.log, result };
  }

  /* ---------------------------------------------------------------- *
   * Local folder -> ZIP
   * ---------------------------------------------------------------- */

  /**
   * Walk a local directory and pack it into a stored (uncompressed) ZIP whose
   * entries are relative to `dirPath` (the folder's own name is NOT a prefix).
   *
   * Defaults exclude Overleaf's own ignored paths plus generated LaTeX
   * artifacts; user-supplied PDFs are kept (pass a custom `ignore` to drop
   * them). Files larger than `maxFileBytes` (20 MiB) are skipped with a warning.
   *
   * @param {string} dirPath
   * @param {object} [opts]
   * @param {string[]} [opts.ignore]      Extra glob-ish patterns to ignore.
   * @param {boolean} [opts.ignoreDefaults=true] Set false to disable built-ins.
   * @param {number} [opts.maxFileBytes]  Per-file size ceiling, default 20 MiB.
   * @param {boolean} [opts.followSymlinks] Default false (symlinks are skipped).
   * @param {(msg: string) => void} [opts.warn] Warning sink; defaults to console.warn.
   * @returns {Promise<{buffer: Buffer, entries: string[], skipped: string[], warnings: string[]}>}
   */
  async buildZipFromDirectory(dirPath, opts = {}) {
    if (!dirPath) {
      throw new OverleafError('buildZipFromDirectory requires dirPath', {
        code: ErrorCode.INVALID_ARGUMENT,
      });
    }
    const root = nodePath.resolve(dirPath);
    const maxFileBytes = Number.isFinite(opts.maxFileBytes) ? opts.maxFileBytes : 20 * 1024 * 1024;
    const warnSink = typeof opts.warn === 'function' ? opts.warn : (m) => console.warn(m);
    const warnings = [];
    const warn = (msg) => {
      warnings.push(msg);
      try {
        warnSink(msg);
      } catch {
        /* a throwing warning sink must not break the build */
      }
    };

    let stat;
    try {
      stat = await fsp.stat(root);
    } catch (err) {
      throw new OverleafError(`Cannot read directory: ${root}`, {
        code: ErrorCode.INVALID_ARGUMENT,
        detail: this._redact(String(err && err.message)),
        cause: err,
      });
    }
    if (!stat.isDirectory()) {
      throw new OverleafError(`Not a directory: ${root}`, {
        code: ErrorCode.INVALID_ARGUMENT,
      });
    }

    const useDefaults = opts.ignoreDefaults !== false;
    const custom = Array.isArray(opts.ignore) ? opts.ignore : [];
    const customMatch = makeIgnoreMatcher(custom);
    const defaultMatch = useDefaults ? defaultIgnorePredicate() : () => false;

    /** @type {Array<{name: string, data: Buffer, mtime: Date}>} */
    const entries = [];
    /** @type {string[]} */
    const skipped = [];

    /** @param {string} abs  @param {string} rel */
    const walk = async (abs, rel) => {
      /** @type {import('node:fs').Dirent[]} */
      let dirents;
      try {
        dirents = await fsp.readdir(abs, { withFileTypes: true });
      } catch (err) {
        warn(`skip unreadable directory ${rel || '.'}: ${err && err.message}`);
        skipped.push(rel || '.');
        return;
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const d of dirents) {
        const childAbs = nodePath.join(abs, d.name);
        const childRel = rel ? `${rel}/${d.name}` : d.name;

        if (d.isSymbolicLink()) {
          if (!opts.followSymlinks) {
            skipped.push(childRel);
            continue;
          }
        } else if (d.isDirectory()) {
          if (defaultMatch(`${childRel}/`) || defaultMatch(childRel) || customMatch(childRel)) {
            skipped.push(childRel + '/');
            continue;
          }
          await walk(childAbs, childRel);
          continue;
        } else if (!d.isFile()) {
          skipped.push(childRel);
          continue;
        }

        if (defaultMatch(childRel) || customMatch(childRel)) {
          skipped.push(childRel);
          continue;
        }

        /** @type {import('node:fs').Stats} */
        let fstat;
        try {
          fstat = await fsp.stat(childAbs);
        } catch (err) {
          warn(`skip unreadable file ${childRel}: ${err && err.message}`);
          skipped.push(childRel);
          continue;
        }
        if (fstat.size > maxFileBytes) {
          warn(
            `skip ${childRel}: ${formatBytes(fstat.size)} exceeds the ` +
              `${formatBytes(maxFileBytes)} per-file limit`
          );
          skipped.push(childRel);
          continue;
        }
        let data;
        try {
          data = await fsp.readFile(childAbs);
        } catch (err) {
          warn(`skip unreadable file ${childRel}: ${err && err.message}`);
          skipped.push(childRel);
          continue;
        }
        entries.push({ name: childRel, data, mtime: fstat.mtime });
      }
    };

    await walk(root, '');

    if (entries.length === 0) {
      warn('no files matched; the archive will be empty');
    }
    if (entries.length > 2000) {
      throw new OverleafError(
        `Project would contain ${entries.length} files; the deployment limit is 2000`,
        { code: ErrorCode.INVALID_ARGUMENT }
      );
    }

    const buffer = createStoredZip(entries);
    return {
      buffer,
      entries: entries.map((e) => e.name),
      skipped,
      warnings,
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Export-level helpers
 * ------------------------------------------------------------------------- */

/**
 * Construct a client. See {@link ClientOptions}.
 * @param {ClientOptions} [options]
 * @returns {OverleafClient}
 */
export function createOverleafClient(options = {}) {
  return new OverleafClient(options);
}

/** @param {any} v @returns {Buffer|null} */
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

/** @param {Buffer} buf @returns {boolean} */
function isPdf(buf) {
  // Allow a little leading whitespace/JUNK before %PDF-, which some tools add.
  const head = buf.subarray(0, 1024).toString('latin1');
  return head.includes('%PDF-');
}

/** @param {string} projectId */
function requireProjectId(projectId) {
  if (!projectId || typeof projectId !== 'string') {
    throw new OverleafError('A projectId is required', { code: ErrorCode.INVALID_ARGUMENT });
  }
}

/**
 * Read a response body as text without throwing (used on error paths).
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Pull `message.key` or `message.message` out of a JSON error body.
 * @param {string} detail
 * @returns {string|null}
 */
function extractServerKey(detail) {
  const m = String(detail).match(/"key"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Pull the human-readable message out of a JSON error body.
 * @param {string} detail
 * @returns {string|null}
 */
function extractServerMessage(detail) {
  const s = String(detail);
  try {
    const o = JSON.parse(s);
    if (typeof o === 'string') return o;
    if (o && typeof o.message === 'string') return o.message;
    if (o && o.message && typeof o.message === 'object') {
      return o.message.key || o.message.message || JSON.stringify(o.message);
    }
    if (o && typeof o.error === 'string') return o.error;
  } catch {
    /* not JSON */
  }
  return null;
}

/** @param {number} n @returns {string} */
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Last n non-empty lines of a log, for an error detail.
 * @param {string} text
 * @param {number} [n]
 * @returns {string}
 */
function lastLines(text, n = 40) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).join(' | ');
}

/**
 * Find an outputFiles entry by path, with tolerant fallbacks.
 * @param {OutputFile[]} outputFiles
 * @param {string} filePath
 * @returns {OutputFile|undefined}
 */
function pickEntry(outputFiles, filePath) {
  if (!Array.isArray(outputFiles)) return undefined;
  const exact = outputFiles.find((f) => f && f.path === filePath);
  if (exact) return exact;
  const ext = nodePath.extname(filePath).toLowerCase();
  const byType =
    ext === '.pdf'
      ? outputFiles.find((f) => f && f.type === 'pdf')
      : ext === '.log'
        ? outputFiles.find((f) => f && f.type === 'log')
        : ext === '.zip'
          ? outputFiles.find((f) => f && f.type === 'zip')
          : undefined;
  if (byType) return byType;
  return outputFiles.find((f) => f && String(f.path || '').toLowerCase().endsWith(ext));
}

/**
 * Structural helper: the default export exposes the constructor factory so both
 * `import { createOverleafClient }` and `import client from '...'` work.
 */
export default createOverleafClient;

/** Re-export the class under a conventional name too. */
export { OverleafClient as Client };
