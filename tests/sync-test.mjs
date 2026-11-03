/**
 * Tests for lib/sync-client.js — the logic that does not need the network.
 *
 * The live paths (create project, compile, read log) were proven against the
 * deployment by the probe scripts; these are the pure pieces that must be
 * correct for the loop to work, and that regress most easily.
 *
 * Run: node sync-test.mjs
 */
import {
  parseLatexLog,
  logDigest,
  splitCompileResponse,
  extractCompileJson,
  normaliseOutputUrl,
  projectNameFor,
} from '../lib/sync-client.js'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Path from 'node:path'

const results = []
function check(ok, name, detail) {
  results.push({ ok, name, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

/* ------------------------------------------------------- log parsing */

const LOG = [
  'This is XeTeX, Version 3.141592653-2.6-0.999995 (TeX Live 2024)',
  '(./main.tex',
  'LaTeX2e <2023-11-01>',
  '! Undefined control sequence.',
  'l.3 \\undefinedcommand',
  '                   {boom}',
  '',
  '! LaTeX Error: File `missing.sty\' not found.',
  '',
  'Type X to quit or <RETURN> to proceed,',
  'LaTeX Warning: There were undefined references.',
  'LaTeX Warning: Reference `fig:one\' on page 1 undefined on input line 42.',
  'Overfull \\hbox (12.34567pt too wide) in paragraph at lines 50--52',
  'Missing character: There is no 中 in font [lmroman10-regular]!',
  'Package hyperref Warning: Token not allowed in a PDF string (Unicode).',
  'Output written on output.pdf (3 pages, 12345 bytes).',
].join('\n')

{
  const { entries, summary } = parseLatexLog(LOG)
  check(entries.length >= 5, 'log parsing finds the diagnostics', `${entries.length} entries`)
  check(summary.errors >= 2, 'counts errors', JSON.stringify(summary))
  check(summary.warnings >= 2, 'counts warnings', `${summary.warnings}`)
  check(summary.badness >= 1, 'counts overfull/underfull', `${summary.badness}`)
  check(summary.missingGlyphs >= 1, 'counts missing glyphs', `${summary.missingGlyphs}`)

  const undef = entries.find((e) => /Undefined control sequence/.test(e.text))
  check(!!undef, 'captures the undefined control sequence')
  check(undef && undef.kind === 'error', 'classifies it as an error')
  check(undef && /undefinedcommand/.test(undef.context), 'keeps the offending line as context', undef && undef.context.slice(0, 40))

  const missing = entries.find((e) => /not found/.test(e.text))
  check(!!missing && missing.kind === 'missing-file', 'classifies a missing file')
}

{
  const { entries } = parseLatexLog('')
  check(entries.length === 0, 'an empty log yields no entries')
}

{
  const { entries } = parseLatexLog('Output written on output.pdf (1 page).')
  check(entries.length === 0, 'a clean log yields no entries')
}

/* ------------------------------------------------------------- digest */

{
  const digest = logDigest(LOG)
  check(digest.includes('Undefined control sequence'), 'digest includes the error text')
  check(digest.includes('undefinedcommand'), 'digest includes the context line')
  check(digest.length <= 4000, 'digest respects the default budget', `${digest.length} chars`)

  const clean = logDigest('all good\nnothing to see')
  check(clean.includes('all good'), 'a clean log falls back to the tail')
}

/* --------------------------------------------- compile response splitting */

{
  // The deployment answers 102 and then writes a SECOND response on the same
  // connection. The payload is the final body.
  const raw =
    'HTTP/1.1 102 Processing\r\n\r\n' +
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 61\r\n\r\n' +
    '{"status":"success","outputFiles":[{"path":"output.pdf","url":"/p/b"}]}'
  const split = splitCompileResponse(raw)
  check(split.statusLine.startsWith('HTTP/1.1 102'), 'keeps the interim status line', split.statusLine)
  const json = extractCompileJson(split)
  check(!!json, 'extracts the compile JSON')
  check(json && json.status === 'success', 'reads the status', json && json.status)
  check(json && json.outputFiles && json.outputFiles.length === 1, 'reads outputFiles')
}

{
  // A plain single-response body must also parse.
  const raw = 'HTTP/1.1 200 OK\r\n\r\n{"status":"failure","outputFiles":[]}'
  const json = extractCompileJson(splitCompileResponse(raw))
  check(json && json.status === 'failure', 'handles a single 200 response')
}

{
  // Trailing chunked framing after the JSON must not break extraction.
  const raw = 'HTTP/1.1 200 OK\r\n\r\n{"status":"success","outputFiles":[]}\r\n0\r\n\r\n'
  const json = extractCompileJson(splitCompileResponse(raw))
  check(json && json.status === 'success', 'survives trailing framing')
}

{
  // Braces inside strings must not confuse the brace walker.
  const raw = 'HTTP/1.1 200 OK\r\n\r\n{"status":"failure","note":"a { brace } in text","outputFiles":[]}'
  const json = extractCompileJson(splitCompileResponse(raw))
  check(json && json.note === 'a { brace } in text', 'brace matching ignores braces inside strings')
}

{
  check(extractCompileJson({ payload: 'no json here', bodyHead: '' }) === null, 'returns null when there is no JSON')
}

/* ------------------------------------------------------- output URL form */

{
  check(normaliseOutputUrl('/project/a/user/b/build/c/output/output.log') === '/project/a/user/b/build/c/output/output.log', 'same-origin path kept')
  check(normaliseOutputUrl('https://cdn.example.com/x/y.pdf?t=1') === '/x/y.pdf?t=1', 'absolute URL reduced to a path')
  check(normaliseOutputUrl(null) === '', 'null becomes empty')
  check(normaliseOutputUrl('relative/x.log') === 'relative/x.log', 'relative value passed through')
}

/* ------------------------------------------------------- project naming */

{
  const a = projectNameFor('D:\\Paper\\thesis')
  check(a.endsWith('(DSH)'), 'default name is stable and marked', a)
  check(a === projectNameFor('D:\\Paper\\thesis'), 'same folder yields the same name (so syncs replace, not duplicate)')
  check(projectNameFor('D:\\Paper\\thesis', 'My Thesis') === 'My Thesis', 'an explicit name wins')
  check(projectNameFor('/home/u/paper/') === 'paper (DSH)', 'trailing separator ignored', projectNameFor('/home/u/paper/'))
}

/* -------------------------------------------------- module stays loadable */

{
  const tmp = Path.join(process.env.TEMP || '/tmp', 'olw-sync-check.mjs')
  writeFileSync(tmp, 'export {}')
  try {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../lib/sync-client.js', import.meta.url))], { stdio: 'pipe' })
    check(true, 'sync-client.js parses as a module')
  } catch (err) {
    check(false, 'sync-client.js parses as a module', String(err.message).slice(0, 100))
  }
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(66))
console.log(`TOTAL: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) {
  for (const f of failed) console.log('  FAILED:', f.name, '—', f.detail || '')
  process.exitCode = 1
}
