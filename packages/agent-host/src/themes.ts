import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  THEME_SCHEMA_FILE,
  formatThemeFile,
  freeThemeId,
  parseThemeFile,
  themeFileJsonSchema,
  type ThemeFileContent,
  type ThemeFileEntry,
} from '@cc/protocol'
import { realOs } from './os/real.js'
import { writeFileWhole } from './os/write-file-whole.js'
import { rpcError } from './rpc-error.js'

/** A theme file bigger than this is not a theme (the full token set written out is about 4KB) */
const MAX_FILE_BYTES = 256 * 1024
/** Editors save in bursts (write, rename, chmod); one refetch per burst is enough */
const SETTLE_MS = 100

/** Where `remove` keeps what it took out of the folder */
const REMOVED_DIR = '.removed'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/

/**
 * The themes folder (#312): `<data>/themes/<id>.json`, one custom theme per file.
 *
 * It is a folder of files rather than a field in the preferences so that a theme can be edited
 * by hand or by an agent, shared as a file, and kept under version control. This service lists
 * and reads it, writes it atomically, copies a file in, and watches it, announcing every change
 * through `onChange` so the screen refetches — a theme edited in an editor shows up live.
 *
 * Self-contained on purpose: the only things it knows are its folder and the shared file
 * format in `@cc/protocol` (theme.ts), which the screen reads the same way.
 */
export class ThemeFiles {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    readonly dir: string,
    private readonly onChange: () => void,
  ) {}

  /** Makes the folder, writes the schema next to the themes, and starts watching */
  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.writeSchema()
    try {
      this.watcher = watch(this.dir, (_event, name) => {
        if (name && !String(name).endsWith('.json')) return
        if (name === THEME_SCHEMA_FILE) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          this.onChange()
        }, SETTLE_MS)
      })
      // A watcher error (the folder deleted under it) must not take the host down; the list still works on demand
      this.watcher.on('error', () => this.stopWatching())
    } catch {
      /* no watching on this filesystem — the list is still read on every request */
    }
  }

  close(): void {
    this.stopWatching()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private stopWatching(): void {
    this.watcher?.close()
    this.watcher = null
  }

  /**
   * The schema an editor uses for completion, written only when it differs — a build that adds
   * a token updates it, and an unchanged one does not touch the folder (or wake the watcher).
   */
  private async writeSchema(): Promise<void> {
    const path = join(this.dir, THEME_SCHEMA_FILE)
    const text = `${JSON.stringify(themeFileJsonSchema(), null, 2)}\n`
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current !== text) writeFileWhole(realOs().files, path, text)
  }

  /** Every `<id>.json` in the folder, read and checked. A file that cannot be read is listed with the reason. */
  async list(): Promise<ThemeFileEntry[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    const entries: ThemeFileEntry[] = []
    const ids = names
      .filter((name) => name.endsWith('.json') && name !== THEME_SCHEMA_FILE)
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => ID_PATTERN.test(id))
      // By id, not by file name: `paper-2.json` sorts before `paper.json` ('-' < '.')
      .sort()
    for (const id of ids) entries.push(await this.read(id))
    return entries
  }

  async read(id: string): Promise<ThemeFileEntry> {
    const path = this.pathOf(id)
    try {
      const info = await stat(path)
      if (info.size > MAX_FILE_BYTES) {
        return { id, path, name: id, base: 'dark', tokens: {}, problems: ['The file is too large to be a theme.'], broken: true }
      }
      return parseThemeFile(id, path, await readFile(path, 'utf8'))
    } catch (e) {
      return { id, path, name: id, base: 'dark', tokens: {}, problems: [`Could not read the file: ${(e as Error).message}`], broken: true }
    }
  }

  /** Writes a theme. `id` null makes a new file named after the theme (`My theme` → `my-theme.json`). */
  async save(id: string | null, content: ThemeFileContent): Promise<ThemeFileEntry> {
    const text = formatThemeFile(content)
    // The reader refuses a bigger file (read), so writing one would list a theme that never applies
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw rpcError('The theme is too large to be a theme file.')
    const target = id ?? (await this.freeId(content.name))
    await mkdir(this.dir, { recursive: true })
    // On a filesystem that ignores case, `paper` would overwrite a hand-written Paper.json the list does not show
    const names = await readdir(this.dir).catch(() => [] as string[])
    const clash = names.find((n) => n !== `${target}.json` && n.toLowerCase() === `${target}.json`)
    if (clash) throw rpcError(`The themes folder has ${clash}, which the list does not show (ids are lowercase); rename or remove it first.`)
    writeFileWhole(realOs().files, this.pathOf(target), text)
    return this.read(target)
  }

  /**
   * Takes a theme file out of the list without destroying it: it moves to `.removed/<id>-<time>-<random>.json`, a place the list
   * does not look, so a mistaken removal is one move back. The host has no OS trash (Settings' button reaches it through the
   * shell), so these stay until the person clears the folder. Where it went is returned; null when there was no such file.
   */
  async remove(id: string): Promise<string | null> {
    const from = this.pathOf(id)
    if (!(await stat(from).then(() => true, () => false))) return null
    const kept = join(this.dir, REMOVED_DIR)
    await mkdir(kept, { recursive: true })
    const to = join(kept, `${id}-${Date.now()}-${randomBytes(3).toString('hex')}.json`)
    await realOs().files.promises.rename(from, to)
    return to
  }

  /** Copies a file from elsewhere in, under a fresh id if its name is taken. Refuses what does not read as a theme. */
  async importFrom(source: string): Promise<ThemeFileEntry> {
    const info = await stat(source)
    if (!info.isFile()) throw rpcError('That is not a file.')
    if (info.size > MAX_FILE_BYTES) throw rpcError('The file is too large to be a theme.')
    const text = await readFile(source, 'utf8')
    const parsed = parseThemeFile('import', source, text)
    if (parsed.broken) throw rpcError(parsed.problems[0] ?? 'Not a theme file.')
    const fromName = basename(source).replace(/\.json$/i, '')
    const id = await this.freeId(parsed.name !== 'import' ? parsed.name : fromName)
    // The text is copied as it is (comments of a sort, key order, `$schema`), not re-serialised
    writeFileWhole(realOs().files, this.pathOf(id), text)
    return this.read(id)
  }

  /** The absolute path for an id, for the shell to trash or reveal. Refuses anything that is not an id. */
  pathOf(id: string): string {
    if (!ID_PATTERN.test(id)) throw rpcError(`Not a theme id: ${id}`)
    return join(this.dir, `${id}.json`)
  }

  /** The id a new file named `name` goes under (`freeThemeId`): not one of the files here, not a preset's */
  private async freeId(name: string): Promise<string> {
    // Lowercased: on a filesystem that ignores case `Paper.json` takes `paper` too (see `save`)
    const names = new Set((await readdir(this.dir).catch(() => [] as string[])).map((n) => n.toLowerCase()))
    return freeThemeId(name, (id) => names.has(`${id}.json`))
  }
}
