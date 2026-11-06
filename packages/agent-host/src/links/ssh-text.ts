import { ansiText } from '../os.js'

/** What an ssh run said, as the person should read it (`lastLine`): PowerShell's CLIXML, ssh's octal escapes and the machine's code page undone */

/** A tag or an escape of PowerShell's CLIXML (`_x000D__x000A_` is a line break, `_x001B_` an ESC) */
const CLIXML_MARK = /<\/?(?:Objs|Obj|S|MS|PR|TN|TNRef|Props|I32|I64|B|AV)[\s>/]|_x00[0-9A-F]{2}_/

/** A terminal escape sequence (colour and the like), which PowerShell 7 puts in its errors: none of it is text */
// eslint-disable-next-line no-control-regex -- ESC is what the pattern is about
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]?/g

/**
 * One line of an error record as the person should read it, or null for a line that only says where in the script the
 * error was. Windows PowerShell 5.1 writes those under the message: `At line:4 char:1` (in the machine's
 * language: `위치 줄:4 문자:1` on a Korean one, measured; `At C:\x.ps1:12 char:5` in a script),
 * `+ throw 'x'`, `+ ~~~~`, `+ CategoryInfo : …`. PowerShell 7's ConciseView writes them as a gutter around the
 * message: `Line |`, `   4 |  throw 'x'`, `     |  ~~~~`, then `     | x`, the message itself. The position line is
 * known by its whole shape (a word, then `<where>:<n> <word>:<n>`), so a message that only ends in `b.log:12 col:5` stays.
 */
function powershellErrorLine(line: string): string | null {
  const l = line.trim()
  if (l === '+' || l.startsWith('+ ')) return null
  if (/^\S+ \S+:\d+ \S+:\d+$/.test(l) || /^(?:At|위치) .+:\d+ \S+:\d+$/.test(l)) return null
  if (/^Line \|$/.test(l) || /^\d+ \|/.test(l) || /^\|\s*~*$/.test(l)) return null
  const gutter = /^\| ?(.*)$/.exec(l)
  return gutter?.[1] ?? line
}

/**
 * The text of the whole error records (`<S S="Error">`) in a piece of CLIXML, its escapes read back
 * and without the lines that say where in the script the error was
 */
function clixmlErrorText(xml: string): string {
  return [...xml.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((m) =>
      (m[1] ?? '')
        .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e] ?? e),
    )
    .join('')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .flatMap((l) => {
      const kept = powershellErrorLine(l)
      return kept === null ? [] : [kept]
    })
    .join('\n')
}

/** Text outside the XML, up to the first line that shows a tag or an escape: from there it is XML that was cut */
function plainPart(text: string): string {
  const mark = text.search(CLIXML_MARK)
  return mark < 0 ? text : text.slice(0, text.lastIndexOf('\n', mark) + 1)
}

/**
 * What a stderr says once PowerShell's CLIXML is read (#1081). Windows PowerShell writes its `#< CLIXML`
 * header before its first record, often a progress record ("Preparing modules for first use") at the
 * start, and the records as `<Objs>…</Objs>` blocks. What a command it runs writes to stderr itself
 * comes between the header and the blocks, and its own errors are the blocks' `<S S="Error">` records.
 * So the header and the progress go, the text around and between the blocks and the error records'
 * text are kept. A kept tail (`Tail`) can start in the middle of a block, and then only its tags and
 * escapes say what it is: from the start of the first line that shows either up to that block's end,
 * it is XML, and only the whole error records in it are read.
 */
function withoutClixml(s: string): string[] {
  let text = s.replace(/^#< CLIXML\r?$/gm, '')
  const parts: string[] = []
  const firstEnd = text.indexOf('</Objs>')
  const firstOpen = text.search(/<Objs[\s>]/)
  if (firstEnd >= 0 && (firstOpen < 0 || firstEnd < firstOpen)) {
    const cut = plainPart(text.slice(0, firstEnd))
    parts.push(cut, '\n', clixmlErrorText(text.slice(cut.length, firstEnd)), '\n')
    text = text.slice(firstEnd + '</Objs>'.length)
  }
  for (;;) {
    const open = text.search(/<Objs[\s>]/)
    if (open < 0) break
    parts.push(plainPart(text.slice(0, open)), '\n')
    const end = text.indexOf('</Objs>', open)
    // A stream that stops inside a block (the process was ended mid-write) keeps the block's whole records
    parts.push(clixmlErrorText(end < 0 ? text.slice(open) : text.slice(open, end)), '\n')
    text = end < 0 ? '' : text.slice(end + '</Objs>'.length)
  }
  parts.push(plainPart(text))
  return parts.join('').replace(ANSI, '').split(/\r?\n/)
}

/**
 * The one line of a remote's stderr that says why, for the person. Measured on a Windows laptop
 * (2026-10-05): ssh prefixes its own `** WARNING` lines about key exchange, PowerShell wraps an
 * error in CLIXML when its output is not a console (read by `withoutClixml`), and a Node crash ends
 * with `Node.js v22.x`, which says nothing. Those are skipped; a line that names an error wins over
 * the last one.
 */
export function lastLine(s: string, ansi: (bytes: Buffer) => string | null = ansiText): string {
  const lines = withoutClixml(s)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('**') && !/^Node\.js v\d/.test(l) && !/^at /.test(l))
  const line = [...lines].reverse().find((l) => /error|denied|refused|timed out|not found|cannot|could not/i.test(l)) ?? lines.at(-1) ?? ''
  return unescapeBytes(line, ansi)
}

/**
 * A line of ssh's own with the bytes it would not print put back as text (#849).
 *
 * ssh writes the bytes of its messages that it does not take for printable text as octal escapes (OpenSSH's `strnvis`).
 * Windows' OpenSSH gets a system error's text in the ANSI code page, so on a Korean machine "Could not resolve hostname
 * x: 알려진 호스트가 없습니다." reached the person as `x: \276\313\267\301…` (measured with OpenSSH_for_Windows 9.5p2).
 * A run of escapes is read as UTF-8, or else in the ANSI code page. Only a run of bytes from 0x80 up is ssh's: it prints
 * ASCII as it is, so `\123` in a Windows path (`C:\123\x`) stays as written.
 */
export function unescapeBytes(line: string, ansi: (bytes: Buffer) => string | null = ansiText): string {
  return line.replace(/(?:\\[23][0-7]{2})+/g, (run) => {
    const bytes = Buffer.from(run.slice(1).split('\\').map((o) => parseInt(o, 8)))
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return ansi(bytes) ?? run
    }
  })
}
