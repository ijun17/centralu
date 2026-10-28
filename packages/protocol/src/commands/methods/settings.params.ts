import { z } from 'zod'
import { GridPanel, ProjectId, UiPreferencesPatch } from '../../entities.js'
import { ThemeFileContent, ThemeId } from '../../theme.js'

/** The parameters of the `settings` methods, which the host validates (docs/protocol.md §3). Their results: ./settings.results.ts */
export const settingsParams = {
  'workspace.save': z.object({ layout: z.record(z.string(), z.unknown()) }),
  'approvals.deleteRule': z.object({ id: z.number() }),
  'workspace.load': z.object({}),
  /**
   * The panels placed on the grid, in order — sessions and apps (`GridPanel`, #288).
   *
   * Since this is an auto-flow grid, layout and order are the same single thing. So **adding,
   * removing and reordering are all expressed by this one operation** — "make the list look
   * like this." The answer is the list as stored: a session the host does not know, a duplicate,
   * or an app of a project that is not registered is left out. An app is not checked against the
   * app list, which can lag behind its folder; the screen leaves out one it cannot find.
   *
   * **Expanded, not replaced (protocol.md §4).** Before #288 both methods spoke in bare session
   * ids: `grid.get` answered them, `grid.set` took `{ sessionIds }`. A build that knows panels asks
   * for them (`tagged: true`, `panels`) and gets panels back; a request without them gets the old
   * shape, the sessions only. A newer UI also sends `sessionIds` next to `panels`, so an older host,
   * which strips the field it does not know, still saves the sessions. So a UI and a host one build
   * apart keep working either way, and `PROTOCOL_VERSION` stays where it is. The old fields go one
   * release later.
   */
  'grid.get': z.object({ tagged: z.literal(true).optional() }),
  'grid.set': z
    .object({
      panels: z.array(GridPanel).max(256).optional(),
      sessionIds: z.array(z.string()).max(256).optional(),
    })
    .refine((p) => p.panels !== undefined || p.sessionIds !== undefined, 'panels or sessionIds is required'),
  /**
   * Reads screen settings (UiPreferences).
   *
   * **Lives on the startup path.** A slow response does not just end up being slow — the
   * composer stands briefly under the old rule and then the rule changes out from under the
   * person's fingers. So this call goes out together with everything else done before the screen
   * appears, and a failure is filled in with defaults.
   */
  'prefs.get': z.object({}),
  /**
   * Records only what changed. The result is **the entire record, after being written**.
   *
   * This is so the writer uses what it gets back rather than trusting what it sent — the stored
   * shape has to be exactly the shape the screen follows, or a setting that failed to save can
   * end up looking turned on only on the screen.
   */
  'prefs.set': z.object({ patch: UiPreferencesPatch }),
  /**
   * The theme files in the data folder's `themes/` (#312), as the host read them. A file that
   * does not read cleanly is still listed, with its problems, so Settings can say what is wrong
   * next to it instead of the theme silently vanishing.
   */
  'themes.list': z.object({}),
  /**
   * Writes a theme file, atomically (temp file and rename): a watcher, an editor or an agent
   * reading the folder never sees half a file. `id` null creates a new file named after the theme.
   */
  'themes.save': z.object({ id: ThemeId.nullable(), content: ThemeFileContent }),
  /**
   * Copies a theme file from elsewhere on disk into the folder (Import). The copy is validated
   * like any other file and gets a fresh id if the name is taken.
   */
  'themes.import': z.object({ path: z.string() }),
  /**
   * The absolute path of a theme file, for the shell to trash or reveal (the same two-step as
   * `fs.resolve`: the host knows the folder, the shell knows the OS).
   */
  'themes.resolve': z.object({ id: ThemeId }),
  'approvals.rules': z.object({ projectId: ProjectId.optional() }),
} as const
