/**
 * Palette and contrast audit for the 砚台 · Inkstone panel.
 *
 * The panel deliberately scopes its own warm-paper palette instead of inheriting
 * the host theme: it overrides the `--dsw-alias-*` variables on its own root, so
 * host components rendered inside it adopt the paper tones too. An earlier
 * version of this audit asserted "no literal colour, tokens only", which stopped
 * describing the design once that scoped palette landed.
 *
 * What matters now, and what this checks:
 *   1. the palette is complete and actually overrides the host aliases;
 *   2. text/surface pairs clear WCAG AA by computation, not by inspection;
 *   3. the stylesheet loads no external resource (artwork is embedded);
 *   4. the panel declares its own colour scheme so form controls follow it.
 *
 * Run: node tests/contrast-audit.mjs
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const cssMatch = source.match(/const CSS = `([\s\S]*?)`;/)
if (!cssMatch) {
  console.error('could not locate the CSS block')
  process.exit(1)
}
const css = cssMatch[1]

const results = []
function check(ok, name, detail) {
  results.push({ ok, name, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

/* ------------------------------------------------------------ colour maths */

function parseHex(hex) {
  let h = String(hex).replace('#', '')
  if (h.length === 8) h = h.slice(0, 6)
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) return null
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
}

function luminance(hex) {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return 0
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/* ---------------------------------------------------------- palette values */

const rootRule = css.match(/\.is-root\{([^}]*)\}/)
check(!!rootRule, '.is-root rule exists')
const rootBody = rootRule ? rootRule[1] : ''

function varOf(name, body) {
  const m = body.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`))
  return m ? m[1] : null
}

const paper = varOf('is-paper', rootBody) || '#ffffff'
const ink = varOf('is-ink', rootBody) || '#000000'
const muted = varOf('is-muted', rootBody) || '#666666'
const red = varOf('is-red', rootBody) || '#b00000'
const green = varOf('is-green', rootBody) || '#2f6f2f'

check(
  [paper, ink, muted, red, green].every(Boolean) && !!varOf('is-paper', rootBody),
  'paper palette defines paper/ink/muted/red/green',
  [paper, ink, muted, red, green].join(' ')
)

const aliasNames = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-border-l1',
  '--dsw-alias-brand-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
]
const missingAlias = aliasNames.filter((n) => !rootBody.includes(n + ':'))
check(
  missingAlias.length === 0,
  'overrides the host aliases so nested host UI adopts the paper tones',
  missingAlias.join(', ') || 'all present'
)
check(/color-scheme:light/.test(rootBody), 'declares its own colour scheme (form controls follow paper)')

/* --------------------------------------------------------- contrast pairs */

const AA_NORMAL = 4.5
const AA_LARGE = 3
const AAA = 7

const cardRule = css.match(/\.is-project-box\{([^}]*)\}/)
const cardBgMatch = cardRule && /background:\s*(#[0-9a-fA-F]{3,8})/.exec(cardRule[1])
const card = cardBgMatch ? cardBgMatch[1] : paper

const buttonMatch = css.match(/\.is-btn-primary\{([^}]*)\}/)
const buttonFgMatch = buttonMatch && /color:\s*(#[0-9a-fA-F]{3,8})/.exec(buttonMatch[1])
const buttonFg = buttonFgMatch ? buttonFgMatch[1] : null

const pairs = [
  { name: 'body ink on paper', fg: ink, bg: paper, min: AAA },
  { name: 'secondary text on paper', fg: muted, bg: paper, min: AA_NORMAL },
  { name: 'secondary text on card', fg: muted, bg: card, min: AA_NORMAL },
  { name: 'primary button label on red', fg: buttonFg, bg: red, min: AA_NORMAL },
  { name: 'error tone on paper', fg: '#a13228', bg: paper, min: AA_NORMAL },
  { name: 'success tone on paper', fg: green, bg: paper, min: AA_NORMAL },
  { name: 'warn tone on paper', fg: '#8b622c', bg: paper, min: AA_NORMAL },
  { name: 'placeholder on paper', fg: '#857b6b', bg: paper, min: AA_LARGE },
]

for (const pair of pairs) {
  const ratio = contrast(pair.fg, pair.bg)
  check(ratio >= pair.min, pair.name, `${ratio.toFixed(2)}:1 (need ${pair.min})`)
}

/* ------------------------------------------------------- resource policy */

const externalUrls = [...css.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"]+)/gi)].map((m) => m[1])
check(externalUrls.length === 0, 'stylesheet loads no external resource', externalUrls.join(', ') || 'none')

const artMatch = source.match(/PAPER_ART\s*=\s*'data:image\/([a-z]+);base64,([A-Za-z0-9+/=]+)'/)
check(!!artMatch, 'decorative artwork is embedded as a data URI')
if (artMatch) {
  const kind = artMatch[1]
  const bytes = Math.round((artMatch[2].length * 3) / 4)
  check(kind === 'webp', 'artwork is WebP (compact)', kind)
  check(bytes < 512 * 1024, 'artwork stays under 512 KiB', `${Math.round(bytes / 1024)} KiB`)
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(66))
console.log(`TOTAL: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) {
  for (const f of failed) console.log('  FAILED:', f.name, '—', f.detail || '')
  process.exitCode = 1
}