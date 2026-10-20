import type { ThemeFileContent, ThemeFileEntry } from '@cc/protocol'
import { isRecord, parseThemeFile, formatThemeFile } from '@cc/protocol'
import type { ThemesPort } from '../ports/index.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** The themes folder (#312), behind the `themes` port */
export class ThemesMock {
  /**
   * The themes folder (#312), as file texts by id — the host's rules: a write replaces the text,
   * a hand edit is `writeThemeFile`, and every change goes out as `themes_changed`.
   */
  themeFiles = new Map<string, string>()
  /** Paths `themes.importFile` can read, standing in for files elsewhere on disk */
  themeImportSources = new Map<string, string>()
  /** Theme ids revealed in the file manager, in order */
  readonly revealedThemes: string[] = []

  /** For tests: what an editor or an agent saving a theme file does */
  writeThemeFile(id: string, text: string): void {
    this.themeFiles.set(id, text)
    this.persistThemes()
    this.emit({ type: 'themes_changed' })
  }

  /*
   * Kept in localStorage like the preferences: the real folder survives a restart, and a test
   * that reloads the page has to see the same (node has no localStorage; the map still works).
   */
  private themesLoaded = false
  private loadThemes(): void {
    if (this.themesLoaded) return
    this.themesLoaded = true
    try {
      const raw = localStorage.getItem('cc-mock-themes')
      const stored: unknown = raw ? JSON.parse(raw) : null
      if (isRecord(stored)) for (const [id, text] of Object.entries(stored)) if (typeof text === 'string' && !this.themeFiles.has(id)) this.themeFiles.set(id, text)
    } catch {
      /* node, or storage denied */
    }
  }
  private persistThemes(): void {
    try {
      localStorage.setItem('cc-mock-themes', JSON.stringify(Object.fromEntries(this.themeFiles)))
    } catch {
      /* node, or storage denied */
    }
  }

  private themeEntry(id: string): ThemeFileEntry {
    return parseThemeFile(id, `/mock/data/themes/${id}.json`, this.themeFiles.get(id) ?? '')
  }

  private freeThemeId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'theme'
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      if (!this.themeFiles.has(id)) return id
    }
  }

  readonly themes: ThemesPort = {
    list: async () => {
      this.loadThemes()
      return [...this.themeFiles.keys()].sort().map((id) => this.themeEntry(id))
    },
    save: async (id: string | null, content: ThemeFileContent) => {
      const target = id ?? this.freeThemeId(content.name)
      this.writeThemeFile(target, formatThemeFile(content))
      return this.themeEntry(target)
    },
    importFile: async (path: string) => {
      const text = this.themeImportSources.get(path)
      if (text === undefined) throw mockError(`No such file: ${path}`)
      const parsed = parseThemeFile('import', path, text)
      if (parsed.broken) throw mockError(parsed.problems[0] ?? 'Not a theme file.')
      const id = this.freeThemeId(parsed.name)
      this.writeThemeFile(id, text)
      return this.themeEntry(id)
    },
    // The mock stands in for the desktop here: it has a trash and a file manager
    remove: async (id: string) => {
      this.themeFiles.delete(id)
      this.persistThemes()
      this.emit({ type: 'themes_changed' })
      return { supported: true }
    },
    reveal: async (id: string) => {
      this.revealedThemes.push(id)
      return { supported: true }
    },
  }

  constructor(
    private readonly emit: Emit,
  ) {}
}
