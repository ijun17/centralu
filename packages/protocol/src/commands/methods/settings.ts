import { z } from 'zod'
import { ApprovalScope, GridPanel, ProjectId, UiPreferences, UiPreferencesPatch } from '../../entities.js'
import { ThemeFileContent, ThemeFileEntry, ThemeId } from '../../theme.js'
import { machineField } from '../machine-fields.js'

export const settingsMethods = {
  'workspace.save': {
    params: z.object({ layout: z.record(z.string(), z.unknown()) }),
    result: z.object({ ok: z.literal(true) }),
  },
  'approvals.deleteRule': {
    params: z.object({ id: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.load': { params: z.object({}), result: z.record(z.string(), z.unknown()).nullable() },
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
  'grid.get': {
    params: z.object({ tagged: z.literal(true).optional() }),
    result: z.union([z.array(GridPanel), z.array(z.string())]),
  },
  'grid.set': {
    params: z
      .object({ panels: z.array(GridPanel).max(256).optional(), sessionIds: z.array(z.string()).max(256).optional() })
      .refine((p) => p.panels !== undefined || p.sessionIds !== undefined, 'panels or sessionIds is required'),
    result: z.union([z.array(GridPanel), z.array(z.string())]),
  },
  /**
   * Reads screen settings (UiPreferences).
   *
   * **Lives on the startup path.** A slow response does not just end up being slow — the
   * composer stands briefly under the old rule and then the rule changes out from under the
   * person's fingers. So this call goes out together with everything else done before the screen
   * appears, and a failure is filled in with defaults.
   */
  'prefs.get': {
    params: z.object({}),
    result: UiPreferences,
  },
  /**
   * Records only what changed. The result is **the entire record, after being written**.
   *
   * This is so the writer uses what it gets back rather than trusting what it sent — the stored
   * shape has to be exactly the shape the screen follows, or a setting that failed to save can
   * end up looking turned on only on the screen.
   */
  'prefs.set': {
    params: z.object({ patch: UiPreferencesPatch }),
    result: UiPreferences,
  },
  /**
   * The theme files in the data folder's `themes/` (#312), as the host read them. A file that
   * does not read cleanly is still listed, with its problems, so Settings can say what is wrong
   * next to it instead of the theme silently vanishing.
   */
  'themes.list': {
    params: z.object({}),
    result: z.array(ThemeFileEntry),
  },
  /**
   * Writes a theme file, atomically (temp file and rename): a watcher, an editor or an agent
   * reading the folder never sees half a file. `id` null creates a new file named after the theme.
   */
  'themes.save': {
    params: z.object({ id: ThemeId.nullable(), content: ThemeFileContent }),
    result: ThemeFileEntry,
  },
  /**
   * Copies a theme file from elsewhere on disk into the folder (Import). The copy is validated
   * like any other file and gets a fresh id if the name is taken.
   */
  'themes.import': {
    params: z.object({ path: z.string() }),
    result: ThemeFileEntry,
  },
  /**
   * The absolute path of a theme file, for the shell to trash or reveal (the same two-step as
   * `fs.resolve`: the host knows the folder, the shell knows the OS).
   */
  'themes.resolve': {
    params: z.object({ id: ThemeId }),
    result: z.object({ path: z.string() }),
  },
  'approvals.rules': {
    params: z.object({ projectId: ProjectId.optional() }),
    result: z.array(
      z.object({
        id: z.number(),
        scope: ApprovalScope,
        matcher: z.string(),
        decision: z.string(),
        createdAt: z.number(),
        /** Which project or session this rule belongs to — the same rule from two different projects used to look like one identical row in Settings (#183) */
        projectId: z.string().nullable().default(null),
        sessionId: z.string().nullable().default(null),
        /** A rule of a linked machine (#82): its `id` is then folded into a negative number the hub maps back */
        ...machineField,
      }),
    ),
  },
} as const
