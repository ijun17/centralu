/**
 * A shell command line read into the simple commands it runs, the way the gate needs it (docs/plans/antigravity-adapter.md
 * §5.5): for the person's `command(...)` deny rules and for the plugin root's refusal. Best effort, and **broad where it
 * is unsure**, since what reads this only ever refuses or asks:
 *
 * - quotes and backslashes are taken out of each word, so `"echo" deny-me`, `e'cho' deny-me` and `\echo deny-me` are
 *   `echo deny-me`;
 * - a command substitution (`$(…)`, backticks, `<(…)`), a subshell and a here-string are read as commands of their own;
 * - a shell's `-c` script and `eval`'s words are read again as a command line;
 * - after a wrapper (`sudo`, `env`, `xargs`, `nohup`, `timeout`, `find … -exec`, …) every later word may be the program,
 *   so every later position starts a command too (its own options are not parsed);
 * - a word the shell would change (a variable, a substitution, a glob, a brace list) is `dynamic`, so a rule compared with
 *   it can only "maybe" match;
 * - a line it cannot read with confidence (an unclosed quote or substitution, a dynamic `-c` script or `eval`, nesting
 *   too deep) is not `confident`: a deny rule that might match then gives a card, never an allow.
 *
 * Not read: aliases and functions, a script a shell reads from a file or a variable's value. `agy` applies the person's
 * rules too (§1.2), and the preset still decides whether the call needs a card.
 */

/**
 * One word with its quotes taken out; `dynamic` when the shell would change it before running. `fixed`: where in `text`
 * the last changing part ends (0 when none), so `$HOME/bin/rm` is still known to run `rm`
 */
export type Word = { text: string; dynamic: boolean; fixed: number }

export type CommandLine = {
  /** Every simple command, and from each wrapper on, each later position as a command of its own */
  commands: Word[][]
  /** Every word read, in every command and substitution: what the plugin root's refusal looks through */
  words: Word[]
  confident: boolean
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'ash', 'busybox'])
/** Words before the program: shell keywords */
const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'coproc'])
/** Programs that run another program named later in their words */
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'xargs', 'nice', 'nohup', 'time', 'timeout', 'command', 'exec', 'builtin', 'stdbuf', 'ionice',
  'caffeinate', 'watch', 'strace', 'ltrace', 'chroot', 'setsid', 'unbuffer', 'script', 'find', 'parallel', 'flock', 'su',
  'runuser', 'chrt', 'taskset', 'arch', 'npx', 'pnpx', 'bunx', 'dotenv', 'gtimeout', 'gstdbuf', 'gxargs', 'gfind',
])
const MAX_DEPTH = 8

/** Reads `line`; never throws */
export function readCommandLine(line: string): CommandLine {
  const out: CommandLine = { commands: [], words: [], confident: true }
  readInto(line, 0, out)
  return out
}

function readInto(line: string, depth: number, out: CommandLine): void {
  if (depth > MAX_DEPTH) {
    out.confident = false
    return
  }
  const p = new Parser(line)
  p.run(null)
  if (!p.confident) out.confident = false
  for (const here of p.hereStrings) readInto(here, depth + 1, out)
  for (const cmd of p.commands) {
    out.words.push(...cmd)
    expand(cmd, depth, out)
  }
}

const isAssignment = (w: Word): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)
export const programName = (w: Word): string => w.text.slice(w.text.lastIndexOf('/') + 1)

/** Whether the program's name is known: a `/` after the last changing part, so the name after it is plain */
export const knownProgram = (w: Word): boolean => !w.dynamic || w.text.lastIndexOf('/') >= w.fixed

/** One simple command: from its program on, and from each word after a wrapper, each a command; shells' scripts read again */
function expand(cmd: Word[], depth: number, out: CommandLine): void {
  const at = cmd.findIndex((w) => !isAssignment(w) && !KEYWORDS.has(w.text))
  if (at < 0) return
  const starts = [at]
  // A wrapper's own options are not parsed: from it on, every word may be the program it runs
  const wrapper = cmd.findIndex((w, i) => i >= at && WRAPPERS.has(programName(w)))
  if (wrapper >= 0) for (let k = wrapper + 1; k < cmd.length; k++) starts.push(k)
  for (const s of new Set(starts)) {
    const [first, ...rest] = cmd.slice(s)
    if (!first) continue
    out.commands.push([first, ...rest])
    const program = programName(first)
    if (SHELLS.has(program)) {
      const script = shellScript(rest)
      if (script === null) continue
      if (script.dynamic) out.confident = false
      else readInto(script.text, depth + 1, out)
    } else if (program === 'eval' && rest.length > 0) {
      if (rest.some((w) => w.dynamic)) out.confident = false
      else readInto(rest.map((w) => w.text).join(' '), depth + 1, out)
    }
  }
}

/** The script of `sh -c <script>` (any option cluster with `c`, as `-lc`) from the shell's arguments, null without one */
function shellScript(args: readonly Word[]): Word | null {
  for (const [i, w] of args.entries()) {
    if (!/^[-+][A-Za-z]+$/.test(w.text)) return null
    if (w.text.startsWith('-') && w.text.includes('c')) return args[i + 1] ?? null
  }
  return null
}

class Parser {
  i = 0
  confident = true
  readonly commands: Word[][] = []
  readonly hereStrings: string[] = []

  constructor(private readonly s: string) {}

  /** Reads commands until `end` (`)` of a substitution, or a backtick) or the end of the text */
  run(end: ')' | '`' | null): void {
    const s = this.s
    let cmd: Word[] = []
    let word = ''
    let bare = ''
    let dynamic = false
    let fixed = 0
    let started = false
    /** The next word is a redirection's target, not an argument; 'here' for a here-string, read as a command line */
    let redirect: false | 'file' | 'here' = false
    let parens = 0
    const endWord = () => {
      if (started) {
        // A brace list (`{a,b}`, `{1..3}`) unquoted: the shell makes several words of it
        if (/\{[^}]*(,|\.\.)[^}]*\}/.test(bare)) mark()
        if (redirect === 'here') {
          if (!dynamic) this.hereStrings.push(word)
        } else if (redirect !== 'file') cmd.push({ text: word, dynamic, fixed })
        if (redirect) redirect = false
      }
      word = ''
      bare = ''
      dynamic = false
      fixed = 0
      started = false
    }
    /** What was added last changes when the shell runs it */
    const mark = () => {
      dynamic = true
      fixed = word.length
    }
    const endCommand = () => {
      endWord()
      redirect = false
      if (cmd.length) this.commands.push(cmd)
      cmd = []
    }
    const add = (t: string, unquoted: boolean) => {
      word += t
      if (unquoted) bare += t
      started = true
    }
    while (this.i < s.length) {
      const c = s.charAt(this.i)
      if (end === '`' && c === '`') {
        this.i++
        endCommand()
        return
      }
      if (c === ' ' || c === '\t') {
        endWord()
        this.i++
      } else if (c === '\\') {
        const next = s[this.i + 1]
        if (next === undefined) this.i++
        else if (next === '\n') this.i += 2
        else {
          add(next, false)
          this.i += 2
        }
      } else if (c === "'") {
        const close = s.indexOf("'", this.i + 1)
        if (close < 0) {
          this.confident = false
          add(s.slice(this.i + 1), false)
          this.i = s.length
        } else {
          add(s.slice(this.i + 1, close), false)
          this.i = close + 1
        }
      } else if (c === '"') {
        this.i++
        started = true
        const at = word.length
        const changed = this.double()
        word += this.lastDouble
        if (changed >= 0) {
          dynamic = true
          fixed = at + changed
        }
      } else if (c === '$' && s[this.i + 1] === "'") {
        // ANSI-C quoting: its escapes (`\x65`) are not decoded here, so a backslash makes the word unknown
        const close = s.slice(this.i + 2).search(/(?<!\\)'/)
        if (close < 0) {
          this.confident = false
          this.i = s.length
        } else {
          const body = s.slice(this.i + 2, this.i + 2 + close)
          add(body, false)
          if (body.includes('\\')) mark()
          this.i += close + 3
        }
      } else if (c === '$' && s[this.i + 1] === '(') {
        this.i += 2
        this.run(')')
        started = true
        mark()
      } else if (c === '`') {
        this.i++
        this.run('`')
        started = true
        mark()
      } else if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
        // Process substitution: a command of its own, and a file name to this one
        this.i += 2
        this.run(')')
        started = true
        mark()
      } else if (c === '$') {
        add('$', true)
        mark()
        this.i++
      } else if (c === '<' || c === '>' || (c === '&' && s[this.i + 1] === '>')) {
        // A file descriptor before it (`2>`) is not a word
        if (started && /^\d+$/.test(word) && word === bare) {
          word = ''
          bare = ''
          fixed = 0
          started = false
        } else endWord()
        const op = /^(<<<|<<-?|<>|>>|>\||>&|<&|&>>|&>|<|>)/.exec(s.slice(this.i))?.[0] ?? c
        this.i += op.length
        redirect = op === '<<<' ? 'here' : 'file'
      } else if (c === ';' || c === '\n' || c === '\r' || c === '&' || c === '|') {
        endCommand()
        this.i++
      } else if (c === '(') {
        endCommand()
        parens++
        this.i++
      } else if (c === ')') {
        this.i++
        if (parens > 0) {
          parens--
          endCommand()
        } else if (end === ')') {
          endCommand()
          return
        } else endCommand()
      } else if (c === '#' && !started) {
        const nl = s.indexOf('\n', this.i)
        this.i = nl < 0 ? s.length : nl
      } else {
        add(c, true)
        if (c === '*' || c === '?' || c === '[') mark()
        this.i++
      }
    }
    // The text ended inside a substitution
    if (end !== null) this.confident = false
    endCommand()
  }

  private lastDouble = ''

  /**
   * A double-quoted part, from after its opening quote: its text in `lastDouble`; where in it the last expansion ends,
   * -1 when it has none
   */
  private double(): number {
    const s = this.s
    let text = ''
    let changed = -1
    while (this.i < s.length) {
      const c = s.charAt(this.i)
      if (c === '"') {
        this.i++
        this.lastDouble = text
        return changed
      }
      if (c === '\\' && '$`"\\\n'.includes(s[this.i + 1] ?? '')) {
        if (s[this.i + 1] !== '\n') text += s[this.i + 1]
        this.i += 2
      } else if (c === '$' && s[this.i + 1] === '(') {
        this.i += 2
        this.run(')')
        changed = text.length
      } else if (c === '`') {
        this.i++
        this.run('`')
        changed = text.length
      } else {
        text += c
        if (c === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(s[this.i + 1] ?? '')) changed = text.length
        this.i++
      }
    }
    this.confident = false
    this.lastDouble = text
    return changed
  }
}
