// Pack the real thesis project and verify the archive independently.
import { createOverleafClient } from '../lib/overleaf-client.js'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import Path from 'node:path'
import os from 'node:os'

const dir = process.argv[2] || 'D:\\Paper\\thesis'
const client = createOverleafClient({ baseUrl: 'https://latex.cstcloud.cn' })

const warnings = []
const result = await client.buildZipFromDirectory(dir, {
  warn: (m) => warnings.push(m),
})

console.log('entries :', result.entries.length, 'bytes:', result.buffer.length)
console.log('skipped :', result.skipped.length, 'warnings:', warnings.length)
console.log('\nentries that will be uploaded:')
for (const name of result.entries.sort()) console.log('  ', name)

const out = Path.join(os.tmpdir(), 'thesis-pack-check.zip')
writeFileSync(out, result.buffer)

// Verify with PowerShell's own zip reader — an independent implementation.
const ps = `
$ErrorActionPreference='Stop'
$dst = Join-Path $env:TEMP 'thesis-pack-extract'
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Expand-Archive -LiteralPath '${out.replace(/'/g, "''")}' -DestinationPath $dst -Force
$files = Get-ChildItem $dst -Recurse -File
"extracted files: $($files.Count)"
"total bytes: $((($files | Measure-Object Length -Sum).Sum))"
$files | ForEach-Object { $_.FullName.Substring($dst.Length+1) } | Sort-Object
`
try {
  const consoleOut = execFileSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  console.log('\n--- PowerShell Expand-Archive verification ---')
  console.log(consoleOut.trim())
  console.log('\n[PASS] the archive is a valid zip readable by an independent implementation')
} catch (err) {
  console.error('\n[FAIL] Expand-Archive could not read the archive:', err.message)
  process.exitCode = 1
}

// Artifact exclusion must hold for the real project.
const present = new Set(result.entries)
const mustBeAbsent = ['main.aux', 'main.log', 'main.synctex.gz', 'main.out', 'main.toc']
const leaked = mustBeAbsent.filter((n) => present.has(n))
console.log('\nartifact leakage:', leaked.length ? leaked.join(', ') : 'none')
if (leaked.length) process.exitCode = 1

const mustBePresent = ['main.tex', 'ref.bib', 'hduthesis.cls', 'data/chap01.tex']
const missing = mustBePresent.filter((n) => !present.has(n))
console.log('required files present:', missing.length ? 'MISSING ' + missing.join(', ') : 'all present')
if (missing.length) process.exitCode = 1

console.log('\nwarnings:', warnings.length ? '\n  ' + warnings.join('\n  ') : 'none')
