import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  THEME_SCHEMA_FILE,
  formatThemeFile,
  parseThemeFile,
  themeFileJsonSchema,
  type ThemeFileContent,
  type ThemeFileEntry,
} from '@cc/protocol'

/** A theme file bigger than this is not a theme (the full token set written out is about 4KB) */
const MAX_FILE_BYTES = 256 * 1024
/** Editors save in bursts (write, rename, chmod); one refetch per burst is enough */
const SETTLE_MS = 100

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
    if (current !== text) await this.atomicWrite(path, text)
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
    const target = id ?? (await this.freeId(content.name))
    await mkdir(this.dir, { recursive: true })
    await this.atomicWrite(this.pathOf(target), formatThemeFile(content))
    return this.read(target)
  }

  /** Copies a file from elsewhere in, under a fresh id if its name is taken. Refuses what does not read as a theme. */
  async importFrom(source: string): Promise<ThemeFileEntry> {
    const info = await stat(source)
    if (!info.isFile()) throw Object.assign(new Error('That is not a file.'), { code: 'invalid_params' })
    if (info.size > MAX_FILE_BYTES) throw Object.assign(new Error('The file is too large to be a theme.'), { code: 'invalid_params' })
    const text = await readFile(source, 'utf8')
    const parsed = parseThemeFile('import', source, text)
    if (parsed.broken) throw Object.assign(new Error(parsed.problems[0] ?? 'Not a theme file.'), { code: 'invalid_params' })
    const fromName = basename(source).replace(/\.json$/i, '')
    const id = await this.freeId(parsed.name !== 'import' ? parsed.name : fromName)
    // The text is copied as it is (comments of a sort, key order, `$schema`), not re-serialised
    await this.atomicWrite(this.pathOf(id), text)
    return this.read(id)
  }

  /** The absolute path for an id, for the shell to trash or reveal. Refuses anything that is not an id. */
  pathOf(id: string): string {
    if (!ID_PATTERN.test(id)) throw Object.assign(new Error(`Not a theme id: ${id}`), { code: 'invalid_params' })
    return join(this.dir, `${id}.json`)
  }

  private async freeId(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'theme'
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      const taken = await stat(this.pathOf(id)).then(
        () => true,
        () => false,
      )
      if (!taken) return id
    }
    return `${base}-${randomBytes(4).toString('hex')}`
  }

  /** Temp file and rename: a reader (the watcher, an editor, an agent) never sees half a file */
  private async atomicWrite(path: string, text: string): Promise<void> {
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, path)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
  }
}
