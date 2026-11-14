import { describe, expect, test } from 'vitest'
import { CODE_LANGUAGES, highlight, languageLabel } from '../../src/renderer/highlight'

/** The text under the spans, unescaped, which must always be exactly the code. */
const textOf = (html: string): string =>
  html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** Every piece of the code that got a class, as [class, text]. */
const tokens = (html: string): Array<[string, string]> =>
  [...html.matchAll(/<span class="tok-([a-z]+)">([^<]*)<\/span>/g)].map((m) => [m[1], textOf(m[2])])

const has = (html: string, cls: string, text: string): boolean => tokens(html).some(([c, t]) => c === cls && t === text)

describe('JSON', () => {
  const code = '{\n  "name": "patchbay",\n  "count": -3.5e2,\n  "ok": true,\n  "none": null,\n  "list": ["a", 1]\n}'
  const html = highlight(code, 'json')

  test('keys, strings, numbers and literals each get their own class', () => {
    expect(has(html, 'key', '"name"')).toBe(true)
    expect(has(html, 'string', '"patchbay"')).toBe(true)
    expect(has(html, 'number', '-3.5e2')).toBe(true)
    expect(has(html, 'literal', 'true')).toBe(true)
    expect(has(html, 'literal', 'null')).toBe(true)
    expect(has(html, 'string', '"a"')).toBe(true)
  })

  test('the text is unchanged', () => {
    expect(textOf(html)).toBe(code)
  })
})

describe('other languages', () => {
  test('JavaScript', () => {
    const html = highlight('// note\nconst greet = (name) => `hi ${name}`\nawait fetch("/x")\nnew Map()', 'js')
    expect(has(html, 'comment', '// note')).toBe(true)
    expect(has(html, 'keyword', 'const')).toBe(true)
    expect(has(html, 'keyword', 'await')).toBe(true)
    expect(has(html, 'func', 'fetch')).toBe(true)
    expect(has(html, 'string', '"/x"')).toBe(true)
    expect(has(html, 'type', 'Map')).toBe(true)
  })

  test('TypeScript knows its own words', () => {
    const html = highlight('interface A { b: string }', 'ts')
    expect(has(html, 'keyword', 'interface')).toBe(true)
    expect(has(html, 'type', 'string')).toBe(true)
  })

  test('Python', () => {
    const html = highlight('def f(x):\n    # why\n    return None if x else """doc"""', 'python')
    expect(has(html, 'keyword', 'def')).toBe(true)
    expect(has(html, 'func', 'f')).toBe(true)
    expect(has(html, 'comment', '# why')).toBe(true)
    expect(has(html, 'literal', 'None')).toBe(true)
    expect(has(html, 'string', '"""doc"""')).toBe(true)
  })

  test('shell variables, flags and comments', () => {
    const html = highlight('npm run build --watch # go\necho "$HOME" ${USER}', 'bash')
    expect(has(html, 'attr', '--watch')).toBe(true)
    expect(has(html, 'comment', '# go')).toBe(true)
    expect(has(html, 'var', '${USER}')).toBe(true)
  })

  test('HTML tags, attributes and values', () => {
    const html = highlight('<a href="/x" hidden>go</a><!-- c -->', 'html')
    expect(has(html, 'tag', 'a')).toBe(true)
    expect(has(html, 'attr', 'href')).toBe(true)
    expect(has(html, 'string', '"/x"')).toBe(true)
    expect(has(html, 'comment', '<!-- c -->')).toBe(true)
    expect(textOf(html)).toBe('<a href="/x" hidden>go</a><!-- c -->')
  })

  test('CSS properties, but not selectors that look like them', () => {
    const html = highlight('a:hover { color: #fff; margin: 0 2px }', 'css')
    expect(has(html, 'attr', 'color')).toBe(true)
    expect(has(html, 'attr', 'margin')).toBe(true)
    expect(has(html, 'number', '#fff')).toBe(true)
    expect(has(html, 'attr', 'a')).toBe(false)
  })

  test('SQL keywords in any case', () => {
    const html = highlight("SELECT id FROM users where name = 'x'", 'sql')
    expect(has(html, 'keyword', 'SELECT')).toBe(true)
    expect(has(html, 'keyword', 'where')).toBe(true)
    expect(has(html, 'string', "'x'")).toBe(true)
  })

  test('YAML keys and values', () => {
    const html = highlight('name: app\nlist:\n  - port: 80\n    on: true', 'yaml')
    expect(has(html, 'key', 'name')).toBe(true)
    expect(has(html, 'key', 'port')).toBe(true)
    expect(has(html, 'number', '80')).toBe(true)
    expect(has(html, 'literal', 'true')).toBe(true)
  })

  test('diff lines', () => {
    const html = highlight('@@ -1 +1 @@\n-old\n+new\n same', 'diff')
    expect(has(html, 'meta', '@@ -1 +1 @@')).toBe(true)
    expect(has(html, 'del', '-old')).toBe(true)
    expect(has(html, 'add', '+new')).toBe(true)
  })
})

describe('safety and fallbacks', () => {
  test('markup in code is escaped in every language', () => {
    const evil = '<img src=x onerror=alert(1)> "</span><script>x</script>'
    for (const lang of ['json', 'js', 'python', 'bash', 'html', 'css', 'sql', 'yaml', 'diff', 'go', 'nope', '']) {
      const html = highlight(evil, lang)
      expect(html.replace(/<\/?span[^>]*>/g, '')).not.toMatch(/[<>]/)
      expect(textOf(html)).toBe(evil)
    }
  })

  test('an unknown language or a huge block comes back plain', () => {
    expect(highlight('a < b', 'brainfudge')).toBe('a &lt; b')
    expect(highlight('x'.repeat(50000), 'js')).not.toContain('<span')
  })

  test('an unclosed string stops at its line', () => {
    const html = highlight('const a = "open\nconst b = 1', 'js')
    expect(has(html, 'keyword', 'const')).toBe(true)
    expect(tokens(html).filter(([c]) => c === 'keyword')).toHaveLength(2)
  })

  test('labels for the block header', () => {
    expect(languageLabel('json')).toBe('JSON')
    expect(languageLabel('TS')).toBe('TypeScript')
    expect(languageLabel('')).toBe('Code')
    expect(languageLabel('haskell')).toBe('haskell')
  })

  test('the toolbar only offers languages that are colored or plain on purpose', () => {
    for (const { name, label } of CODE_LANGUAGES) expect(name ? languageLabel(name) : 'Plain text').toBe(label)
    expect(CODE_LANGUAGES[0]).toEqual({ name: 'json', label: 'JSON' })
  })
})
