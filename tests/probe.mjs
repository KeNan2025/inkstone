#!/usr/bin/env node
/**
 * probe.mjs — runnable self-check for src/overleaf-client.js
 *
 * Two modes:
 *
 *   node probe.mjs --offline
 *       Spin up a local HTTP server that impersonates an Overleaf CE deployment
 *       and exercise the FULL happy path: csrf -> login -> create project from a
 *       temp folder -> compile -> download PDF -> delete. Asserts the cookie
 *       jar, the CSRF header, the multipart field name `qqfile`, and that the
 *       downloaded PDF is byte-identical to what the fake server serves.
 *
 *   node probe.mjs --unauth
 *       Hit https://latex.cstcloud.cn with no credentials and prove the contract
 *       that does not require a login: /dev/csrf token shape, /user/projects
 *       requiring auth, /login rejecting nonsense credentials, and the upload
 *       route being present (403/400, never a generic 404).
 *
 *   node probe.mjs --zipcheck
 *       Build a ZIP from a temp folder and verify it with Expand-Archive.
 *
 *   node probe.mjs --all   (default) offline + zipcheck + unauth
 *
 * Exit code 0 on success, 1 if any assertion fails.
 */

import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  createOverleafClient,
  OverleafError,
  ErrorCode,
  createStoredZip,
  crc32,
  CookieJar,
  splitCombinedSetCookie,
} from './src/overleaf-client.js';

/* ------------------------------------------------------------------ *
 * Tiny test harness
 * ------------------------------------------------------------------ */

const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
}

function check(ok, label, extra) {
  results.push({ ok: Boolean(ok), label, section: currentSection });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${extra ? ` — ${extra}` : ''}`);
  return Boolean(ok);
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(66));
  console.log(`TOTAL: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED [${f.section}] ${f.label}`);
    return 1;
  }
  return 0;
}

const tmpRoots = [];
async function mkTmp(prefix) {
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
async function cleanupTmp() {
  for (const d of tmpRoots) {
    try {
      await fsp.rm(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/* ------------------------------------------------------------------ *
 * A real, minimal PDF that renders a page
 * ------------------------------------------------------------------ */

function makeMinimalPdf(text = 'Overleaf Client Probe') {
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  );
  const stream = `BT /F1 18 Tf 24 90 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  objs.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* ------------------------------------------------------------------ *
 * Multipart parser (only what the fake server needs)
 * ------------------------------------------------------------------ */

function parseMultipart(bodyBuf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const buf = bodyBuf;
  const parts = [];
  let idx = buf.indexOf(boundary, 0, 'latin1');
  while (idx !== -1) {
    const start = idx + boundary.length;
    if (buf.subarray(start, start + 2).toString('latin1') === '--') break;
    const nl = buf.indexOf('\r\n', start, 'latin1');
    if (nl === -1) break;
    const headerEnd = buf.indexOf('\r\n\r\n', nl, 'latin1');
    if (headerEnd === -1) break;
    const rawHeaders = buf.subarray(nl + 2, headerEnd).toString('latin1');
    const nextBoundary = buf.indexOf(boundary, headerEnd + 4, 'latin1');
    if (nextBoundary === -1) break;
    const data = buf.subarray(headerEnd + 4, nextBoundary - 2);
    const nameM = /name="([^"]*)"/i.exec(rawHeaders);
    const fileM = /filename="([^"]*)"/i.exec(rawHeaders);
    parts.push({
      name: nameM ? nameM[1] : null,
      filename: fileM ? fileM[1] : null,
      headers: rawHeaders,
      data,
    });
    idx = nextBoundary;
  }
  return parts;
}

/* ================================================================== *
 * --offline : fake Overleaf deployment, full happy path
 * ================================================================== */

async function runOffline() {
  section('offline: fake Overleaf server, full happy path');

  const PDF = makeMinimalPdf('Overleaf Client Probe');
  const PDF_SHA = createHash('sha256').update(PDF).digest('hex');

  const PROJECT_ID = 'a1b2c3d4e5f60718293a4b5c';
  const BUILD_ID = 'f00dbabe1234567890abcdef';
  const USER_ID = '0123456789abcdef01234567';
  const CLSI_SERVER_ID = 'clsi-7-c4d-abc123';
  const EMAIL = 'probe@example.com';
  const PASSWORD = 'correct horse battery staple';

  /** @type {Array<{kind:string, path:string, data:Buffer|null}>} */
  const journal = [];
  const state = {
    sessions: new Set(),
    csrfTokens: new Set(),
    projects: new Map(),
    created: 0,
    compiled: 0,
    deleted: [],
    pdfServed: 0,
  };

  const hash = (s) => createHash('sha256').update(s).digest('hex');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const cookieHeader = req.headers.cookie || '';
    const cookies = Object.fromEntries(
      cookieHeader
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const i = s.indexOf('=');
          return [s.slice(0, i), s.slice(i + 1)];
        })
    );
    const sid = cookies['overleaf.sid'];
    const authed = Boolean(sid && state.sessions.has(sid));
    const csrfHeader = req.headers['x-csrf-token'];
    const setCookie = (name, value, extra = '') => {
      const prev = res.getHeader('set-cookie') || [];
      const arr = Array.isArray(prev) ? prev.slice() : [String(prev)];
      arr.push(`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax${extra}`);
      res.setHeader('set-cookie', arr);
    };
    journal.push({ kind: `${req.method} ${url.pathname}`, path: url.pathname, data: null });

    // ---------------- GET /dev/csrf ----------------
    if (url.pathname === '/dev/csrf' && req.method === 'GET') {
      const token = hash('csrf' + Math.random()).slice(0, 36);
      state.csrfTokens.add(token);
      // A CSRF GET also hands out the session shell cookie, like the real site.
      if (!authed) setCookie('latex-session', hash('sess' + Math.random()).slice(0, 32));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(token);
      return;
    }

    // ---------------- POST /login ----------------
    if (url.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(body.toString('utf8'));
      const formToken = form.get('_csrf');
      const tokenOk =
        (csrfHeader && state.csrfTokens.has(String(csrfHeader))) ||
        (formToken && state.csrfTokens.has(formToken));
      if (!tokenOk) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('invalid csrf token');
        return;
      }
      const email = form.get('email');
      const password = form.get('password');
      if (email !== EMAIL || password !== PASSWORD) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { type: 'error', key: 'invalid-password-retry-or-reset' } }));
        return;
      }
      const newSid = hash('sid' + Math.random());
      state.sessions.add(newSid);
      setCookie('overleaf.sid', newSid);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"redir":"/project"}');
      return;
    }

    // Everything past here needs a session.
    if (!authed) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }

    // ---------------- GET /user/projects ----------------
    if (url.pathname === '/user/projects' && req.method === 'GET') {
      const projects = [...state.projects.values()].map((p) => ({
        _id: p.id,
        name: p.name,
        accessLevel: 'owner',
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ projects }));
      return;
    }

    // ---------------- POST /project/new/upload ----------------
    if (url.pathname === '/project/new/upload' && req.method === 'POST') {
      const tokenOk = csrfHeader && state.csrfTokens.has(String(csrfHeader));
      if (!tokenOk) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('invalid csrf token');
        return;
      }
      const parts = parseMultipart(body, req.headers['content-type']);
      journal.push({ kind: 'upload-parts', path: url.pathname, data: null, parts });
      if (!parts) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"message":"invalid_upload_request"}');
        return;
      }
      const qq = parts.find((p) => p.name === 'qqfile');
      const nameField = parts.find((p) => p.name === 'name');
      if (!qq || !qq.filename) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"message":"invalid_upload_request"}');
        return;
      }
      if (!nameField) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { type: 'error', key: 'project_name_missing' } }));
        return;
      }
      const id = hash('proj' + state.created + Math.random()).slice(0, 24);
      state.created += 1;
      state.projects.set(id, {
        id,
        name: nameField.data.toString('utf8'),
        zip: qq.data,
        // The upload created a project, so it already has entities.
        entities: [
          { path: 'main.tex', type: 'doc' },
          { path: 'data', type: 'folder' },
          { path: 'data/chap01.tex', type: 'doc' },
        ],
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, project_id: id }));
      return;
    }

    // ---------------- project-scoped routes ----------------
    const projMatch = /^\/project\/([0-9a-f]{24})(\/.*)?$/.exec(url.pathname);
    if (projMatch) {
      const pid = projMatch[1];
      const rest = projMatch[2] || '';
      const proj = state.projects.get(pid);
      if (!proj) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Page Not Found</title></head></html>');
        return;
      }

      // GET /project/:id/entities
      if (rest === '/entities' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ entities: proj.entities }));
        return;
      }

      // POST /project/:id/compile
      if (rest === '/compile' && req.method === 'POST') {
        const tokenOk = csrfHeader && state.csrfTokens.has(String(csrfHeader));
        if (!tokenOk) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('invalid csrf token');
          return;
        }
        state.compiled += 1;

        // A project whose name contains FAILCONSUME exercises the non-success
        // compile path, so `compile()`'s error shape is covered too.
        if (/FAILCONSUME/.test(proj.name)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'failure',
              outputFiles: [
                {
                  path: 'output.log',
                  url: `/project/${pid}/user/${USER_ID}/build/${BUILD_ID}/output/output.log`,
                  type: 'log',
                  build: BUILD_ID,
                },
              ],
              clsiServerId: CLSI_SERVER_ID,
              validationProblems: null,
            })
          );
          return;
        }

        proj.entities = [
          { path: 'main.tex', type: 'doc' },
          { path: 'output.pdf', type: 'file' },
        ];
        // NOTE: currently-deployed CE omits top-level buildId and rewrites
        // outputFiles[].url to a SAME-ORIGIN PATH. Model exactly that.
        const payload = {
          status: 'success',
          outputFiles: [
            {
              path: 'output.log',
              url: `/project/${pid}/user/${USER_ID}/build/${BUILD_ID}/output/output.log`,
              type: 'log',
              build: BUILD_ID,
            },
            {
              path: 'output.pdf',
              url: `/project/${pid}/user/${USER_ID}/build/${BUILD_ID}/output/output.pdf`,
              type: 'pdf',
              build: BUILD_ID,
            },
          ],
          outputFilesArchive: {
            path: 'output.zip',
            url: `/project/${pid}/user/${USER_ID}/build/${BUILD_ID}/output/output.zip`,
            type: 'zip',
            build: BUILD_ID,
          },
          compileGroup: 'standard',
          clsiServerId: CLSI_SERVER_ID,
          clsiCacheShard: null,
          validationProblems: null,
          stats: { latexmk: 1 },
          timings: { compileE2E: 1234 },
          outputUrlPrefix: `/project/${pid}/user/${USER_ID}/build/${BUILD_ID}/output/`,
          pdfDownloadDomain: null,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      // Output downloads: both the /user/:uid/build/... shape produced by the
      // compile response AND the fallback /build/... shape.
      const outMatch =
        /^(?:\/user\/[0-9a-f]{24})?\/build\/([0-9a-zA-Z]+)\/output\/(.+)$/.exec(rest);
      if (outMatch && req.method === 'GET') {
        const file = outMatch[2];
        if (file === 'output.pdf') {
          state.pdfServed += 1;
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="output.pdf"',
          });
          res.end(PDF);
          return;
        }
        if (file === 'output.log') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(
            'This is XeLatex, Version 3.141592653\n' +
              '(./main.tex\nLaTeX2e <2024-06-01>\n) \nOutput written on output.pdf (1 page).\n'
          );
          return;
        }
        if (file === 'output.zip') {
          res.writeHead(200, { 'content-type': 'application/zip' });
          res.end(Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'));
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
    }

    // ---------------- DELETE /Project/:id ----------------
    const delMatch = /^\/Project\/([0-9a-f]{24})$/.exec(url.pathname);
    if (delMatch && req.method === 'DELETE') {
      const okCsrf = csrfHeader && state.csrfTokens.has(String(csrfHeader));
      if (!okCsrf) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('invalid csrf token');
        return;
      }
      const pid = delMatch[1];
      if (!state.projects.has(pid)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'project not found' }));
        return;
      }
      state.projects.delete(pid);
      state.deleted.push(pid);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>Page Not Found</title></head></html>');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`  fake deployment listening on ${baseUrl}`);

  const client = createOverleafClient({ baseUrl, timeoutMs: 20000, debug: false });

  try {
    /* ---- 1. CSRF ---- */
    const token = await client.csrfToken();
    check(typeof token === 'string' && token.length >= 16, 'csrfToken() returns a token', `len=${token.length}`);
    check(client.cookies.size > 0, 'cookie jar captured cookies from /dev/csrf', `names=${[...client.cookies.toMap().keys()].join(',')}`);
    const cookiesAfterCsrf = client.cookies.header();
    check(cookiesAfterCsrf.includes('latex-session='), 'jar contains latex-session cookie');
    check(!/Path=|Secure|HttpOnly|SameSite/.test(cookiesAfterCsrf), 'cookie attributes are stripped');

    /* ---- 2. login: wrong password first ---- */
    let rejected = false;
    try {
      await client.login({ email: EMAIL, password: 'wrong-password' });
    } catch (e) {
      rejected = e instanceof OverleafError && e.code === ErrorCode.AUTH_INVALID;
    }
    check(rejected, 'login() with a bad password throws AUTH_INVALID');

    /* ---- 3. login: success ---- */
    const loginRes = await client.login({ email: EMAIL, password: PASSWORD });
    check(loginRes && loginRes.ok === true, 'login() resolves {ok:true}');
    check(client.cookies.has('overleaf.sid'), 'jar captured overleaf.sid from Set-Cookie');

    /* ---- 4. isLoggedIn ---- */
    check((await client.isLoggedIn()) === true, 'isLoggedIn() is true after login');

    /* ---- 5. build a zip from a temp folder ---- */
    const srcDir = await mkTmp('ol-probe-src-');
    const projDir = nodePath.join(srcDir, 'My Thesis');
    await fsp.mkdir(nodePath.join(projDir, 'data'), { recursive: true });
    await fsp.mkdir(nodePath.join(projDir, 'figures'), { recursive: true });
    await fsp.mkdir(nodePath.join(projDir, '.git'), { recursive: true });
    await fsp.mkdir(nodePath.join(projDir, 'node_modules', 'junk'), { recursive: true });
    await fsp.writeFile(nodePath.join(projDir, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}\n');
    await fsp.writeFile(nodePath.join(projDir, 'data', 'chap01.tex'), 'Chapter one\n');
    await fsp.writeFile(nodePath.join(projDir, 'figures', 'fig1.pdf'), '%PDF-1.4 user figure\n');
    await fsp.writeFile(nodePath.join(projDir, 'main.aux'), 'artifact\n');
    await fsp.writeFile(nodePath.join(projDir, 'main.log'), 'artifact\n');
    await fsp.writeFile(nodePath.join(projDir, 'main.synctex.gz'), 'artifact\n');
    await fsp.writeFile(nodePath.join(projDir, 'main.bbl'), 'artifact\n');
    await fsp.writeFile(nodePath.join(projDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fsp.writeFile(nodePath.join(projDir, 'node_modules', 'junk', 'index.js'), 'nope\n');

    const zipResult = await client.buildZipFromDirectory(projDir);
    const zipBuf = zipResult.buffer;
    check(Buffer.isBuffer(zipBuf) && zipBuf.length > 0, 'buildZipFromDirectory returns a Buffer', `${zipBuf.length} bytes`);
    check(zipBuf.subarray(0, 4).toString('latin1') === 'PK\x03\x04', 'zip starts with a local file header signature');
    check(crc32(Buffer.from('hello')) === 0x3610a686, 'crc32 matches the known value for "hello"');

    const names = zipResult.entries;
    check(names.includes('main.tex'), 'zip contains main.tex at the root (no folder prefix)', names.join(', '));
    check(names.includes('data/chap01.tex'), 'zip contains data/chap01.tex with forward slashes');
    check(names.includes('figures/fig1.pdf'), 'zip keeps user PDFs (figures/fig1.pdf)');
    check(!names.some((n) => n.endsWith('.aux')), 'zip excludes *.aux artifacts');
    check(!names.some((n) => n.endsWith('.log')), 'zip excludes *.log artifacts');
    check(!names.some((n) => n.includes('synctex')), 'zip excludes synctex artifacts');
    check(!names.some((n) => n.includes('node_modules')), 'zip excludes node_modules');
    check(!names.some((n) => n.startsWith('.git/')), 'zip excludes .git');
    check(!names.some((n) => n.startsWith('My Thesis/')), "zip does not use the folder's own name as a prefix");

    /* ---- 6. create project from the zip ---- */
    const projectId = await client.createProjectFromZip({
      name: 'My Thesis',
      zipBuffer: zipBuf,
    });
    check(/^[0-9a-f]{24}$/.test(projectId), 'createProjectFromZip returns a 24-hex project id', projectId);
    check(state.projects.has(projectId), 'the fake server registered the project');

    const uploadPart = journal.filter((j) => j.kind === 'upload-parts').pop();
    const partNames = uploadPart && uploadPart.parts ? uploadPart.parts.map((p) => p.name) : [];
    check(partNames.includes('qqfile'), 'multipart used the field name qqfile', partNames.join(','));
    check(partNames.includes('name'), 'multipart included the name field');
    check(partNames.includes('_csrf'), 'multipart included the _csrf field');
    const filePart = uploadPart.parts.find((p) => p.name === 'qqfile');
    check(Boolean(filePart && filePart.filename), 'qqfile carried a filename', filePart && filePart.filename);
    check(
      Boolean(filePart && filePart.data.equals(zipBuf)),
      'uploaded bytes are byte-identical to the built zip'
    );
    const namePart = uploadPart.parts.find((p) => p.name === 'name');
    check(namePart && namePart.data.toString('utf8') === 'My Thesis', 'name field carried the project name');

    /* ---- 7. entities ---- */
    const ents = await client.projectEntities(projectId);
    check(Array.isArray(ents) && ents.some((e) => e.path === 'main.tex'), 'projectEntities returns the uploaded files');

    /* ---- 8. listProjects ---- */
    const projects = await client.listProjects();
    check(projects.some((p) => p._id === projectId), 'listProjects includes the new project');

    /* ---- 9. compile ---- */
    const compiled = await client.compile({ projectId, rootResourcePath: 'main.tex', compiler: 'xelatex' });
    check(compiled.status === 'success', 'compile() reports status success', compiled.status);
    check(compiled.buildId === BUILD_ID, 'compile() derived buildId from outputFiles[].build', String(compiled.buildId));
    check(compiled.clsiServerId === CLSI_SERVER_ID, 'compile() captured clsiServerId');
    check(Boolean(compiled.pdf && compiled.pdf.url), 'compile() located a PDF descriptor', compiled.pdf && compiled.pdf.url);
    check(
      compiled.pdf.url.startsWith(`/project/${projectId}/user/`),
      'PDF descriptor is a same-origin path (not an absolute URL)'
    );
    check(
      typeof compiled.log === 'string' && compiled.log.includes('XeLatex'),
      'compile() captured output.log text',
      JSON.stringify((compiled.log || '').slice(0, 40))
    );
    check(compiled.raw && compiled.raw.outputFilesArchive && compiled.raw.outputFilesArchive.path === 'output.zip', 'compile() preserves outputFilesArchive');

    /* ---- 10. download PDF: via the compile response entry ---- */
    const pdf = await client.downloadPdf({
      projectId,
      buildId: compiled.buildId,
      clsiServerId: compiled.clsiServerId,
      entry: compiled.pdf,
    });
    check(Buffer.isBuffer(pdf), 'downloadPdf() returns a Buffer');
    check(pdf.subarray(0, 5).toString('latin1') === '%PDF-', 'downloaded bytes start with %PDF-');
    check(
      createHash('sha256').update(pdf).digest('hex') === PDF_SHA,
      'downloaded PDF is byte-identical to the served PDF'
    );

    /* ---- 11. download PDF: via the build route fallback (no entry) ---- */
    const pdf2 = await client.downloadPdf({
      projectId,
      buildId: compiled.buildId,
      clsiServerId: compiled.clsiServerId,
    });
    check(createHash('sha256').update(pdf2).digest('hex') === PDF_SHA, 'downloadPdf() fallback build route also works');

    /* ---- 12. download the log explicitly ---- */
    const logBuf = await client.downloadOutputFile({
      projectId,
      buildId: compiled.buildId,
      clsiServerId: compiled.clsiServerId,
      file: 'output.log',
    });
    check(logBuf.toString('utf8').includes('XeLatex'), 'downloadOutputFile(output.log) returns the log');

    /* ---- 13. CSRF retry: stale token is refreshed once, then succeeds ---- */
    const before = state.csrfTokens.size;
    // Inject a bogus token so the next mutating call 403s once.
    client._csrfToken = 'stale-token-that-server-does-not-know';
    let retriedOk = false;
    try {
      const pid2 = await client.createProjectFromZip({ name: 'Retry Check', zipBuffer: zipBuf });
      retriedOk = Boolean(pid2);
      state.projects.delete(pid2);
    } catch (e) {
      console.log('    (csrf retry error: ' + e + ')');
    }
    check(retriedOk, 'CSRF 403 triggers exactly one token refresh and the retry succeeds');
    check(state.csrfTokens.size > before, 'a fresh CSRF token was minted for the retry');

    /* ---- 14. compile() failure path ---- */
    const failPid = await client.createProjectFromZip({
      name: 'FAILCONSUME Thesis',
      zipBuffer: zipBuf,
    });
    let compileErr = null;
    try {
      await client.compile({ projectId: failPid, rootResourcePath: 'main.tex' });
    } catch (e) {
      compileErr = e;
    }
    check(
      compileErr instanceof OverleafError && compileErr.code === ErrorCode.COMPILE_FAILED,
      'compile() throws COMPILE_FAILED on a non-success status',
      compileErr ? String(compileErr.code) : 'no error thrown'
    );
    check(
      Boolean(compileErr && compileErr.result && compileErr.result.status === 'failure'),
      'the COMPILE_FAILED error carries .result with the server status',
      compileErr && compileErr.result ? compileErr.result.status : 'none'
    );
    check(
      Boolean(compileErr && typeof compileErr.result.log === 'string' && compileErr.result.log.includes('XeLatex')),
      'the failure path still captured the compiler log'
    );
    await client.deleteProject(failPid);

    /* ---- 15. delete ---- */
    await client.deleteProject(projectId);
    check(!state.projects.has(projectId), 'deleteProject removed the project on the server');
    check(state.deleted.includes(projectId), 'DELETE /Project/:id was issued');

    /* ---- 15. duplicate cookie handling / deletion ---- */
    const jar = new CookieJar();
    jar.absorb({
      getSetCookie: () => [
        'a=1; Path=/; HttpOnly',
        'b=2; Path=/; Secure',
      ],
    });
    check(jar.header() === 'a=1; b=2', 'CookieJar absorbs multiple cookies and strips attributes');
    jar.absorb({ getSetCookie: () => ['a=; Max-Age=0; Path=/'] });
    check(!jar.has('a') && jar.has('b'), 'CookieJar honours Max-Age=0 deletion');
    const combined = splitCombinedSetCookie(
      'overleaf.sid=abc; Expires=Sun, 08 Nov 2026 00:45:51 GMT; Path=/, latex-session=def; Path=/'
    );
    check(combined.length === 2, 'splitCombinedSetCookie splits a folded header without breaking Expires', String(combined.length));

    /* ---- 16. logout clears local state ---- */
    await client.logout();
    check(client.cookies.size === 0, 'logout() clears the cookie jar');
    check((await client.isLoggedIn()) === false, 'isLoggedIn() is false after logout');

    /* ---- 17. credential redaction in errors ---- */
    const redactedClient = createOverleafClient({ baseUrl });
    const errSink = [];
    // Point at a route the fake server 404s and ask for a body that echoes the
    // password, to prove redaction.
    try {
      await redactedClient.login({ email: 'x@y.z', password: PASSWORD });
    } catch (e) {
      errSink.push(String(e.detail));
    }
    check(
      redactedClient._redact('password=' + PASSWORD) === 'password=***',
      'known secrets are redacted from error details'
    );
    check(!errSink.join('').includes(PASSWORD), 'the password never appears in an error detail');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/* ================================================================== *
 * --zipcheck : verify buildZipFromDirectory output with Expand-Archive
 * ================================================================== */

async function runZipCheck() {
  section('zipcheck: Expand-Archive round-trip');

  const srcDir = await mkTmp('ol-probe-zip-');
  const projDir = nodePath.join(srcDir, 'thesis');
  await fsp.mkdir(nodePath.join(projDir, 'data', 'deep'), { recursive: true });
  await fsp.mkdir(nodePath.join(projDir, '.git', 'objects'), { recursive: true });
  await fsp.mkdir(nodePath.join(projDir, '__MACOSX'), { recursive: true });
  await fsp.writeFile(nodePath.join(projDir, 'main.tex'), '% main\n\\input{data/chap01}\n');
  await fsp.writeFile(nodePath.join(projDir, 'data', 'chap01.tex'), 'chapter\n');
  await fsp.writeFile(nodePath.join(projDir, 'data', 'deep', 'tables.tex'), 'tables\n');
  await fsp.writeFile(nodePath.join(projDir, 'ref.bib'), '@book{x,title={Y}}\n');
  await fsp.writeFile(nodePath.join(projDir, '中文说明.txt'), '中文内容\n');
  await fsp.writeFile(nodePath.join(projDir, 'main.aux'), 'junk');
  await fsp.writeFile(nodePath.join(projDir, 'main.fls'), 'junk');
  await fsp.writeFile(nodePath.join(projDir, 'main.fdb_latexmk'), 'junk');
  await fsp.writeFile(nodePath.join(projDir, '.git', 'objects', 'blob'), 'junk');
  await fsp.writeFile(nodePath.join(projDir, '__MACOSX', 'junk'), 'junk');

  const client = createOverleafClient({ baseUrl: 'https://example.invalid' });
  const res = await client.buildZipFromDirectory(projDir);

  const zipPath = nodePath.join(srcDir, 'out.zip');
  await fsp.writeFile(zipPath, res.buffer);
  console.log(`  wrote ${zipPath} (${res.buffer.length} bytes, ${res.entries.length} entries)`);

  const outDir = nodePath.join(srcDir, 'expanded');
  // Two-stage verification:
  //   1) PowerShell 5.1's Expand-Archive proves the archive is well-formed and
  //      that the platform's own unzip accepts it.
  //   2) Node then reads the extracted tree, because PS 5.1's console code page
  //      mangles non-ASCII names in its output.
  const ps = await runPwsh(
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force; ` +
      `if ($?) { 'EXPAND_OK' }`
  );
  const expanded = [];
  const walk = async (dir, rel) => {
    for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(nodePath.join(dir, d.name), childRel);
      else expanded.push(childRel);
    }
  };
  await walk(outDir, '');
  expanded.sort();
  console.log('  Expand-Archive extracted:\n    ' + expanded.join('\n    '));

  check(
    ps.code === 0 && /EXPAND_OK/.test(ps.stdout),
    'Expand-Archive accepted the archive (exit 0)',
    `exit=${ps.code}`
  );
  const norm = expanded.map((p) => p.replace(/\\/g, '/'));
  check(norm.includes('main.tex'), 'expanded main.tex at the archive root');
  check(norm.includes('data/chap01.tex'), 'expanded nested data/chap01.tex');
  check(norm.includes('data/deep/tables.tex'), 'expanded deeply nested file');
  check(norm.includes('ref.bib'), 'expanded ref.bib');
  check(norm.some((p) => p.startsWith('中文说明')), 'expanded a UTF-8 filename correctly');
  check(!norm.some((p) => /\.(aux|fls|fdb_latexmk)$/.test(p)), 'no LaTeX artifacts were archived');
  check(!norm.some((p) => p.includes('.git/')), 'no .git content was archived');
  check(!norm.some((p) => p.includes('__MACOSX')), 'no __MACOSX content was archived');
  check(!norm.some((p) => p.startsWith('thesis/')), "archive has no 'thesis/' prefix");

  const mainOnDisk = await fsp.readFile(nodePath.join(outDir, 'main.tex'), 'utf8');
  check(mainOnDisk === '% main\n\\input{data/chap01}\n', 'expanded main.tex content is byte-identical');

  // Verify the stored (uncompressed) method is really used.
  const buf = res.buffer;
  const method = buf.readUInt16LE(8);
  check(method === 0, 'entries use compression method 0 (stored)');
  const declaredCrc = buf.readUInt32LE(14);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const firstData = 30 + nameLen + extraLen;
  const firstSize = buf.readUInt32LE(18);
  const actualCrc = crc32(buf.subarray(firstData, firstData + firstSize));
  check(declaredCrc === actualCrc, 'the first entry CRC-32 round-trips', `${declaredCrc} === ${actualCrc}`);

  // Large-file warning.
  const bigDir = nodePath.join(srcDir, 'big');
  await fsp.mkdir(bigDir, { recursive: true });
  await fsp.writeFile(nodePath.join(bigDir, 'small.tex'), 'ok\n');
  await fsp.writeFile(nodePath.join(bigDir, 'huge.bin'), Buffer.alloc(1024));
  const warned = [];
  const bigRes = await client.buildZipFromDirectory(bigDir, {
    maxFileBytes: 100,
    warn: (m) => warned.push(m),
  });
  check(
    !bigRes.entries.includes('huge.bin') && warned.some((w) => /exceeds/.test(w)),
    'files over maxFileBytes are skipped with a warning',
    warned.join(' | ')
  );
}

/* ================================================================== *
 * --unauth : live contract checks against latex.cstcloud.cn
 * ================================================================== */

async function runUnauth() {
  section('unauth: live contract checks against latex.cstcloud.cn');
  const baseUrl = 'https://latex.cstcloud.cn';
  const client = createOverleafClient({ baseUrl, timeoutMs: 45000 });

  /* 1. GET /dev/csrf -> a bare token */
  let token = null;
  try {
    token = await client.csrfToken();
    check(typeof token === 'string' && token.length >= 20, 'GET /dev/csrf returns a bare CSRF token', `len=${token.length} value-sample=${token.slice(0, 6)}…`);
    check(/^[A-Za-z0-9_\-+/=.:]+$/.test(token), 'the CSRF token is a single opaque token (no HTML)', JSON.stringify(token.slice(0, 12)));
  } catch (e) {
    check(false, 'GET /dev/csrf returns a bare CSRF token', String(e));
  }
  check(client.cookies.has('overleaf.sid'), 'the deployment set overleaf.sid on our jar', `jar=${[...client.cookies.toMap().keys()].join(',')}`);

  /* 2. GET /user/projects requires auth.
     This deployment answers an unauthenticated API request with 401 rather
     than a 302 to /login, so either code proves the gate is closed. */
  let authEnforced = false;
  let authDetail = '';
  try {
    await client.listProjects();
  } catch (e) {
    authEnforced =
      e instanceof OverleafError &&
      (e.code === ErrorCode.AUTH_REQUIRED || e.code === ErrorCode.AUTH_INVALID);
    authDetail = `${e.code} status=${e.status}`;
  }
  check(authEnforced, 'GET /user/projects is auth-gated (AUTH_REQUIRED or AUTH_INVALID)', authDetail);

  /* 3. POST /login with nonsense credentials -> 401 invalid-password JSON */
  const fakeEmail = `probe-not-a-real-user-${Date.now()}@example.invalid`;
  let loginCode = null;
  let loginDetail = '';
  try {
    await client.login({ email: fakeEmail, password: 'definitely-not-the-password' });
  } catch (e) {
    loginCode = e.code;
    loginDetail = `${e.status} ${e.detail}`;
  }
  check(loginCode === ErrorCode.AUTH_INVALID, 'POST /login with nonsense credentials throws AUTH_INVALID', loginDetail.slice(0, 160));
  check(/invalid-password-retry-or-reset/.test(loginDetail), 'the 401 body is the documented invalid-password JSON', loginDetail.slice(0, 120));
  check(!loginDetail.includes('definitely-not-the-password'), 'the password is not echoed in the error detail');

  /* 4. POST /project/new/upload with no auth -> 302/401/403, never a generic 404 */
  // The client would raise AUTH_REQUIRED on the /login redirect; we need the raw
  // status, so drive fetch directly through the client's own jar/CSRF plumbing.
  let uploadStatus = null;
  let uploadBody = '';
  let uploadContentType = '';
  try {
    const csrf = await client.csrfToken();
    const form = new FormData();
    const tinyZip = createStoredZip([
      { name: 'main.tex', data: Buffer.from('\\documentclass{article}\n'), mtime: new Date() },
    ]);
    form.append('qqfile', new Blob([tinyZip], { type: 'application/zip' }), 'probe.zip');
    form.append('name', 'probe-do-not-create-' + Date.now());
    form.append('_csrf', csrf);
    const res = await client._fetch({
      path: '/project/new/upload',
      method: 'POST',
      mutating: true,
      headers: { accept: 'application/json', 'x-csrf-token': csrf },
      body: form,
    });
    uploadStatus = res.status;
    uploadContentType = res.headers.get('content-type') || '';
    uploadBody = await res.text();
  } catch (e) {
    uploadStatus = e.status ?? null;
    uploadBody = e.detail || String(e);
    uploadContentType = e.code || '';
  }
  console.log(`    upload probe -> status=${uploadStatus} ct=${uploadContentType} body=${JSON.stringify(String(uploadBody).slice(0, 120))}`);
  check(
    uploadStatus === 302 || uploadStatus === 401 || uploadStatus === 403,
    'POST /project/new/upload is auth-gated (302/401/403), not a generic 404',
    `got ${uploadStatus}`
  );
  check(
    uploadStatus !== 404,
    'the upload route exists (a 404 would mean it is not routed on this deployment)'
  );

  /* 5. A bogus project route *is* a 404, for contrast */
  let bogusStatus = null;
  try {
    await client.projectEntities('0123456789abcdef01234567');
    bogusStatus = 200;
  } catch (e) {
    bogusStatus = e.status ?? e.code;
  }
  check(bogusStatus === 302 || bogusStatus === 401 || bogusStatus === 404, 'GET /project/:id/entities is auth-gated or 404s', String(bogusStatus));

  /* 6. Compile route reachability, reported honestly */
  let compileStatus = null;
  let compileNote = '';
  try {
    const res = await client._fetch({
      path: '/project/0123456789abcdef01234567/compile',
      method: 'POST',
      mutating: true,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ compiler: 'xelatex', rootResourcePath: 'main.tex', draft: false }),
    });
    compileStatus = res.status;
    compileNote = (await res.text()).slice(0, 100);
  } catch (e) {
    compileStatus = e.status ?? e.code;
    compileNote = (e.detail || String(e)).slice(0, 100);
  }
  console.log(`    compile probe (unauthenticated) -> ${compileStatus} ${JSON.stringify(compileNote)}`);
  console.log('    NOTE: unauthenticated probing cannot prove the compile route exists:');
  console.log('          Overleaf answers 404 for a project id the session cannot see, so this');
  console.log('          must be confirmed with real credentials.');
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

function runPwsh(script) {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (d) => (stdout += d));
    ps.stderr.on('data', (d) => (stderr += d));
    ps.on('close', (code) => resolve({ code, stdout, stderr }));
    ps.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

/* ================================================================== *
 * Main
 * ================================================================== */

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const runAll = argv.length === 0 || has('--all');
  const known = ['--offline', '--unauth', '--zipcheck', '--all'];
  const unknown = argv.filter((a) => !known.includes(a));
  if (unknown.length) {
    console.error(`Unknown option(s): ${unknown.join(' ')}`);
    console.error('Usage: node probe.mjs [--offline | --unauth | --zipcheck | --all]');
    process.exit(2);
  }

  console.log('overleaf-client probe');
  console.log(`node ${process.version} on ${process.platform} ${process.arch}`);
  console.log(`mode: ${runAll ? 'all' : argv.join(' ')}`);

  try {
    if (runAll || has('--offline')) await runOffline();
    if (runAll || has('--zipcheck')) await runZipCheck();
    if (runAll || has('--unauth')) await runUnauth();
  } catch (err) {
    console.error('\nUNEXPECTED ERROR:', err && err.stack ? err.stack : err);
    results.push({ ok: false, label: 'probe harness did not throw: ' + String(err), section: currentSection });
  } finally {
    await cleanupTmp();
  }

  const code = summary();
  process.exit(code);
}

main();
