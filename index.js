/**
 * Host half of 砚台 · Inkstone.
 *
 * Registers the loopback-only `/api/dsh-overleaf` route family. Every
 * filesystem read and every outbound request to latex.cstcloud.cn happens
 * here; the browser half only renders and posts JSON.
 *
 * Design notes
 * - No local TeX is involved: the project folder is zipped in-memory, uploaded
 *   to the deployment (`POST /project/new/upload` with the `qqfile` part), its
 *   compiler is persisted, and the server-side log is parsed for diagnostics.
 * - The session cookie is kept in the harness credential store when that
 *   service is present, and in a 0600 file under the DSH home otherwise. It is
 *   never returned to the browser and never written into a session log.
 *
 * @module dsh-inkstone
 */

import { promises as fsp } from 'node:fs'
import * as nodeFs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import Path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  createOverleafClient,
  OverleafError,
  ErrorCode,
} from './lib/overleaf-client.js'
import { ProjectSync, parseLatexLog, logDigest, projectNameFor } from './lib/sync-client.js'

/* ------------------------------------------------------------------ utils */

const ROUTE_BASE = '/api/dsh-overleaf'

const ROUTES = {
  status: `${ROUTE_BASE}/status`,
  workspace: `${ROUTE_BASE}/workspace`,
  projects: `${ROUTE_BASE}/projects`,
  login: `${ROUTE_BASE}/login`,
  logout: `${ROUTE_BASE}/logout`,
  chooseDirectory: `${ROUTE_BASE}/choose-directory`,
  build: `${ROUTE_BASE}/build`,
  job: `${ROUTE_BASE}/job`,
  jobs: `${ROUTE_BASE}/jobs`,
  pdf: `${ROUTE_BASE}/pdf`,
  saveCredential: `${ROUTE_BASE}/credential`,
  clearCredential: `${ROUTE_BASE}/credential/clear`,
  /** Where the proxied editor is mounted; the panel points its iframe here. */
  /** Diagnostics for the embed proxy (request/upgrade counters). */
  /** Browser-side reports posted by the probe injected into the frame. */
  probe: `${ROUTE_BASE}/probe`,
  /** Project linking: choose the remote project a local folder syncs into. */
  link: `${ROUTE_BASE}/link`,
  /** Push local sources to the linked project and compile it. */
  sync: `${ROUTE_BASE}/sync`,
  /** Last compile result for the linked project (log + diagnostics). */
  diagnostics: `${ROUTE_BASE}/diagnostics`,
}

/**
 * Root prefixes mirrored to the DSH origin for runtime-built URLs.
 * Kept here as well so diagnostics can report it without importing internals.
 */

/** Late-bound proxy handle so route handlers can report its counters. */

/** Late-bound socket tunnel handle, for diagnostics and teardown. */

/** Diagnostic breadcrumbs written during `apply`; read back over HTTP. */
const diagLog = []
function diag(entry) {
  diagLog.push({ at: new Date().toISOString(), ...entry })
  if (diagLog.length > 60) diagLog.splice(0, diagLog.length - 60)
}

/**
 * Reports posted by the probe running INSIDE the embedded frame. This is how the
 * Host learns which URLs the browser actually failed on — the server-side view
 * says every asset is 200, so any remaining breakage is browser-side resolution.
 */

/**
 * Probe installed inside the embedded frame.
 *
 * Reports failed resources, uncaught errors and promise rejections, plus a
 * couple of readyState snapshots, so the Host can tell "assets never loaded"
 * apart from "loaded but the app threw". Kept as a plain string: it runs in the
 * browser, not here.
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

/** @param {import('node:http').ServerResponse} res */
function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}

function safeText(value, limit = 2000) {
  const s = typeof value === 'string' ? value : String(value == null ? '' : value)
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/* ---------------------------------------------------------- trust fence */

function isIPv4Loopback(v4) {
  if (typeof v4 !== 'string') return false
  const parts = v4.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p)) && parts[0] === '127'
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  if (address === '::1') return true
  if (address.startsWith('::ffff:')) return isIPv4Loopback(address.slice(7))
  return isIPv4Loopback(address)
}

function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true
  return isIPv4Loopback(h)
}

/**
 * Loopback-only fence: a loopback socket, no forwarding header, a loopback
 * Host header, and same-origin browser markers.
 */
function isLoopbackRequest(request) {
  try {
    if (!isLoopbackAddress(request.socket && request.socket.remoteAddress)) return false
    const headers = request.headers
    if (headers['cf-connecting-ip'] !== undefined) return false
    if (headers['x-forwarded-for'] !== undefined) return false
    const host = headers.host
    if (typeof host !== 'string') return false
    const hostUrl = new URL(`http://${host}`)
    if (!isLoopbackHostname(hostUrl.hostname)) return false
    if (headers['sec-fetch-site'] === 'cross-site') return false
    const origin = headers.origin
    if (origin === undefined) return true
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* --------------------------------------------------------- session store */

/**
 * Keeps the Overleaf session cookie out of the browser and out of session logs.
 *
 * Why a cookie and not a password: this deployment runs with global login and
 * its accounts belong to an SSO-managed group, so the password-reset page
 * answers "You can't reset your password because your group or organization
 * uses SSO". There is no local password to store. The signed `overleaf.sid`
 * cookie is the only credential that works, and it is HttpOnly/Secure — those
 * flags bind browser *scripts*, not a server-side `Cookie` header, so the Host
 * process can present it exactly like a browser would.
 *
 * Preferred backend: the harness `credentials` service (a `grant` record whose
 * payload holds the cookie string). Fallback: a 0600 JSON file under the DSH
 * home, used when that service is absent from this profile.
 */
class SessionStore {
  constructor(ctx, stateDir) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.credentialsKey = 'inkstone/session'
    this.filePath = Path.join(stateDir, 'session.json')
    this.legacyPath = Path.join(stateDir, 'account.json')
    this._service = undefined
  }

  /** Resolve the optional credentials service once. */
  service() {
    if (this._service !== undefined) return this._service
    let found
    try {
      const viaGet = typeof this.ctx.get === 'function' ? this.ctx.get('credentials', false) : undefined
      found = viaGet && typeof viaGet.readRecord === 'function' ? viaGet : undefined
    } catch {
      found = undefined
    }
    this._service = found || null
    return this._service
  }

  /**
   * Drop the pre-session credential file written by the password-based build.
   * It can never work on an SSO account, so it is removed rather than migrated.
   */
  async discardLegacy() {
    try {
      await fsp.rm(this.legacyPath, { force: true })
    } catch {
      /* absent */
    }
  }

  /** @returns {Promise<{cookie: string, email: string|null}|null>} */
  async read() {
    const service = this.service()
    if (service) {
      try {
        const record = await service.readRecord(this.credentialsKey)
        if (record && record.payload && typeof record.payload === 'object') {
          const { cookie, email } = record.payload
          if (typeof cookie === 'string' && cookie) {
            return { cookie, email: typeof email === 'string' ? email : null }
          }
        }
      } catch {
        /* fall through to the file backend */
      }
    }
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (typeof parsed.cookie === 'string' && parsed.cookie) {
        return { cookie: parsed.cookie, email: typeof parsed.email === 'string' ? parsed.email : null }
      }
    } catch {
      /* not configured */
    }
    return null
  }

  /** @param {{cookie: string, email?: string|null}} session */
  async write(session) {
    const payload = { cookie: session.cookie, email: session.email || null }
    const service = this.service()
    if (service) {
      try {
        await service.modifyRecord(this.credentialsKey, async () => ({
          kind: 'grant',
          payload,
        }))
        // A stale file copy must not shadow the service on a later read.
        await fsp.rm(this.filePath, { force: true })
        return { backend: 'credentials' }
      } catch {
        /* fall through to the file backend */
      }
    }
    await fsp.mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    await fsp.writeFile(this.filePath, JSON.stringify(payload, null, 2), { mode: 0o600 })
    try {
      await fsp.chmod(this.filePath, 0o600)
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    return { backend: 'file', path: this.filePath }
  }

  async clear() {
    const service = this.service()
    if (service) {
      try {
        await service.deleteRecord(this.credentialsKey)
      } catch {
        /* ignore */
      }
    }
    await fsp.rm(this.filePath, { force: true })
    await this.discardLegacy()
  }

  describe() {
    const service = this.service()
    return {
      backend: service ? 'credentials' : 'file',
      storePath: service ? 'DSH 凭据存储 (credentials)' : this.filePath,
    }
  }
}

/* -------------------------------------------------------------- helpers */

/** Directories that never belong in an Overleaf upload. */
const ASIDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  '.idea',
  '__pycache__',
  '.ipynb_checkpoints',
  '.texpadtmp',
  '__MACOSX',
  '.overleaf-workbench',
])

/** Generated LaTeX artifacts, recreated by every compile. */
const ARTIFACT_EXT = new Set([
  '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk',
  '.synctex', '.synctex.gz', '.synctex(busy)', '.bbl', '.blg', '.nav', '.snm',
  '.vrb', '.idx', '.ind', '.ilg', '.glo', '.gls', '.glg', '.bcf', '.run.xml',
  '.xdv', '.dvi', '.swp', '.swo', '.tmp', '.bak', '.orig', '.rej',
])

/** Extensions that are LaTeX sources worth sending. */
const SOURCE_EXT = new Set([
  '.tex', '.latex', '.ltx', '.cls', '.sty', '.bst', '.bib', '.bibtex', '.txt',
  '.tikz', '.md', '.yml', '.yaml', '.cfg', '.def', '.clo', '.ldf', '.ist',
  '.ins', '.dtx', '.bbx', '.cbx', '.lbx', '.png', '.jpg', '.jpeg', '.pdf',
  '.eps', '.svg', '.gif', '.bmp', '.tif', '.tiff', '.csv', '.dat', '.lua',
  '.rtex', '.rnw', '.mk', '.diff', '.patch', '.code-workspace',
])

function extOf(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.synctex.gz')) return '.synctex.gz'
  const i = lower.lastIndexOf('.')
  return i < 0 ? '' : lower.slice(i)
}

/**
 * Choose a sensible default root document.
 * Prefers `main.tex`, then any top-level `.tex` that contains `\documentclass`.
 */
async function detectRoot(dir) {
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return { root: 'main.tex', candidates: [] }
  }
  const topTex = entries
    .filter((d) => d.isFile() && /\.(tex|ltx|latex)$/i.test(d.name))
    .map((d) => d.name)
    .sort()
  if (topTex.includes('main.tex')) return { root: 'main.tex', candidates: topTex }
  for (const name of topTex) {
    try {
      const head = (await fsp.readFile(Path.join(dir, name), 'utf8')).slice(0, 8000)
      if (/\\documentclass/.test(head)) return { root: name, candidates: topTex }
    } catch {
      /* unreadable: keep looking */
    }
  }
  return { root: topTex[0] || 'main.tex', candidates: topTex }
}

/** Suggest a project name that is unique enough to find again. */
function suggestedProjectName(dir, explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim()
  const base = Path.basename(Path.resolve(dir)) || 'latex-project'
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace('-', '')
  return `${base} (DSH ${stamp})`
}

/* ----------------------------------------------------------- workbench */

class Workbench {
  constructor(ctx, store, stateDir) {
    this.ctx = ctx
    this.store = store
    this.stateDir = stateDir
    this.outDir = Path.join(stateDir, 'out')
    this.statePath = Path.join(stateDir, 'state.json')
    this.jobs = new Map()
    this.state = { recent: [], prefs: {}, links: {}, compileCache: {} }
    this._client = null
    this._sessionRecord = null
    this._sessionState = { loggedIn: false, email: null, checkedAt: 0 }
  }

  /* -- persistence ------------------------------------------------------ */

  async load() {
    try {
      const raw = await fsp.readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.state.recent = Array.isArray(parsed.recent) ? parsed.recent.slice(0, 20) : []
        this.state.prefs = parsed && typeof parsed.prefs === 'object' && parsed.prefs ? parsed.prefs : {}
        this.state.links = parsed && typeof parsed.links === 'object' && parsed.links ? parsed.links : {}
        this.state.compileCache =
          parsed && typeof parsed.compileCache === 'object' && parsed.compileCache ? parsed.compileCache : {}
      }
    } catch {
      /* first run */
    }
    await fsp.mkdir(this.stateDir, { recursive: true }).catch(() => {})
    await fsp.mkdir(this.outDir, { recursive: true }).catch(() => {})
  }

  async save() {
    try {
      await fsp.mkdir(this.stateDir, { recursive: true })
      await fsp.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (err) {
      this.ctx.logger.warn?.(`[inkstone] state save failed: ${err && err.message}`)
    }
  }

  recordRecent(entry) {
    this.state.recent = [entry, ...this.state.recent.filter((r) => r.dir !== entry.dir)].slice(0, 20)
    this.save().catch(() => {})
  }

  /* -- session ---------------------------------------------------------- */

  /**
   * The stored session record, if any (never exposed to the browser).
   * @returns {Promise<{cookie: string, email: string|null}|null>}
   */
  async session() {
    if (this._sessionRecord) return this._sessionRecord
    this._sessionRecord = await this.store.read()
    return this._sessionRecord
  }

  /**
   * A client with the stored cookie installed, or null when unconfigured.
   * The client is reused so its cookie jar and CSRF token survive between
   * calls; `resetClient` drops it when the session changes.
   */
  async client() {
    if (this._client) return this._client
    const record = await this.session()
    if (!record) return null
    const client = createOverleafClient({
      baseUrl: 'https://latex.cstcloud.cn',
      timeoutMs: 180_000,
    })
    // Install without re-verifying: the caller decides when to probe.
    await client.importSession(record.cookie, { verify: false })
    this._client = client
    return this._client
  }

  /** Forget the live client (after a session change or a failed probe). */
  resetClient() {
    this._client = null
    this._sessionRecord = null
    this._sessionState = { loggedIn: false, email: null, checkedAt: 0 }
  }

  /**
   * Validate the stored cookie, caching a successful result.
   * @param {{force?: boolean}} [opts]
   */
  async ensureLogin({ force = false } = {}) {
    const record = await this.session()
    if (!record) {
      return { loggedIn: false, email: null, reason: 'no-session' }
    }
    if (!force && this._sessionState.loggedIn && this._sessionState.email) {
      return { loggedIn: true, email: this._sessionState.email }
    }
    const client = await this.client()
    try {
      const email = await client.whoAmI()
      if (!email) {
        throw new OverleafError('session is not valid any more', {
          code: ErrorCode.AUTH_REQUIRED,
          status: 401,
        })
      }
      // Keep the discovered address so the panel can show who is signed in.
      if (email !== record.email) {
        record.email = email
        this.store.write({ cookie: record.cookie, email }).catch(() => {})
      }
      this._sessionState = { loggedIn: true, email, checkedAt: Date.now(), reason: null }
      return { loggedIn: true, email }
    } catch (err) {
      const code = err instanceof OverleafError ? err.code : 'NETWORK'
      const message =
        code === ErrorCode.NETWORK
          ? `无法连接 latex.cstcloud.cn：${safeText(err.message, 200)}`
          : '会话已失效。请在浏览器里重新登录 latex.cstcloud.cn，然后重新复制 Cookie。'
      // Drop the live client but keep the verdict: resetClient() clears the
      // cache, so record the failure AFTER it or the panel loses the reason.
      if (code !== ErrorCode.NETWORK) this.resetClient()
      this._sessionState = {
        loggedIn: false,
        email: record.email || null,
        checkedAt: Date.now(),
        reason: code,
        message,
      }
      return { loggedIn: false, email: record.email || null, reason: code, message }
    }
  }

  /* -- workspace discovery ---------------------------------------------- */

  /** Directories offered in the picker: open workspaces plus the process cwd. */
  async workspaces() {
    const list = []
    const seen = new Set()
    const push = (entry) => {
      if (!entry || !entry.path) return
      const resolved = Path.resolve(entry.path)
      const key = resolved.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      list.push({ path: resolved, name: entry.name || Path.basename(resolved) })
    }

    try {
      const registry = this.ctx.get?.('workspaceRegistry', false)
      if (registry && typeof registry.list === 'function') {
        for (const ws of registry.list()) push({ path: ws.path, name: ws.title })
      }
    } catch {
      /* optional service */
    }
    for (const dir of this.activeSessionDirs()) push({ path: dir, name: Path.basename(dir) })
    try {
      push({ path: process.cwd(), name: 'DSH 工作目录' })
    } catch {
      /* ignore */
    }
    return list
  }

  activeSessionDirs() {
    const dirs = []
    try {
      const sessions = this.ctx.get?.('sessions', false)
      if (sessions && typeof sessions.list === 'function') {
        for (const s of sessions.list()) {
          const cwd = s && s.header && s.header.cwd
          if (typeof cwd === 'string' && cwd) dirs.push(cwd)
        }
      }
    } catch {
      /* optional */
    }
    return dirs
  }

  /* -- status ----------------------------------------------------------- */

  /**
   * Snapshot for the panel.
   *
   * Deliberately does NOT block on a network round-trip: the panel renders from
   * this on open, and waiting on the deployment's identity probe made the page
   * hang whenever the remote was slow. The cached verdict from the last real
   * check is reported instead, and the panel offers an explicit "检查连接"
   * action that reruns the probe.
   *
   * @param {{verify?: boolean}} [opts] `verify: true` forces a fresh probe.
   */
  async status(opts = {}) {
    const record = await this.session()
    let session
    if (opts.verify) {
      session = await this.ensureLogin({ force: true })
    } else {
      // Use the cached state; only probe when nothing is known yet and a
      // session exists (first load after a restart).
      const cached = this._sessionState
      if (cached && cached.checkedAt > 0) {
        session = {
          loggedIn: cached.loggedIn,
          email: cached.email,
          reason: cached.reason || null,
          message: cached.message || null,
        }
      } else if (record) {
        session = await this.ensureLogin()
      } else {
        session = { loggedIn: false, email: null, reason: 'no-session' }
      }
    }
    const store = this.store.describe()
    let workspace = null
    const prefs = this.state.prefs || {}
    if (prefs.dir) {
      workspace = await this.inspectWorkspace(prefs.dir).catch(() => null)
    }
    if (!workspace) {
      const candidate = this.activeSessionDirs()[0]
      if (candidate) workspace = await this.inspectWorkspace(candidate).catch(() => null)
    }
    let workspaces = []
    try {
      workspaces = await this.workspaces()
    } catch {
      workspaces = []
    }
    return {
      service: {
        baseUrl: 'https://latex.cstcloud.cn',
        name: '中国科技云论文协同编辑服务',
        host: 'CSTCloud Overleaf',
              },
      auth: {
        configured: !!record,
        email: (record && record.email) || session.email || null,
        loggedIn: !!session.loggedIn,
        verified: !!(this._sessionState && this._sessionState.checkedAt > 0),
        reason: session.reason || null,
        message: session.message || null,
        ...store,
      },
      workspace,
      workspaces,
      recent: this.state.recent,
      prefs,
    }
  }

  /** Inspect one project directory: existence, root candidates, size, files. */
  async inspectWorkspace(dir) {
    const resolved = Path.resolve(dir)
    const st = await fsp.stat(resolved)
    if (!st.isDirectory()) throw new Error(`${resolved} 不是一个文件夹`)
    const { root, candidates } = await detectRoot(resolved)
    let files = 0
    let bytes = 0
    let largest = { name: '', size: 0 }
    const walk = async (abs, rel, depth) => {
      if (depth > 8) return
      let dirents
      try {
        dirents = await fsp.readdir(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const d of dirents) {
        if (d.isSymbolicLink()) continue
        const childAbs = Path.join(abs, d.name)
        const childRel = rel ? `${rel}/${d.name}` : d.name
        if (d.isDirectory()) {
          if (ASIDE_DIRS.has(d.name)) continue
          await walk(childAbs, childRel, depth + 1)
          continue
        }
        if (!d.isFile()) continue
        const ext = extOf(d.name)
        if (ARTIFACT_EXT.has(ext)) continue
        if (!SOURCE_EXT.has(ext)) continue
        try {
          const fs2 = await fsp.stat(childAbs)
          files += 1
          bytes += fs2.size
          if (fs2.size > largest.size) largest = { name: childRel, size: fs2.size }
        } catch {
          /* unreadable */
        }
      }
    }
    await walk(resolved, '', 0)
    return {
      dir: resolved,
      name: Path.basename(resolved),
      suggestedName: suggestedProjectName(resolved),
      suggestedRoot: root,
      rootCandidates: candidates,
      files,
      bytes,
      largest,
    }
  }

  /* -- main file sanity -------------------------------------------------- */

  /** Fail fast with a readable message when the root document is missing. */
  async assertRoot(dir, rootFile) {
    const rel = String(rootFile || 'main.tex').replace(/^[\\/]+/, '')
    const abs = Path.resolve(dir, rel)
    try {
      const st = await fsp.stat(abs)
      if (!st.isFile()) throw new Error('not a file')
    } catch {
      throw new Error(`主文件不存在：${rel}（在 ${dir} 中）`)
    }
  }

  /* -- jobs -------------------------------------------------------------- */

  createJob(payload) {
    const id = randomUUID()
    const job = {
      id,
      createdAt: Date.now(),
      state: 'running',
      ok: false,
      dir: payload.dir,
      rootFile: payload.rootFile,
      compiler: payload.compiler,
      lines: [],
      steps: [
        { id: 'pack', label: '打包', state: 'idle' },
        { id: 'upload', label: '上传', state: 'idle' },
        { id: 'compile', label: '编译', state: 'idle' },
        { id: 'fetch', label: '取回 PDF', state: 'idle' },
      ],
      pdfPath: null,
      pdfUrl: null,
      pdfName: null,
      remoteUrl: null,
      projectId: null,
      seconds: 0,
      error: null,
    }
    this.jobs.set(id, job)
    // Bound the map: keep the newest 30 jobs.
    if (this.jobs.size > 30) {
      const oldest = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) this.jobs.delete(oldest.id)
    }
    return job
  }

  log(job, line) {
    job.lines.push(String(line).replace(/\r/g, ''))
    if (job.lines.length > 600) job.lines.splice(0, job.lines.length - 600)
  }

  step(job, id, state) {
    const step = job.steps.find((s) => s.id === id)
    if (step) step.state = state
  }

  /** Run one build to completion, mutating the job as it goes. */
  async runJob(job, options) {
    const started = Date.now()
    let client = null
    let projectId = null
    let keepRemote = !!options.keepRemote
    try {
      const session = await this.ensureLogin()
      if (!session.loggedIn) throw new Error(session.message || '未登录，无法编译。')
      client = await this.client()
      const { dir, rootFile, compiler, name } = options

      await this.assertRoot(dir, rootFile)

      this.step(job, 'pack', 'active')
      this.log(job, `打包 ${dir} …`)
      // Skip a PDF that is this project's own previous build output: it is
      // regenerated by every compile, and this panel writes it back into the
      // project folder. Figure PDFs must still be uploaded.
      const rootBase = Path.basename(String(rootFile)).replace(/\.[^.]+$/, '')
      const ignore = []
      if (rootBase) {
        ignore.push(`${rootBase}.pdf`)
        ignore.push(`**/${rootBase}.pdf`)
      }
      const zip = await client.buildZipFromDirectory(dir, {
        ignore,
        warn: (m) => this.log(job, `· ${m}`),
      })
      this.log(job, `已打包 ${zip.entries.length} 个文件，${(zip.buffer.length / 1048576).toFixed(2)} MiB`)
      if (zip.skipped.length) {
        this.log(job, `跳过 ${zip.skipped.length} 个文件（生成物/临时目录）`)
      }
      this.step(job, 'pack', 'done')

      this.step(job, 'upload', 'active')
      const projectName = suggestedProjectName(dir, name)
      this.log(job, `上传到 latex.cstcloud.cn（项目名：${projectName}）…`)
      projectId = await client.createProjectFromZip({ name: projectName, zipBuffer: zip.buffer })
      job.projectId = projectId
      this.log(job, `远端项目已创建：${projectId}`)
      this.step(job, 'upload', 'done')

      this.step(job, 'compile', 'active')
      this.log(job, `编译 ${rootFile}（${compiler}）…`)
      let result
      try {
        result = await client.compile({ projectId, rootResourcePath: rootFile, compiler })
      } catch (err) {
        if (err && err.result) {
          if (err.result.log) this.logCompileLog(job, err.result.log)
          if (err.result.validationProblems) {
            this.log(job, `校验问题：${JSON.stringify(err.result.validationProblems)}`)
          }
        }
        throw err
      }
      if (result.log) this.logCompileLog(job, result.log)
      this.log(job, `编译成功（buildId=${result.buildId || 'n/a'}）`)
      this.step(job, 'compile', 'done')

      this.step(job, 'fetch', 'active')
      const pdfBuffer = await client.downloadPdf({
        projectId,
        buildId: result.buildId,
        clsiServerId: result.clsiServerId,
        entry: result.outputFiles.find((f) => f && f.path === 'output.pdf'),
      })
      const safeBase = Path.basename(String(rootFile)).replace(/\.[^.]+$/, '') || 'main'
      const fileName = `${safeBase}.pdf`
      const outPath = Path.join(this.outDir, `${job.id}.pdf`)
      await fsp.writeFile(outPath, pdfBuffer)
      job.pdfPath = outPath
      job.pdfName = fileName
      this.log(job, `已取回 PDF（${(pdfBuffer.length / 1024).toFixed(0)} KiB）`)

      if (options.writeBack !== false) {
        try {
          const target = Path.join(dir, fileName)
          await fsp.writeFile(target, pdfBuffer)
          job.pdfPath = target
          this.log(job, `已写回项目文件夹：${fileName}`)
        } catch (err) {
          this.log(job, `写回项目文件夹失败（可在面板中下载）：${err && err.message}`)
        }
      }
      this.step(job, 'fetch', 'done')

      job.ok = true
      job.state = 'done'
      job.pdfUrl = `${ROUTES.pdf}?id=${encodeURIComponent(job.id)}`
      job.remoteUrl = `https://latex.cstcloud.cn/project/${projectId}`
      if (keepRemote) this.log(job, '已保留远端项目（可在 Overleaf 中打开）')
    } catch (err) {
      job.state = 'error'
      job.ok = false
      const message =
        err instanceof OverleafError
          ? this.describeOverleafError(err)
          : safeText(err && err.message ? err.message : err, 800)
      job.error = message
      this.log(job, `✗ ${message}`)
      for (const s of job.steps) if (s.state === 'active') s.state = 'error'
    } finally {
      job.seconds = Math.round((Date.now() - started) / 100) / 10
      if (projectId && !keepRemote) {
        try {
          await client.deleteProject(projectId)
          this.log(job, '已删除远端临时项目')
        } catch (err) {
          this.log(job, `删除远端项目失败（请手动清理 ${projectId}）：${safeText(err && err.message, 200)}`)
        }
      }
      this.recordRecent({
        id: job.id,
        dir: job.dir,
        rootFile: job.rootFile,
        ok: job.ok,
        seconds: job.seconds,
        at: new Date().toISOString(),
        pdfUrl: job.ok ? job.pdfUrl : null,
        pdfName: job.pdfName,
      })
    }
    return job
  }

  logCompileLog(job, text) {
    const lines = String(text).split(/\r?\n/)
    const interesting = []
    for (const line of lines) {
      if (/^!|LaTeX Error|Undefined control sequence|Missing |Runaway|Emergency stop|Fatal error|File `.*' not found|Package .* Error|Overfull/i.test(line)) {
        interesting.push(line.trim())
      }
    }
    if (interesting.length) {
      this.log(job, '— 编译日志摘录 —')
      for (const line of interesting.slice(0, 40)) this.log(job, line)
    } else {
      this.log(job, '— 编译日志末尾 —')
      for (const line of lines.filter(Boolean).slice(-15)) this.log(job, line)
    }
  }

  describeOverleafError(err) {
    switch (err.code) {
      case ErrorCode.AUTH_INVALID:
        return '编译时登录失效：邮箱或密码不正确。请在账号区重新登录。'
      case ErrorCode.AUTH_CSRF:
        return 'CSRF 校验失败：请重试；若持续出现，请退出后重新登录。'
      case ErrorCode.AUTH_REQUIRED:
        return '会话已过期：请重新登录。'
      case ErrorCode.COMPILE_FAILED:
        return `编译失败：${safeText(err.message, 300)}`
      case ErrorCode.VALIDATION_FAILED:
        return `远端拒绝了请求：${safeText(err.detail || err.message, 400)}`
      case ErrorCode.NETWORK:
        return `无法连接 latex.cstcloud.cn：${safeText(err.message, 300)}`
      default:
        return safeText((err.code ? `[${err.code}] ` : '') + err.message, 600)
    }
  }

  /** Public job view: no absolute host paths beyond the project folder. */
  viewJob(job) {
    if (!job) return null
    return {
      id: job.id,
      state: job.state,
      ok: job.ok,
      dir: job.dir,
      rootFile: job.rootFile,
      compiler: job.compiler,
      steps: job.steps,
      lines: job.lines,
      pdfUrl: job.pdfUrl,
      pdfName: job.pdfName,
      remoteUrl: job.remoteUrl,
      projectId: job.projectId,
      seconds: job.seconds,
      error: job.error,
    }
  }
}

/* -------------------------------------------------------------- plugin */

export const name = 'inkstone'
export const inject = ['webServer']

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  const dshHome = (config && config.dshHome) || process.env.DSH_HOME || Path.join(homedir(), '.dsh')
  const stateDir = Path.join(dshHome, 'overleaf-workbench')
  const store = new SessionStore(ctx, stateDir)
  const workbench = new Workbench(ctx, store, stateDir)
  const ready = workbench.load()

  /**
   * One sync session, sharing the workbench's stored cookie.
   * Reset whenever the credential changes so a rotated session takes effect.
   */
  let syncSession = null
  const syncFor = () => {
    if (syncSession) return syncSession
    syncSession = new ProjectSync({
      baseUrl: 'https://latex.cstcloud.cn',
      getCookie: async () => {
        const record = await workbench.session()
        return record ? record.cookie : null
      },
    })
    return syncSession
  }
  /** Invalidate the cached sync client (after login/logout). */
  const resetSync = () => {
    syncSession = null
  }

  /** Guard: fence + method. Returns false after answering. */
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (method && req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const handle = (handler) => async (req, res) => {
    try {
      await ready
      await handler(req, res)
    } catch (err) {
      ctx.logger?.warn?.(`[inkstone] ${req.method} ${req.url}: ${err && err.stack ? err.stack : err}`)
      if (!res.headersSent) {
        writeJson(res, 500, { error: safeText(err && err.message ? err.message : err, 600) })
      } else {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: ROUTES.status,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, await workbench.status())
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.workspace,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url, 'http://127.0.0.1')
        const dir = url.searchParams.get('dir')
        if (!dir) {
          writeJson(res, 400, { error: 'dir is required' })
          return
        }
        const info = await workbench.inspectWorkspace(dir)
        workbench.state.prefs = { ...(workbench.state.prefs || {}), dir: info.dir }
        workbench.save().catch(() => {})
        writeJson(res, 200, { workspace: info })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.projects,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const session = await workbench.ensureLogin()
        if (!session.loggedIn) {
          writeJson(res, 401, { error: session.message || '未登录' })
          return
        }
        const client = await workbench.client()
        const projects = await client.listProjects()
        writeJson(res, 200, { projects })
      }),
    },
    {
      /**
       * Bind a local folder to a remote project name.
       *
       * The link is by NAME, not id: sync is replace-by-recreate, so the id
       * changes on every push while the name stays stable.
       */
      kind: 'exact',
      path: ROUTES.link,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
        if (!dir) {
          writeJson(res, 400, { error: '请先选择项目文件夹。' })
          return
        }
        const resolved = Path.resolve(dir)
        let info
        try {
          info = await workbench.inspectWorkspace(resolved)
        } catch (err) {
          writeJson(res, 400, { error: `无法读取该文件夹：${safeText(err && err.message, 200)}` })
          return
        }
        const name = projectNameFor(resolved, body.name)
        const links = (workbench.state.links ||= {})
        links[resolved.toLowerCase()] = {
          dir: resolved,
          name,
          rootFile: typeof body.rootFile === 'string' && body.rootFile ? body.rootFile : info.suggestedRoot,
          compiler: ['xelatex', 'pdflatex', 'lualatex'].includes(body.compiler) ? body.compiler : 'xelatex',
          linkedAt: new Date().toISOString(),
        }
        workbench.state.prefs = { ...(workbench.state.prefs || {}), dir: resolved }
        await workbench.save()

        // Report whether a project with that name already exists remotely.
        let remote = null
        try {
          const sync = syncFor()
          remote = await sync.findByName(name)
        } catch (err) {
          ctx.logger?.warn?.(`[inkstone] link lookup failed: ${err && err.message}`)
        }
        writeJson(res, 200, {
          link: links[resolved.toLowerCase()],
          workspace: info,
          remote: remote ? { id: remote._id, name: remote.name } : null,
        })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.diagnostics,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url, 'http://127.0.0.1')
        const dir = url.searchParams.get('dir') || ''
        const key = dir ? Path.resolve(dir).toLowerCase() : ''
        const link = key ? (workbench.state.links || {})[key] : null
        const cached = key ? (workbench.state.compileCache || {})[key] : null
        writeJson(res, 200, { link: link || null, lastCompile: cached || null })
      }),
    },
    {
      /**
       * Push the local folder and compile it server-side, then return the log.
       *
       * This is the whole loop the user asked for: edit locally, sync, compile
       * without any local TeX, and get errors back for the agent to fix.
       */
      kind: 'exact',
      path: ROUTES.sync,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
        if (!dir) {
          writeJson(res, 400, { error: '请先选择项目文件夹。' })
          return
        }
        const resolved = Path.resolve(dir)
        const key = resolved.toLowerCase()

        const session = await workbench.ensureLogin()
        if (!session.loggedIn) {
          writeJson(res, 401, { error: session.message || '未登录，无法同步。' })
          return
        }

        const info = await workbench.inspectWorkspace(resolved)
        const link = (workbench.state.links || {})[key] || {}
        const name = projectNameFor(resolved, body.name || link.name)
        const rootFile =
          (typeof body.rootFile === 'string' && body.rootFile) || link.rootFile || info.suggestedRoot || 'main.tex'
        const compiler =
          (['xelatex', 'pdflatex', 'lualatex'].includes(body.compiler) && body.compiler) ||
          link.compiler ||
          'xelatex'
        await workbench.assertRoot(resolved, rootFile)

        const sync = syncFor()
        const steps = []
        const started = Date.now()

        // 1. find the project currently holding the name
        let previous = null
        try {
          previous = await sync.findByName(name)
          steps.push({ step: 'locate', ok: true, detail: previous ? `已有项目 ${previous._id}` : '新建项目' })
        } catch (err) {
          steps.push({ step: 'locate', ok: false, detail: safeText(err && err.message, 200) })
          throw err
        }

        // 2. create the replacement FIRST, so a failure never leaves the user
        //    without a project.
        const created = await sync.createFromDirectory({ dir: resolved, name })
        steps.push({
          step: 'upload',
          ok: true,
          detail: `${created.fileCount} 个文件 / ${(created.bytes / 1048576).toFixed(1)} MiB → ${created.projectId}`,
        })

        // 3. make the compiler stick, then compile.
        //    The compile body's `compiler` is advisory on this deployment: a
        //    project created from a zip starts on the site default (pdfLaTeX),
        //    so the setting must be persisted first or every CJK fontset fails
        //    with a pdfTeX error.
        let compiled
        try {
          try {
            await sync.setCompiler(created.projectId, compiler)
            steps.push({ step: 'compiler', ok: true, detail: compiler })
          } catch (err) {
            steps.push({ step: 'compiler', ok: false, detail: safeText(err && err.message, 160) })
          }
          compiled = await sync.compile(created.projectId, { rootFile, compiler })
          steps.push({ step: 'compile', ok: compiled.status === 'success', detail: compiled.status })
        } catch (err) {
          steps.push({ step: 'compile', ok: false, detail: safeText(err && err.message, 200) })
          compiled = { status: 'error', log: null, pdf: null, raw: null }
        }

        // 4. only after the replacement exists, retire the old project
        if (previous && previous._id !== created.projectId) {
          try {
            await sync.deleteProject(previous._id)
            steps.push({ step: 'retire', ok: true, detail: `已删除旧项目 ${previous._id}` })
          } catch (err) {
            steps.push({ step: 'retire', ok: false, detail: safeText(err && err.message, 200) })
          }
        }

        const parsed = compiled.log ? parseLatexLog(compiled.log) : { entries: [], summary: null }
        const result = {
          projectId: created.projectId,
          projectName: name,
          remoteUrl: `https://latex.cstcloud.cn/project/${created.projectId}`,
          status: compiled.status,
          rootFile,
          compiler,
          fileCount: created.fileCount,
          bytes: created.bytes,
          seconds: Math.round((Date.now() - started) / 100) / 10,
          log: compiled.log ? logDigest(compiled.log, 6000) : null,
          rawLog: compiled.log ? compiled.log.slice(0, 200_000) : null,
          diagnostics: parsed.entries.slice(0, 60),
          summary: parsed.summary,
          pdfUrl: compiled.pdf ? compiled.pdf.url : null,
          steps,
          at: new Date().toISOString(),
        }

        // Remember the link and the last compile for the panel.
        const links = (workbench.state.links ||= {})
        links[key] = {
          dir: resolved,
          name,
          rootFile,
          compiler,
          projectId: created.projectId,
          linkedAt: link.linkedAt || new Date().toISOString(),
        }
        workbench.state.compileCache = {
          ...(workbench.state.compileCache || {}),
          [key]: {
            status: result.status,
            summary: result.summary,
            seconds: result.seconds,
            at: result.at,
            projectId: result.projectId,
          },
        }
        await workbench.save()

        writeJson(res, 200, result)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.saveCredential,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const raw = typeof body.cookie === 'string' ? body.cookie : ''
        if (!raw.trim()) {
          writeJson(res, 400, { error: '请粘贴 Overleaf 的会话 Cookie。' })
          return
        }

        // Verify before storing: a bad paste must not replace a working session.
        const probe = createOverleafClient({
          baseUrl: 'https://latex.cstcloud.cn',
          timeoutMs: 60_000,
        })
        let account = null
        try {
          const imported = await probe.importSession(raw, { verify: true })
          account = imported.account
        } catch (err) {
          const code = err instanceof OverleafError ? err.code : 'NETWORK'
          const message =
            code === ErrorCode.NETWORK
              ? `无法连接 latex.cstcloud.cn：${safeText(err.message, 200)}`
              : code === ErrorCode.INVALID_ARGUMENT
              ? '这段内容不像会话 Cookie：需要形如 overleaf.sid=… 的一整段。'
              : '这个 Cookie 已失效。请在浏览器里重新登录 latex.cstcloud.cn，再复制一次。'
          writeJson(res, 401, { error: message })
          return
        }

        const written = await store.write({ cookie: probe.exportSession(), email: account })
        workbench._client = probe
        workbench._sessionRecord = { cookie: probe.exportSession(), email: account }
        workbench._sessionState = { loggedIn: true, email: account, checkedAt: Date.now() }
        ctx.logger?.info?.(`[inkstone] session stored via ${written.backend}`)
        writeJson(res, 200, {
          ok: true,
          backend: written.backend,
          email: account,
          status: await workbench.status(),
        })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.clearCredential,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        // The cookie belongs to the user's browser session; this only forgets
        // the local copy. Logging the browser out is the user's decision.
        await store.clear()
        workbench.resetClient()
        resetSync()
        writeJson(res, 200, { ok: true, status: await workbench.status() })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.login,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const session = await workbench.ensureLogin({ force: true })
        writeJson(res, session.loggedIn ? 200 : 401, {
          session,
          status: await workbench.status({ verify: true }),
        })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.logout,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        await store.clear()
        workbench.resetClient()
        resetSync()
        writeJson(res, 200, { ok: true, status: await workbench.status() })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.chooseDirectory,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        let picked = null
        try {
          const picker = ctx.get?.('directoryPicker', false)
          const capability = picker && typeof picker.capability === 'function' ? picker.capability() : null
          if (capability && capability.kind === 'native' && typeof capability.pick === 'function') {
            picked = await capability.pick(new AbortController().signal)
          }
        } catch (err) {
          ctx.logger?.warn?.(`[inkstone] native picker failed: ${err && err.message}`)
        }
        if (!picked) {
          writeJson(res, 200, { canceled: true })
          return
        }
        const info = await workbench.inspectWorkspace(picked).catch((err) => ({ error: err.message }))
        if (info.error) {
          writeJson(res, 400, { error: info.error })
          return
        }
        workbench.state.prefs = { ...(workbench.state.prefs || {}), dir: info.dir }
        workbench.save().catch(() => {})
        writeJson(res, 200, { dir: info.dir, name: info.name, workspace: info })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.build,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
        if (!dir) {
          writeJson(res, 400, { error: '请先选择要编译的项目文件夹。' })
          return
        }
        const session = await workbench.ensureLogin()
        if (!session.loggedIn) {
          writeJson(res, 401, { error: session.message || '未登录，无法编译。' })
          return
        }
        const resolved = Path.resolve(dir)
        const info = await workbench.inspectWorkspace(resolved)
        const rootFile =
          (typeof body.rootFile === 'string' && body.rootFile.trim()) ||
          info.suggestedRoot ||
          'main.tex'
        const compiler = ['xelatex', 'pdflatex', 'lualatex'].includes(body.compiler)
          ? body.compiler
          : 'xelatex'
        await workbench.assertRoot(resolved, rootFile)

        workbench.state.prefs = {
          ...(workbench.state.prefs || {}),
          dir: info.dir,
          rootFile,
          compiler,
        }
        workbench.save().catch(() => {})

        const job = workbench.createJob({ dir: info.dir, rootFile, compiler })
        // Fire and forget: the panel polls GET /job?id=…
        workbench
          .runJob(job, {
            dir: info.dir,
            rootFile,
            compiler,
            name: typeof body.name === 'string' ? body.name : '',
            keepRemote: !!body.keepRemote,
            writeBack: body.writeBack !== false,
          })
          .catch((err) => {
            job.state = 'error'
            job.error = safeText(err && err.message ? err.message : err, 600)
          })
        writeJson(res, 200, { job: workbench.viewJob(job) })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.job,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url, 'http://127.0.0.1')
        const id = url.searchParams.get('id') || ''
        const job = workbench.jobs.get(id)
        if (!job) {
          writeJson(res, 404, { error: 'unknown job' })
          return
        }
        writeJson(res, 200, { job: workbench.viewJob(job) })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.jobs,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const jobs = [...workbench.jobs.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((job) => workbench.viewJob(job))
        writeJson(res, 200, { jobs })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.pdf,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url, 'http://127.0.0.1')
        const id = url.searchParams.get('id') || ''
        const job = workbench.jobs.get(id)
        if (!job || !job.pdfPath) {
          writeJson(res, 404, { error: 'PDF 尚未生成' })
          return
        }
        let data
        try {
          data = await fsp.readFile(job.pdfPath)
        } catch {
          writeJson(res, 404, { error: 'PDF 已被移动或删除' })
          return
        }
        const disposition = url.searchParams.get('download')
          ? `attachment; filename="${encodeURIComponent(job.pdfName || 'output.pdf')}"`
          : `inline; filename="${encodeURIComponent(job.pdfName || 'output.pdf')}"`
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': String(data.length),
          'content-disposition': disposition,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        })
        res.end(data)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.probe,
      handler: handle(async (req, res) => {
        // The probe is same-origin inside the frame, but it still passes the
        // fence like every other route.
        if (!isLoopbackRequest(req)) {
          res.writeHead(403).end()
          return
        }
        const body = await readJsonBody(req, 64 * 1024).catch(() => ({}))
        if (body && body.kind) {
          recordProbe({
            kind: String(body.kind).slice(0, 40),
            detail: String(body.detail || '').slice(0, 400),
            href: String(body.href || '').slice(0, 300),
          })
        }
        res.writeHead(204).end()
      }),
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'inkstone: routes')


  ctx.logger?.info?.('[inkstone] ready: /api/dsh-overleaf')
}