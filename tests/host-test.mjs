/**
 * Host-half integration test.
 *
 * Boots `../index.js`'s `apply()` against a fake cordis context whose
 * `webServer.register` collects the routes, then exercises every route over a
 * real HTTP server with the loopback fence satisfied. No network access is
 * made except the live credential-free paths, which are expected to fail
 * cleanly.
 *
 * Run: node host-test.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import Path from 'node:path'
import assert from 'node:assert/strict'

const results = []
function check(ok, name, detail) {
  results.push({ ok, name, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

/* ------------------------------------------------ fake cordis context */

function makeContext(stateDir) {
  const routes = []
  const effects = []
  const logs = []
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    get(name) {
      if (name === 'credentials') return stateDir.credentials
      if (name === 'workspaceRegistry') return stateDir.workspaceRegistry
      if (name === 'sessions') return stateDir.sessions
      if (name === 'directoryPicker') return stateDir.directoryPicker
      return undefined
    },
    effect(fn) {
      effects.push(fn())
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const i = routes.indexOf(route)
          if (i >= 0) routes.splice(i, 1)
        }
      },
    },
  }
  return { ctx, routes, effects, logs }
}

/* --------------------------------------------------------- HTTP helper */

let baseUrl = ''
let cookie = ''

async function call(pathname, { method = 'GET', body, raw = false, omitOrigin = false } = {}) {
  const headers = { host: new URL(baseUrl).host }
  if (!omitOrigin) headers.origin = baseUrl
  headers['sec-fetch-site'] = 'same-origin'
  if (cookie) headers.cookie = cookie
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
  if (raw) return res
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { __raw: text }
  }
  return { status: res.status, headers: res.headers, json }
}

/* ------------------------------------------------------------- fixtures */

async function makeProjectFixture(root) {
  await mkdir(Path.join(root, 'data'), { recursive: true })
  await mkdir(Path.join(root, 'figures'), { recursive: true })
  await mkdir(Path.join(root, 'node_modules', 'junk'), { recursive: true })
  await mkdir(Path.join(root, '.git'), { recursive: true })
  await writeFile(Path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
  await writeFile(Path.join(root, 'data', 'chap01.tex'), 'chapter one\n')
  await writeFile(Path.join(root, 'ref.bib'), '@article{a, title={t}}\n')
  await writeFile(Path.join(root, 'figures', 'fig.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(Path.join(root, 'main.aux'), 'generated\n')
  await writeFile(Path.join(root, 'main.log'), 'generated\n')
  await writeFile(Path.join(root, 'main.synctex.gz'), 'generated\n')
  await writeFile(Path.join(root, 'node_modules', 'junk', 'x.js'), 'junk\n')
  await writeFile(Path.join(root, '.git', 'config'), 'junk\n')
}

/* ------------------------------------------------------------------ main */

const scratch = await mkdtemp(Path.join(tmpdir(), 'olw-host-test-'))
const projectDir = Path.join(scratch, 'thesis')
const stateDir = Path.join(scratch, 'dsh-home')

await makeProjectFixture(projectDir)

/* -- boot the Host half -- */
const { ctx, routes, effects, logs } = makeContext({
  credentials: null,
  workspaceRegistry: { list: () => [{ path: projectDir, title: 'thesis' }] },
  sessions: { list: () => [{ header: { cwd: projectDir } }] },
  directoryPicker: undefined,
})

const mod = await import(new URL('../index.js', import.meta.url).href)
check(typeof mod.apply === 'function', 'bundle/index.js exports apply()')
check(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'declares inject: [webServer]')
mod.apply(ctx, { dshHome: stateDir })

check(routes.length >= 10, 'registers the /api/dsh-overleaf route family', `routes=${routes.length}`)
const paths = routes.map((r) => r.path)
for (const expected of [
  '/api/dsh-overleaf/status',
  '/api/dsh-overleaf/workspace',
  '/api/dsh-overleaf/build',
  '/api/dsh-overleaf/job',
  '/api/dsh-overleaf/pdf',
  '/api/dsh-overleaf/credential',
]) {
  check(paths.includes(expected), `route ${expected}`)
}
// The sync workbench routes: link a folder, push+compile, read diagnostics.
for (const expected of [
  '/api/dsh-overleaf/link',
  '/api/dsh-overleaf/sync',
  '/api/dsh-overleaf/diagnostics',
]) {
  check(paths.includes(expected), `route ${expected}`)
}
check(!paths.includes('/overleaf-embed'), 'the abandoned embed mount is gone')
const apiRoutes = routes.filter((r) => r.path.startsWith('/api/'))
check(apiRoutes.every((r) => r.kind === 'exact'), 'every route is kind:exact (no prefix mounts)')

/* -- serve them on real loopback so the fence is exercised for real -- */
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.find((r) => r.path === url.pathname)
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"no route"}')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err && err.message) }))
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
baseUrl = `http://127.0.0.1:${server.address().port}`
console.log('\n=== host routes ===')
console.log('  listening on', baseUrl)

/* -- 1. status is reachable and shaped -- */
{
  const r = await call('/api/dsh-overleaf/status')
  check(r.status === 200, 'GET /status → 200', String(r.status))
  check(r.json && r.json.auth && typeof r.json.auth.configured === 'boolean', 'status.auth.configured is boolean')
  check(r.json.auth.configured === false, 'reports unconfigured with no stored credential')
  check(Array.isArray(r.json.workspaces), 'status.workspaces is an array')
  check(r.json.workspaces.some((w) => w.path === projectDir), 'discovers the workspace directory', `ws=${r.json.workspaces.length}`)
  check(r.json.service && r.json.service.baseUrl === 'https://latex.cstcloud.cn', 'reports the service baseUrl')
}

/* -- 2. trust fence --
   A request with no Origin is allowed on purpose: only a non-browser client
   omits it, and the loopback socket + loopback Host checks already apply.
   A CROSS-origin request must be refused. */
{
  const r = await call('/api/dsh-overleaf/status', { omitOrigin: true })
  check(r.status === 200, 'absent Origin is allowed (non-browser fetch on loopback)', String(r.status))

  const res = await fetch(baseUrl + '/api/dsh-overleaf/status', {
    headers: {
      host: new URL(baseUrl).host,
      origin: 'https://evil.example.com',
      'sec-fetch-site': 'cross-site',
    },
  })
  check(res.status === 403, 'cross-origin request → 403', String(res.status))
}

/* -- 3. method guard -- */
{
  const r = await call('/api/dsh-overleaf/status', { method: 'POST', body: {} })
  check(r.status === 405, 'POST /status → 405', String(r.status))
}

/* -- 4. workspace inspection (real directory walk) -- */
{
  const r = await call('/api/dsh-overleaf/workspace?dir=' + encodeURIComponent(projectDir))
  check(r.status === 200, 'GET /workspace → 200', String(r.status))
  const ws = r.json.workspace
  check(ws && ws.dir === Path.resolve(projectDir), 'returns the resolved directory')
  check(ws.suggestedRoot === 'main.tex', 'detects main.tex as the root doc', String(ws.suggestedRoot))
  check(ws.rootCandidates.includes('main.tex'), 'lists root doc candidates', String(ws.rootCandidates))
  check(ws.files >= 4, 'counts source files', `files=${ws.files}`)
  check(typeof ws.suggestedName === 'string' && ws.suggestedName.length > 0, 'suggests a project name', ws.suggestedName)
}

/* -- 5. workspace rejects a non-directory -- */
{
  const r = await call('/api/dsh-overleaf/workspace?dir=' + encodeURIComponent(Path.join(projectDir, 'main.tex')))
  check(r.status === 500 || r.status === 400, 'rejects a file as the project dir', String(r.status))
}

/* -- 6. build without a session fails cleanly, not with a crash -- */
{
  const r = await call('/api/dsh-overleaf/build', { method: 'POST', body: { dir: projectDir } })
  check(r.status === 401, 'build without a stored session → 401', String(r.status))
  check(/登录|未登录|会话|Cookie/.test(r.json.error || ''), 'build explains it needs a session', String(r.json.error).slice(0, 80))
}

/* -- 7. build with a missing root doc is rejected up front -- */
{
  const r = await call('/api/dsh-overleaf/build', {
    method: 'POST',
    body: { dir: projectDir, rootFile: 'does-not-exist.tex' },
  })
  // No session → 401 comes first, which is the correct precedence.
  check(r.status === 401, 'missing-root build still reports the auth problem first', String(r.status))
}

/* -- 8. session import rejects empty input -- */
{
  const r = await call('/api/dsh-overleaf/credential', { method: 'POST', body: { cookie: '   ' } })
  check(r.status === 400, 'POST /credential with an empty cookie → 400', String(r.status))
  check(/Cookie|粘贴/.test(r.json.error || ''), 'empty-cookie rejection is actionable', String(r.json.error).slice(0, 60))
}

/* -- 8b. session import rejects a non-cookie paste, locally, without a call -- */
{
  const r = await call('/api/dsh-overleaf/credential', {
    method: 'POST',
    body: { cookie: 'this is just a sentence, not a cookie' },
  })
  check(r.status === 401, 'POST /credential with junk → 401', String(r.status))
  check(/不像会话 Cookie|失效/.test(r.json.error || ''), 'junk paste is explained', String(r.json.error).slice(0, 70))
  const after = await call('/api/dsh-overleaf/status')
  check(after.json.auth.configured === false, 'a junk paste persists nothing')
}

/* -- 9. a well-formed but dead session cookie is rejected by the LIVE
       deployment and is not stored. This is the one outbound call here. -- */
{
  const dead =
    'overleaf.sid=s%3A' +
    'AAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const r = await call('/api/dsh-overleaf/credential', { method: 'POST', body: { cookie: dead } })
  check(r.status === 401, 'a dead but well-formed cookie is rejected (401)', String(r.status))
  check(/失效|重新登录/.test(r.json.error || ''), 'dead-cookie rejection tells the user to re-copy', String(r.json.error).slice(0, 80))
  const after = await call('/api/dsh-overleaf/status')
  check(after.json.auth.configured === false, 'a dead cookie persists nothing')
}

/* -- 10. unknown job -- */
{
  const r = await call('/api/dsh-overleaf/job?id=nope')
  check(r.status === 404, 'GET /job with an unknown id → 404', String(r.status))
}

/* -- 11. PDF route with no job -- */
{
  const r = await call('/api/dsh-overleaf/pdf?id=nope')
  check(r.status === 404, 'GET /pdf with an unknown id → 404', String(r.status))
}

/* -- 12. jobs list -- */
{
  const r = await call('/api/dsh-overleaf/jobs')
  check(r.status === 200 && Array.isArray(r.json.jobs), 'GET /jobs → 200 with an array')
}

/* -- 13. credential clear is idempotent -- */
{
  const r = await call('/api/dsh-overleaf/credential/clear', { method: 'POST', body: {} })
  check(r.status === 200 && r.json.ok === true, 'POST /credential/clear → 200 ok')
  const s = await call('/api/dsh-overleaf/status')
  check(s.json.auth.configured === false, 'still unconfigured after a clear')
}

/* ------------------------------------------------------------- teardown */

server.close()
if (typeof server.closeAllConnections === 'function') server.closeAllConnections()

// `apply` now starts the Socket.IO tunnel, which owns a listening socket. The
// recorded effect disposers are the only way to release it, so run them all —
// otherwise this process would linger on that listener.
for (const dispose of effects) {
  try {
    if (typeof dispose === 'function') await dispose()
  } catch {
    /* a partially initialised plugin may throw on teardown */
  }
}

await rm(scratch, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(66))
console.log(`TOTAL: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) {
  for (const f of failed) console.log('  FAILED:', f.name, '—', f.detail || '')
  process.exitCode = 1
}
setTimeout(() => process.exit(process.exitCode || 0), 200).unref()
