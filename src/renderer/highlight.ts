/**
 * Colors code in notes and chat, with no library behind it. A language is a short list of rules, tried in order at
 * every position, and whatever no rule takes stays plain. The result is escaped text in spans that only carry a
 * class, so it passes the sanitizer, which forbids inline styles.
 */

/** A class for the match, null for plain text, or a function that returns finished HTML. */
type Paint = string | null | ((match: string) => string)
/** Every pattern is sticky, so it's only ever tried at the position being read. */
type Rule = [RegExp, Paint]

/** Longer than this is shown plain, so a huge paste can't stall a redraw. */
const LIMIT = 40000

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const span = (cls: string | null, text: string): string => (cls ? `<span class="tok-${cls}">${escapeHtml(text)}</span>` : escapeHtml(text))

function paint(code: string, rules: Rule[]): string {
  let out = ''
  let plain = ''
  let i = 0
  scan: while (i < code.length) {
    for (const [re, how] of rules) {
      re.lastIndex = i
      const m = re.exec(code)
      if (!m || !m[0]) continue
      out += escapeHtml(plain)
      plain = ''
      out += typeof how === 'function' ? how(m[0]) : span(how, m[0])
      i += m[0].length
      continue scan
    }
    plain += code[i++]
  }
  return out + escapeHtml(plain)
}

const SPACE: Rule = [/\s+/y, null]
const LINE_SLASH: Rule = [/\/\/.*/y, 'comment']
const BLOCK: Rule = [/\/\*[\s\S]*?(?:\*\/|$)/y, 'comment']
// A hash only starts a comment at the start of a word, which leaves `$#`, `a#b` and URL fragments alone.
const LINE_HASH: Rule = [/(?<![^\s;(])#.*/y, 'comment']
// A string that never closes still ends at the line, so one stray quote can't color the rest of the block.
const DOUBLE: Rule = [/"(?:[^"\\\n]|\\.)*"?/y, 'string']
const SINGLE: Rule = [/'(?:[^'\\\n]|\\.)*'?/y, 'string']
const BACKTICK: Rule = [/`(?:[^`\\]|\\[\s\S])*`?/y, 'string']
const NUMBER: Rule = [/(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y, 'number']
const PUNCT: Rule = [/[{}()[\];,.:<>=+\-*/%!&|^~?\\]+/y, 'punct']

const words = (list: string): Set<string> => new Set(list.split(' ').filter(Boolean))

interface Spec {
  keywords: string
  literals?: string
  types?: string
  /** Comments and strings, and anything else that has to be seen before a word is. */
  first: Rule[]
  /** Keywords match in any case, as in SQL. */
  fold?: boolean
  /** A capitalized name is colored as a type. */
  capsAreTypes?: boolean
  word?: RegExp
}

/** The usual shape of a programming language: comments, strings, numbers, then words sorted by what they are. */
function wordy(spec: Spec): Rule[] {
  const keywords = words(spec.keywords)
  const literals = words(spec.literals ?? '')
  const types = words(spec.types ?? '')
  const kind = (w: string): string | null => {
    const k = spec.fold ? w.toLowerCase() : w
    return keywords.has(k) ? 'keyword' : literals.has(k) ? 'literal' : types.has(k) ? 'type' : null
  }
  const word = spec.word ?? /[A-Za-z_$][\w$]*/y
  const called = new RegExp(`${word.source}(?=[ \\t]*\\()`, 'y')
  const named = (w: string): string | null => (spec.capsAreTypes && /^[A-Z]/.test(w) && /[a-z]/.test(w) ? 'type' : null)
  return [
    SPACE,
    ...spec.first,
    NUMBER,
    [called, (w) => span(kind(w) ?? named(w) ?? 'func', w)],
    [word, (w) => span(kind(w) ?? named(w), w)],
    PUNCT
  ]
}

const JS_KEYWORDS =
  'as async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'
const JS_LITERALS = 'true false null undefined NaN Infinity'
const DECORATOR: Rule = [/@[A-Za-z_][\w.]*/y, 'meta']

const javascript = wordy({ keywords: JS_KEYWORDS, literals: JS_LITERALS, first: [LINE_SLASH, BLOCK, DOUBLE, SINGLE, BACKTICK, DECORATOR], capsAreTypes: true })

const typescript = wordy({
  keywords: `${JS_KEYWORDS} abstract asserts declare enum implements infer interface keyof namespace override private protected public readonly satisfies type`,
  literals: JS_LITERALS,
  types: 'string number boolean any unknown never object symbol bigint',
  first: [LINE_SLASH, BLOCK, DOUBLE, SINGLE, BACKTICK, DECORATOR],
  capsAreTypes: true
})

const python = wordy({
  keywords:
    'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield',
  literals: 'True False None self cls',
  types: 'int str float bool list dict set tuple bytes object',
  first: [
    LINE_HASH,
    [/[rbfuRBFU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y, 'string'],
    [/[rbfuRBFU]{0,2}"(?:[^"\\\n]|\\.)*"?/y, 'string'],
    [/[rbfuRBFU]{0,2}'(?:[^'\\\n]|\\.)*'?/y, 'string'],
    DECORATOR
  ],
  capsAreTypes: true
})

const shell = wordy({
  keywords: 'if then else elif fi for while until do done case esac in function select return exit export local readonly declare unset source param foreach',
  literals: 'true false',
  first: [
    LINE_HASH,
    [/<#[\s\S]*?(?:#>|$)/y, 'comment'],
    [/\$(?:\{[^}\n]*\}?|[A-Za-z_][\w:]*|[0-9@#?*!$-])/y, 'var'],
    [/"(?:[^"\\]|\\[\s\S])*"?/y, 'string'],
    [/'[^']*'?/y, 'string'],
    [/(?<=\s)--?[A-Za-z][\w-]*/y, 'attr']
  ],
  word: /[A-Za-z_][\w.-]*/y
})

const sql = wordy({
  keywords:
    'select from where and or not in is as join inner left right full outer cross on group by order having limit offset insert into values update set delete create table alter drop index view primary key foreign references unique default constraint distinct union all exists between like case when then else end asc desc with returning if begin commit rollback transaction add column',
  literals: 'true false null',
  types: 'int integer bigint smallint text varchar char boolean bool date time timestamp timestamptz numeric decimal real float double serial uuid json jsonb blob',
  first: [[/--.*/y, 'comment'], BLOCK, [/'(?:[^']|'')*'?/y, 'string'], DOUBLE, BACKTICK],
  fold: true
})

/** Close enough for the C family, Go, Rust, Java, C#, Kotlin, Swift and PHP to read well. */
const generic = wordy({
  keywords:
    'abstract as async await break case catch class const continue default defer do else enum export extends final finally fn for foreach func function go if impl implements import in interface internal let loop match mod mut namespace new override package private protected pub public return static struct super switch this throw throws trait try type typedef union unsafe use using var virtual where while yield self',
  literals: 'true false null nil nullptr None',
  types: 'int long short byte char float double bool boolean string void uint i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 usize isize str',
  first: [LINE_SLASH, BLOCK, [/^[ \t]*#[A-Za-z]+.*$/my, 'meta'], DOUBLE, SINGLE, BACKTICK, DECORATOR],
  capsAreTypes: true
})

const json: Rule[] = [
  SPACE,
  LINE_SLASH,
  BLOCK,
  [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, 'key'],
  DOUBLE,
  SINGLE,
  [/[A-Za-z_$][\w$]*(?=\s*:)/y, 'key'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, 'number'],
  [/(?:true|false|null)\b/y, 'literal'],
  [/[{}[\],:]/y, 'punct']
]

const yaml: Rule[] = [
  SPACE,
  LINE_HASH,
  [/^(?:---|\.\.\.).*$/my, 'meta'],
  [/(?<=^[ \t]*(?:-[ \t]+)*)(?:"[^"\n]*"|'[^'\n]*'|[^\s#:'"{}[\],&*!|>-][^:#\n]*?)(?=[ \t]*:(?:[ \t]|$))/my, 'key'],
  DOUBLE,
  SINGLE,
  [/(?:true|false|null|yes|no|on|off|~)(?=[ \t]*(?:#|,|\]|\}|$))/imy, 'literal'],
  [/[-+]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?(?=[ \t]*(?:#|,|\]|\}|$))/my, 'number'],
  [/[&*][\w-]+/y, 'var'],
  [/[-:,[\]{}|>]/y, 'punct'],
  [/[^\s#:,[\]{}"']+/y, null]
]

/** Settings files that are a key, an equals sign and a value: TOML, INI, .env and the like. */
const keyValue: Rule[] = [
  SPACE,
  LINE_HASH,
  [/^[ \t]*;.*$/my, 'comment'],
  [/^[ \t]*\[.*\][ \t]*$/my, 'meta'],
  [/(?<=^[ \t]*)[\w.-]+(?=[ \t]*=)/my, 'key'],
  [/"""[\s\S]*?(?:"""|$)/y, 'string'],
  DOUBLE,
  SINGLE,
  [/(?:true|false)\b/y, 'literal'],
  NUMBER,
  [/[=,[\]{}]/y, 'punct'],
  [/[^\s=,[\]{}"'#]+/y, null]
]

const attributes: Rule[] = [
  SPACE,
  [/"[^"]*"?|'[^']*'?/y, 'string'],
  [/(?<==\s*)[^\s"'<>=]+/y, 'string'],
  [/=/y, 'punct'],
  [/[^\s"'=<>/]+/y, 'attr']
]

function tag(text: string): string {
  const m = /^(<\/?)([^\s/>]+)([\s\S]*?)(\/?>?)$/.exec(text)
  if (!m) return escapeHtml(text)
  return span('punct', m[1]) + span('tag', m[2]) + paint(m[3], attributes) + span('punct', m[4])
}

const html: Rule[] = [
  [/<!--[\s\S]*?(?:-->|$)/y, 'comment'],
  [/<![A-Za-z][^>]*>?/y, 'meta'],
  [/<\/?[A-Za-z][\w:.-]*(?:\s+[^\s<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*\s*\/?>?/y, tag],
  [/&(?:#\d+|#x[\da-fA-F]+|\w+);/y, 'literal'],
  [/[^<&]+/y, null]
]

const css: Rule[] = [
  SPACE,
  BLOCK,
  [/(?<![:\w])\/\/.*/y, 'comment'],
  DOUBLE,
  SINGLE,
  [/@[\w-]+/y, 'keyword'],
  // A property is a name before a colon whose line doesn't go on to open a block, which is what a selector does.
  [/(?<=^[ \t]*|[{;][ \t]*)-{0,2}[A-Za-z_][\w-]*(?=\s*:[^{}\n]*(?:[;}]|$))/my, 'attr'],
  [/#[\da-fA-F]{3,8}\b/y, 'number'],
  [/-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, 'number'],
  [/!important\b/y, 'keyword'],
  [/[A-Za-z_][\w-]*(?=\()/y, 'func'],
  [/--[\w-]+|\$[\w-]+/y, 'var'],
  [/[.#][A-Za-z_][\w-]*/y, 'type'],
  [/[A-Za-z_][\w-]*/y, null],
  [/[{}()[\];:,>+~*=]/y, 'punct']
]

const diff: Rule[] = [
  [/^(?:\+\+\+ |--- |diff |index |@@).*$/my, 'meta'],
  [/^\+.*$/my, 'add'],
  [/^-.*$/my, 'del'],
  [/.+/y, null],
  [/\n+/y, null]
]

interface Language {
  /** What the block's header calls it. */
  label: string
  /** What may follow the opening fence, lower case. The first is the one the note toolbar writes. */
  names: string[]
  /** Null for a language that's shown plain. */
  rules: Rule[] | null
}

const LANGUAGES: Language[] = [
  { label: 'JSON', names: ['json', 'jsonc', 'json5', 'jsonl'], rules: json },
  { label: 'JavaScript', names: ['javascript', 'js', 'jsx', 'mjs', 'cjs', 'node'], rules: javascript },
  { label: 'TypeScript', names: ['typescript', 'ts', 'tsx', 'mts', 'cts'], rules: typescript },
  { label: 'Python', names: ['python', 'py', 'python3'], rules: python },
  { label: 'Shell', names: ['bash', 'sh', 'shell', 'zsh', 'console', 'cmd', 'bat'], rules: shell },
  { label: 'PowerShell', names: ['powershell', 'ps1', 'pwsh', 'ps'], rules: shell },
  { label: 'HTML', names: ['html', 'htm', 'vue', 'svelte'], rules: html },
  { label: 'XML', names: ['xml', 'svg', 'xaml'], rules: html },
  { label: 'CSS', names: ['css', 'scss', 'less'], rules: css },
  { label: 'SQL', names: ['sql', 'postgres', 'postgresql', 'mysql', 'sqlite'], rules: sql },
  { label: 'YAML', names: ['yaml', 'yml'], rules: yaml },
  { label: 'TOML', names: ['toml'], rules: keyValue },
  { label: 'INI', names: ['ini', 'env', 'dotenv', 'properties', 'conf'], rules: keyValue },
  { label: 'Diff', names: ['diff', 'patch'], rules: diff },
  { label: 'Go', names: ['go', 'golang'], rules: generic },
  { label: 'Rust', names: ['rust', 'rs'], rules: generic },
  { label: 'Java', names: ['java'], rules: generic },
  { label: 'Kotlin', names: ['kotlin', 'kt'], rules: generic },
  { label: 'Swift', names: ['swift'], rules: generic },
  { label: 'C', names: ['c', 'h'], rules: generic },
  { label: 'C++', names: ['cpp', 'c++', 'cc', 'hpp', 'cxx'], rules: generic },
  { label: 'C#', names: ['csharp', 'cs', 'c#'], rules: generic },
  { label: 'PHP', names: ['php'], rules: generic },
  { label: 'Markdown', names: ['markdown', 'md'], rules: null },
  { label: 'Plain text', names: ['text', 'txt', 'plain', 'plaintext'], rules: null }
]

const BY_NAME = new Map<string, Language>()
for (const language of LANGUAGES) for (const name of language.names) BY_NAME.set(name, language)

/** The first word after the fence, which is all that names the language. */
const nameOf = (lang: string | undefined): string => (lang ?? '').trim().split(/[\s,{]/)[0].toLowerCase()

/** The languages the note toolbar offers, by the name it writes after the fence. An empty name is a block with no language. */
export const CODE_LANGUAGES: Array<{ name: string; label: string }> = [
  ...['json', 'javascript', 'typescript', 'python', 'bash', 'powershell', 'html', 'css', 'sql', 'yaml', 'diff'].map((name) => ({ name, label: BY_NAME.get(name)!.label })),
  { name: '', label: 'Plain text' }
]

/** What to call a block in its header. A language this doesn't know keeps the name it was given. */
export function languageLabel(lang: string | undefined): string {
  const name = nameOf(lang)
  if (!name) return 'Code'
  return BY_NAME.get(name)?.label ?? name.slice(0, 24)
}

/** Code as escaped HTML, colored when the language is one this knows. Its text is always exactly the code. */
export function highlight(code: string, lang: string | undefined): string {
  const rules = BY_NAME.get(nameOf(lang))?.rules
  if (!rules || code.length > LIMIT) return escapeHtml(code)
  return paint(code, rules)
}
