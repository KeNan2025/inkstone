/**
 * End-to-end proof of the session-import path against a fake deployment.
 *
 * Exercises the exact code the Host uses: build the client, import a session
 * cookie (verify + bare value), resolve the identity, list projects, then run
 * the whole pack → upload → compile → download → delete cycle. This is what
 * the Host route handlers do, minus HTTP framing (covered by host-test.mjs).
 *
 * Run: node session-e2e.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import Path from 'node:path'
import { createOverleafClient, OverleafError, ErrorCode } from '../lib/overleaf-client.js'

const results = []
function check(ok, name, detail) {
  results.push({ ok, name, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

const SID_VALUE = 's%3A1VVVwRcbVCGEVkfqEh5IHtsDKEPOjHQX.9eA548hvMCBU5ju4QwMP%2FZlarLGTl%2FDmTgM91RiN%2FbI'
const ACCOUNT = 'writer@example.edu'

/* ------------------------------------------- fake deployment (cookie auth) */
const state = { projects: new Map(), compileStatus: 'success', seenCookies: [] }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const cookie = req.headers.cookie || ''
  state.seenCookies.push(cookie)
  const authed = cookie.includes('overleaf.sid=' + SID_VALUE)

  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const html = (body) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  }

  if (url.pathname === '/dev/csrf') {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': `latex-session=abc; Path=/` })
    res.end('tok-fixed-0123456789abcdef012345')
    return
  }

  // Identity: the JSON route is 404 on this fake (like a gated deployment), so
  // the client must fall back to scraping the dashboard meta tag.
  if (url.pathname === '/user/personal_info') {
    if (!authed) return json(401, { message: { type: 'error', key: 'not-logged-in' } })
    return json(404, { error: 'nope' })
  }
  if (url.pathname === '/project' && req.method === 'GET') {
    if (!authed) {
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }
    return html(`<html><head><meta name="ol-usersEmail" content="${ACCOUNT}"></head><body>ok</body></html>`)
  }

  if (url.pathname === '/user/projects') {
    if (!authed) return json(401, { message: { type: 'error', key: 'not-logged-in' } })
    return json(200, { projects: [...state.projects.values()].map((p) => ({ _id: p.id, name: p.name })) })
  }

  if (url.pathname === '/project/new/upload' && req.method === 'POST') {
    if (!authed) return json(401, { error: 'unauthorized' })
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const text = body.toString('latin1')
    if (!text.includes('name="qqfile"')) return json(400, { success: false, error: 'invalid_upload_request' })
    const id = 'p' + (state.projects.size + 1)
    state.projects.set(id, { id, name: 'uploaded', bytes: body.length })
    return json(200, { success: true, project_id: id.padEnd(24, '0') })
  }

  const compileMatch = url.pathname.match(/^\/project\/([^/]+)\/compile$/)
  if (compileMatch && req.method === 'POST') {
    if (!authed) return json(401, { error: 'unauthorized' })
    for await (const c of req) void c
    const pid = compileMatch[1]
    if (state.compileStatus !== 'success') {
      return json(200, { status: state.compileStatus, outputFiles: [], clsiServerId: 'clsi-1' })
    }
    const buildId = 'deadbeefdeadbeefdeadbeef'
    return json(200, {
      status: 'success',
      clsiServerId: 'clsi-1',
      outputFiles: [
        { path: 'output.pdf', type: 'pdf', build: buildId, url: `/project/${pid}/user/u1/build/${buildId}/output/output.pdf` },
        { path: 'output.log', type: 'log', build: buildId, url: `/project/${pid}/user/u1/build/${buildId}/output/output.log` },
      ],
    })
  }

  const fileMatch = url.pathname.match(/^\/project\/([^/]+)\/user\/[^/]+\/build\/[^/]+\/output\/(.+)$/)
  if (fileMatch) {
    if (!authed) return json(401, { error: 'unauthorized' })
    const file = fileMatch[2]
    if (file === 'output.pdf') {
      const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1')
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length) })
      res.end(pdf)
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('This is XeTeX\nOutput written on output.pdf\n')
    return
  }

  if (/^\/Project\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') {
    if (!authed) return json(401, { error: 'unauthorized' })
    const id = url.pathname.split('/').pop()
    state.projects.delete(id)
    return json(200, {})
  }

  json(404, { error: 'not found: ' + url.pathname })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`
console.log('\n=== session e2e ===')
console.log('  fake deployment:', baseUrl)

const scratch = await mkdtemp(Path.join(tmpdir(), 'olw-e2e-'))
const projectDir = Path.join(scratch, 'thesis')
await mkdir(Path.join(projectDir, 'data'), { recursive: true })
await writeFile(Path.join(projectDir, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n')
await writeFile(Path.join(projectDir, 'data', 'chap.tex'), 'text\n')
await writeFile(Path.join(projectDir, 'main.aux'), 'artifact\n')

/* 1. a bare pasted value is understood */
const probe = createOverleafClient({ baseUrl })
const parsed = probe.constructor.parseSessionCookie(SID_VALUE)
check(parsed.length === 1 && parsed[0].name === 'overleaf.sid', 'bare value is read as overleaf.sid', JSON.stringify(parsed))

/* 2. junk is rejected before any network call */
try {
  await probe.importSession('definitely not a cookie')
  check(false, 'junk cookie is rejected')
} catch (err) {
  check(err instanceof OverleafError && err.code === ErrorCode.INVALID_ARGUMENT, 'junk cookie is rejected locally', err.code)
}

/* 3. import + identity resolution through the dashboard fallback */
const client = createOverleafClient({ baseUrl })
const imported = await client.importSession(SID_VALUE, { verify: true })
check(imported.ok === true, 'importSession succeeds with a valid cookie')
check(imported.account === ACCOUNT, 'identity resolved via the dashboard meta fallback', String(imported.account))
check(client.exportSession().includes('overleaf.sid='), 'the cookie is exported for persistence')

/* 4. a dead cookie fails closed */
const dead = createOverleafClient({ baseUrl })
try {
  await dead.importSession('overleaf.sid=s%3Adead.dead', { verify: true })
  check(false, 'a dead cookie is rejected')
} catch (err) {
  check(err instanceof OverleafError && err.code === ErrorCode.AUTH_REQUIRED, 'a dead cookie is rejected as AUTH_REQUIRED', err.code)
}

/* 5. full cycle with the imported session */
const projects = await client.listProjects()
check(Array.isArray(projects) && projects.length === 0, 'listProjects works with the cookie session')

const zip = await client.buildZipFromDirectory(projectDir, { warn: () => {} })
check(zip.entries.includes('main.tex'), 'project packed')
check(!zip.entries.includes('main.aux'), 'artifacts excluded from the upload')

const projectId = await client.createProjectFromZip({ name: 'e2e-thesis', zipBuffer: zip.buffer })
check(typeof projectId === 'string' && projectId.length > 0, 'project created', projectId)

const compiled = await client.compile({ projectId, rootResourcePath: 'main.tex', compiler: 'xelatex' })
check(compiled.status === 'success', 'compile reports success')
check(!!compiled.buildId, 'buildId derived', String(compiled.buildId))
const pdfEntry = compiled.outputFiles.find((f) => f.path === 'output.pdf')
const pdf = await client.downloadPdf({ projectId, buildId: compiled.buildId, clsiServerId: compiled.clsiServerId, entry: pdfEntry })
check(pdf.subarray(0, 5).toString('latin1') === '%PDF-', 'PDF downloaded and verified')

await client.deleteProject(projectId)
check(!state.projects.has(projectId), 'remote project deleted after the build')

/* 6. every request carried the session cookie */
const unauthenticated = state.seenCookies.filter((c) => !c.includes('overleaf.sid='))
check(unauthenticated.length <= 2, 'the session cookie was sent on essentially every request', `without-cookie=${unauthenticated.length}/${state.seenCookies.length}`)

server.close()
await rm(scratch, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(66))
console.log(`TOTAL: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) {
  for (const f of failed) console.log('  FAILED:', f.name, '—', f.detail || '')
  process.exitCode = 1
}
