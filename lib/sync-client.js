/**
 * Overleaf project synchronisation and compile diagnostics.
 *
 * Measured constraints on this deployment (see the probe scripts):
 *
 * - Creating a project from a zip works, reading entities works, deleting a
 *   project works.
 * - In-place file updates do NOT: `POST /Project/:id/upload` answers 422
 *   `folder_not_found` because it needs a root folder id that no API exposes,
 *   and the per-file delete routes are absent on this build.
 * - The git bridge is advertised but has no public base URL configured.
 *
 * So "sync" is implemented as **replace-by-recreate**: build a new project from
 * the same name and a fresh id, then delete the previous one. The dashboard keeps
 * exactly one project with that name, and nothing is ever destroyed before its
 * replacement exists.
 *
 * Compile results are asynchronous: `POST /project/:id/compile` answers
 * `102 Processing` and the real payload follows on the same connection, so it is
 * read at socket level rather than through a normal HTTP client.
 *
 * @module sync-client
 */

import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { Buffer } from 'node:buffer'
import Path from 'node:path'

import { createOverleafClient, OverleafError, ErrorCode } from './overleaf-client.js'

/** Upstream compile can legitimately take minutes. */
const COMPILE_TIMEOUT_MS = 5 * 60_000

/** Read a compile response at socket level until the JSON payload arrives. */
const RAW_COMPILE_TIMEOUT_MS = 5 * 60_000

/**
 * Errors worth surfacing from a LaTeX log, in reading order.
 *
 * Order matters: the specific patterns must precede the generic `!` one, or a
 * missing file would be classified as a plain error and lose the distinction the
 * fixer needs.
 */
const LATEX_ERROR_PATTERNS = [
  { re: /^File `([^']+)' not found/i, kind: 'missing-file' },
  { re: /^! LaTeX Error:\s*File `([^']+)' not found/i, kind: 'missing-file' },
  { re: /^! Package ([^\s]+) Error:\s*(.+)$/i, kind: 'error' },
  { re: /^! LaTeX Error:\s*(.+)$/i, kind: 'error' },
  { re: /^!\s*(.+)$/, kind: 'error' },
  { re: /^LaTeX Warning:\s*(.+)$/i, kind: 'warning' },
  { re: /^Package ([^\s]+) Warning:\s*(.+)$/i, kind: 'warning' },
  { re: /^Overfull \\hbox.*$/i, kind: 'badness' },
  { re: /^Underfull \\hbox.*$/i, kind: 'badness' },
  { re: /^Missing character:\s*(.+)$/i, kind: 'missing-glyph' },
  { re: /^There were undefined references/i, kind: 'warning' },
]

/**
 * Pull the useful diagnostics out of a LaTeX log.
 *
 * Returns the error/warning lines plus a little context, because a bare `!`
 * line rarely says which file or line is at fault.
 *
 * @param {string} log
 * @returns {{entries: Array<{kind: string, line: number, text: string, context: string}>, summary: object}}
 */
export function parseLatexLog(log) {
  const lines = String(log == null ? '' : log).split(/\r?\n/)
  const entries = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const text = raw.replace(/\s+$/, '')
    if (!text) continue
    for (const pattern of LATEX_ERROR_PATTERNS) {
      const m = pattern.re.exec(text)
      if (!m) continue
      // Keep the next line as context: LaTeX usually explains on the line after.
      const next = (lines[i + 1] || '').trim()
      const next2 = (lines[i + 2] || '').trim()
      entries.push({
        kind: pattern.kind,
        line: i + 1,
        text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
        context: [next, next2].filter(Boolean).join(' ').slice(0, 300),
      })
      break
    }
    if (entries.length >= 80) break
  }
  const summary = {
    errors: entries.filter((e) => e.kind === 'error' || e.kind === 'missing-file').length,
    warnings: entries.filter((e) => e.kind === 'warning').length,
    badness: entries.filter((e) => e.kind === 'badness').length,
    missingGlyphs: entries.filter((e) => e.kind === 'missing-glyph').length,
  }
  return { entries, summary }
}

/**
 * Reduce a compile log to the lines a human (or a model) needs to fix it.
 *
 * @param {string} log
 * @param {number} [limit]
 * @returns {string}
 */
export function logDigest(log, limit = 4000) {
  const { entries } = parseLatexLog(log)
  if (entries.length === 0) {
    // Nothing matched: fall back to the tail, where fatal errors usually sit.
    const lines = String(log || '').split(/\r?\n/).filter(Boolean)
    return lines.slice(-30).join('\n').slice(0, limit)
  }
  const out = []
  for (const e of entries) {
    out.push(`${e.kind.toUpperCase()}: ${e.text}`)
    if (e.context) out.push(`    ↳ ${e.context}`)
    if (out.join('\n').length > limit) break
  }
  return out.join('\n').slice(0, limit)
}

/**
 * A project sync session bound to one deployment and one stored cookie.
 */
export class ProjectSync {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl]
   * @param {() => Promise<string|null>} options.getCookie
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'https://latex.cstcloud.cn').replace(/\/+$/, '')
    this.getCookie = options.getCookie
    this._client = null
  }

  /** A protocol client sharing the stored session. */
  async client() {
    if (this._client) return this._client
    const cookie = await this.getCookie()
    if (!cookie) {
      throw new OverleafError('no stored session', { code: ErrorCode.AUTH_REQUIRED })
    }
    const client = createOverleafClient({ baseUrl: this.baseUrl, timeoutMs: 180_000 })
    await client.importSession(cookie, { verify: false })
    this._client = client
    return this._client
  }

  /** Drop the cached client so the next call picks up a rotated session. */
  reset() {
    this._client = null
  }

  /**
   * List the user's projects.
   * @returns {Promise<Array<{_id: string, name: string}>>}
   */
  async listProjects() {
    const client = await this.client()
    return client.listProjects()
  }

  /**
   * Find a project by exact name; the most recently named match wins.
   * @param {string} name
   * @returns {Promise<{_id: string, name: string}|null>}
   */
  async findByName(name) {
    const projects = await this.listProjects()
    const matches = projects.filter((p) => p.name === name)
    return matches.length ? matches[matches.length - 1] : null
  }

  /**
   * Package a directory and create a new project from it.
   * @param {{dir: string, name: string}} args
   * @returns {Promise<{projectId: string, fileCount: number, bytes: number}>}
   */
  async createFromDirectory({ dir, name }) {
    const client = await this.client()
    const zip = await client.buildZipFromDirectory(dir, { warn: () => {} })
    const projectId = await client.createProjectFromZip({ name, zipBuffer: zip.buffer })
    return { projectId, fileCount: zip.entries.length, bytes: zip.buffer.length }
  }

  /**
   * Delete a project, ignoring "already gone".
   * @param {string} projectId
   */
  async deleteProject(projectId) {
    const client = await this.client()
    try {
      await client.deleteProject(projectId)
      return true
    } catch (err) {
      if (err instanceof OverleafError && (err.status === 404 || err.code === ErrorCode.HTTP_ERROR)) {
        return false
      }
      throw err
    }
  }

  /**
   * Set the project's compiler.
   *
   * The `compiler` field in a compile request body is only advisory on this
   * deployment: a project created from a zip inherits the site default
   * (pdfLaTeX), and asking the compile route for xelatex without changing the
   * project made it keep running pdfTeX — which surfaced as `!pdfTeX error`
   * for every CJK fontset. Persisting the setting first is what actually
   * switches engines.
   *
   * @param {string} projectId
   * @param {string} compiler
   * @returns {Promise<boolean>}
   */
  async setCompiler(projectId, compiler) {
    const cookie = await this.getCookie()
    if (!cookie) {
      throw new OverleafError('no stored session', { code: ErrorCode.AUTH_REQUIRED })
    }
    const token = await this._csrf(cookie)
    const body = Buffer.from(JSON.stringify({ compiler }), 'utf8')
    const res = await this._request({
      method: 'POST',
      path: `/project/${encodeURIComponent(projectId)}/settings`,
      cookie,
      token,
      payload: body,
      contentType: 'application/json',
    })
    return res.status === 204 || res.status === 200
  }

  /**
   * Compile a project and return its status, log and PDF descriptor.
   *
   * The compile route answers `102 Processing` and then streams the real result
   * on the SAME connection, which a normal HTTP client reports as an empty 102.
   * Reading at socket level is what makes the diagnostics reachable.
   *
   * @param {string} projectId
   * @param {{rootFile?: string, compiler?: string}} [opts]
   * @returns {Promise<{status: string, log: string|null, pdf: {path: string, url: string}|null, raw: object|null}>}
   */
  async compile(projectId, opts = {}) {
    const cookie = await this.getCookie()
    if (!cookie) {
      throw new OverleafError('no stored session', { code: ErrorCode.AUTH_REQUIRED })
    }
    const token = await this._csrf(cookie)
    const url = new URL(`/project/${encodeURIComponent(projectId)}/compile`, this.baseUrl)
    const payload = Buffer.from(
      JSON.stringify({
        rootResourcePath: opts.rootFile || 'main.tex',
        compiler: opts.compiler || 'xelatex',
      }),
      'utf8'
    )

    const raw = await this._rawCompileRequest({ url, cookie, token, payload })
    const json = extractCompileJson(raw)
    if (!json) {
      throw new OverleafError('compile returned no parseable payload', {
        code: ErrorCode.HTTP_ERROR,
        detail: String(raw && raw.bodyHead ? raw.bodyHead : '').slice(0, 300),
      })
    }

    const files = Array.isArray(json.outputFiles) ? json.outputFiles : []
    const logEntry = files.find((f) => f && f.path === 'output.log') || null
    const pdfEntry = files.find((f) => f && f.path === 'output.pdf') || null

    let log = null
    if (logEntry && logEntry.url) {
      try {
        const path = normaliseOutputUrl(logEntry.url)
        log = await this._getText(path, cookie)
      } catch {
        log = null
      }
    }

    return {
      status: String(json.status || 'unknown'),
      log,
      pdf: pdfEntry ? { path: pdfEntry.path, url: normaliseOutputUrl(pdfEntry.url) } : null,
      raw: json,
    }
  }

  /**
   * Fetch the current CSRF token for mutating requests.
   * @param {string} cookie
   * @returns {Promise<string>}
   */
  async _csrf(cookie) {
    const res = await this._getRaw('/dev/csrf', cookie)
    return String(res.body || '').trim()
  }

  /**
   * Issue one plain GET with the stored cookie.
   * @param {string} path
   * @param {string} cookie
   * @returns {Promise<{status: number, body: string}>}
   */
  _getText(path, cookie) {
    return this._getRaw(path, cookie).then((r) => r.body)
  }

  /**
   * One GET, returning status and body.
   * @param {string} path
   * @param {string} cookie
   * @returns {Promise<{status: number, body: string}>}
   */
  _getRaw(path, cookie) {
    const target = new URL(path, this.baseUrl)
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: 'GET',
          headers: {
            cookie,
            'user-agent': 'Mozilla/5.0 (DSH Overleaf Workbench)',
            accept: '*/*',
          },
          timeout: 120_000,
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') })
          )
        }
      )
      req.on('timeout', () => req.destroy(new Error('request timeout')))
      req.on('error', reject)
      req.end()
    })
  }

  /**
   * One mutating request with the stored cookie and CSRF token.
   *
   * @param {{method: string, path: string, cookie: string, token: string, payload?: Buffer, contentType?: string}} args
   * @returns {Promise<{status: number, body: string}>}
   */
  _request({ method, path, cookie, token, payload, contentType }) {
    const target = new URL(path, this.baseUrl)
    return new Promise((resolve, reject) => {
      const headers = {
        cookie,
        'user-agent': 'Mozilla/5.0 (DSH Overleaf Workbench)',
        accept: '*/*',
        'x-csrf-token': token,
      }
      if (payload) {
        headers['content-type'] = contentType || 'application/json'
        headers['content-length'] = String(payload.length)
      }
      const req = httpsRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method,
          headers,
          timeout: 120_000,
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') })
          )
        }
      )
      req.on('timeout', () => req.destroy(new Error('request timeout')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  /**
   * Send the compile POST at socket level and read until the payload arrives.
   *
   * @param {{url: URL, cookie: string, token: string, payload: Buffer}} args
   * @returns {Promise<{statusLine: string, bodyHead: string, payload: string}>}
   */
  _rawCompileRequest({ url, cookie, token, payload }) {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: url.hostname, port: 443, servername: url.hostname })
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        fn(value)
      }

      socket.setTimeout(RAW_COMPILE_TIMEOUT_MS)
      socket.on('timeout', () => finish(reject, new Error('compile timed out')))
      socket.on('error', (err) => finish(reject, err))

      socket.on('connect', () => {
        const head =
          `POST ${url.pathname}${url.search} HTTP/1.1\r\n` +
          `Host: ${url.hostname}\r\n` +
          `Cookie: ${cookie}\r\n` +
          'User-Agent: Mozilla/5.0 (DSH Overleaf Workbench)\r\n' +
          'Content-Type: application/json\r\n' +
          `X-CSRF-Token: ${token}\r\n` +
          'Accept: application/json\r\n' +
          `Content-Length: ${payload.length}\r\n` +
          'Connection: close\r\n\r\n'
        socket.write(head)
        socket.write(payload)
      })

      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        // Done once a JSON object with a status field has arrived.
        const text = buffer.toString('utf8')
        if (text.includes('"outputFiles"') || /"status"\s*:\s*"[a-z-]+"/.test(text)) {
          finish(resolve, splitCompileResponse(text))
        }
        if (buffer.length > 8 * 1024 * 1024) {
          finish(resolve, splitCompileResponse(buffer.toString('utf8')))
        }
      })
      socket.on('close', () => {
        if (!settled) finish(resolve, splitCompileResponse(buffer.toString('utf8')))
      })
    })
  }
}

/**
 * Split the raw compile response into status line, head and payload.
 *
 * The deployment first emits `HTTP/1.1 102 Processing` and then writes a whole
 * second HTTP response onto the same connection.
 *
 * @param {string} text
 * @returns {{statusLine: string, bodyHead: string, payload: string}}
 */
export function splitCompileResponse(text) {
  const statusLine = (text.split('\r\n')[0] || '').trim()
  // The payload begins at the LAST header/body boundary: the final response.
  const markers = []
  const re = /\r\n\r\n/g
  let m
  while ((m = re.exec(text)) !== null) markers.push(m.index)
  if (markers.length === 0) {
    return { statusLine, bodyHead: text.slice(0, 200), payload: text }
  }
  const last = markers[markers.length - 1]
  const bodyHead = text.slice(0, last).slice(0, 400)
  const payload = text.slice(last + 4)
  return { statusLine, bodyHead, payload }
}

/**
 * Locate the compile JSON in a payload that may still carry HTTP framing.
 * @param {{payload: string, bodyHead: string}} raw
 * @returns {object|null}
 */
export function extractCompileJson(raw) {
  const candidates = []
  if (raw && typeof raw.payload === 'string') candidates.push(raw.payload)
  if (raw && typeof raw.bodyHead === 'string') candidates.push(raw.bodyHead)
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    if (start === -1) continue
    // Walk to the matching brace so trailing framing is ignored.
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

/**
 * Turn an output-file URL into a path usable against this deployment.
 *
 * Compile responses carry same-origin paths (`/project/…/output/output.log`) but
 * older builds emitted absolute URLs to a content host.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseOutputUrl(value) {
  const raw = String(value == null ? '' : value)
  if (!raw) return ''
  if (raw.startsWith('/')) return raw
  try {
    const parsed = new URL(raw)
    return parsed.pathname + parsed.search
  } catch {
    return raw
  }
}

/**
 * Name to give the remote project for a local folder.
 *
 * Stable by default so repeated syncs replace the same project rather than
 * littering the dashboard.
 *
 * @param {string} dir
 * @param {string} [explicit]
 * @returns {string}
 */
export function projectNameFor(dir, explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim()
  const base = Path.basename(Path.resolve(dir)) || 'latex-project'
  return `${base} (DSH)`
}
