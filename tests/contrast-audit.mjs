/**
 * Contrast audit for the workbench stylesheet.
 *
 * The first build put secondary text on a raised card and inherited the base
 * foreground on a nested surface, which made hint text and a button label
 * unreadable in dark mode. This checks the rules that caused it:
 *   1. no literal hex/rgb colours (every colour must be a theme token),
 *   2. every `color:` names a token (never `inherit` on a known-bad surface),
 *   3. text-bearing rules use a foreground token that pairs with their
 *      background token,
 *   4. `placeholder` is not left to the browser default.
 *
 * Run: node contrast-audit.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const cssMatch = src.match(/const CSS = `([\s\S]*?)`;/)
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

/* 1. no literal colours */
const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g)].map((m) => m[0])
check(literals.length === 0, 'no literal colours in the stylesheet', literals.join(', ') || 'none')

/* 2. every colour declaration uses a token */
const decls = [...css.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)].map((m) => ({
  prop: m[1].trim(),
  value: m[2].trim(),
}))
const colourProps = decls.filter((d) => /^(color|background|background-color|border-color|border|outline)$/.test(d.prop))
// `border: 1px solid transparent` carries no colour decision; only a border
// declaration that names a real colour must be tokenised.
const untokened = colourProps.filter(
  (d) =>
    /var\(--dsw-alias-/.test(d.value) === false &&
    !/^(none|transparent|0|currentColor)$/.test(d.value) &&
    !/^[\d.]+px\s+\w+\s+transparent$/.test(d.value)
)
check(untokened.length === 0, 'every colour declaration uses a --dsw-alias-* token', untokened.map((d) => `${d.prop}:${d.value}`).join('; ') || 'none')

/* 3. no rule sets colour to inherit/initial (the shell owns the base pair) */
check(!/color\s*:\s*inherit/i.test(css), 'no `color: inherit` (which broke the dark-mode button)')

/* 4. placeholder is themed */
check(/::placeholder\{[^}]*color\s*:\s*var\(--dsw-alias-label-secondary\)/.test(css), 'placeholder text is themed')

/* 5. the primary button foreground pairs with the brand background */
const primaryBtn = css.match(/\.is-btn-primary\{([^}]*)\}/)
check(!!primaryBtn, 'primary button rule exists')
if (primaryBtn) {
  const body = primaryBtn[1]
  check(/background\s*:\s*var\(--dsw-alias-brand-primary\)/.test(body), 'primary button uses the brand background token')
  check(/color\s*:\s*var\(--dsw-alias-bg-base\)/.test(body), 'primary button foreground is the base background token (max contrast pair)')
}

/* 6. surfaces that hold text declare a matching foreground.
   `.is-input` shares a grouped rule with `.is-select`, so match the selector
   anywhere in a comma-separated selector list. A rule may omit `color` only
   when an ancestor already declares the paired token, which is why the root
   rule is checked separately below. */
const textSurfaceRules = ['.is-notice', '.is-input']
for (const sel of textSurfaceRules) {
  const escaped = sel.replace(/\./g, '\\.')
  const rule = css.match(new RegExp('(?:^|\\n)[^\\n{}]*' + escaped + '[^{]*\\{([^}]*)\\}'))
  if (!rule) {
    check(false, `${sel} rule exists`)
    continue
  }
  const hasBg = /background\s*:\s*var\(--dsw-alias-bg-(base|layer-1|layer-2)\)/.test(rule[1])
  const hasFg = /color\s*:\s*var\(--dsw-alias-label-primary\)/.test(rule[1])
  check(hasBg && hasFg, `${sel} declares both a surface token and the primary label token`)
}

/* 6b. the root declares the inherited pair every bare text element relies on. */
{
  const root = css.match(/\.is-root\{([^}]*)\}/)
  check(
    !!root &&
      /background\s*:\s*var\(--dsw-alias-bg-base\)/.test(root[1]) &&
      /color\s*:\s*var\(--dsw-alias-label-primary\)/.test(root[1]),
    '.is-root declares the base surface + primary label pair (inherited text stays legible)',
  )
}

/* 7. hint/secondary text uses the secondary label token on a card */
const hint = css.match(/\.is-hint\{([^}]*)\}/)
check(!!hint && /color\s*:\s*var\(--dsw-alias-label-secondary\)/.test(hint[1]), 'hint text uses the secondary label token')

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(66))
console.log(`TOTAL: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) process.exitCode = 1
