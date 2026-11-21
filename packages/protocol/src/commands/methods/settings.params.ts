import { z } from 'zod'
import { GridPanel, ProjectId, UiPreferencesPatch } from '../../entities.js'
import { ThemeFileContent, ThemeId } from '../../theme.js'

/** Params of the `settings` methods, parsed by the host (docs/protocol.md §3). Results: ./settings.results.ts */
export const settingsParams = {
  'workspace.save': z.object({ layout: z.record(z.string(), z.unknown()) }),
  'approvals.deleteRule': z.object({ id: z.number() }),
  'workspace.load': z.object({}),
  /**
   * docs/protocol.md §3 "grid". In an auto-flow grid order is layout, so adding, removing and reordering are all one
   * "make the list look like this". `tagged`: a host up to 0.1.0-beta.45 needs it to answer panels.
   */
  'grid.get': z.object({ tagged: z.literal(true).optional() }),
  'grid.set': z.object({ panels: z.array(GridPanel).max(256) }),
  /**
   * On the startup path, sent with everything else before the screen appears; a failure is filled with defaults. A slow
   * answer would let the composer's rule change under the person's fingers.
   */
  'prefs.get': z.object({}),
  /**
   * Records only what changed and answers the whole record as written: the writer uses that, not what it sent, or a
   * setting that failed to save could look on only on the screen.
   */
  'prefs.set': z.object({ patch: UiPreferencesPatch }),
  /** A file that does not read cleanly is listed with its problems, rather than the theme silently vanishing */
  'themes.list': z.object({}),
  /** Atomic (temp file and rename), so a reader never sees half a file. `id` null creates a file named after the theme */
  'themes.save': z.object({ id: ThemeId.nullable(), content: ThemeFileContent }),
  /** Import: the copy is validated like any file and gets a fresh id if the name is taken */
  'themes.import': z.object({ path: z.string() }),
  /**
   * Moves the file to the folder's `.removed/`, where the list does not look: the host's own way, for a caller with no
   * shell (the Assistant); the OS trash is the shell's (`themes.resolve`). A side showing it falls back to its preset.
   */
  'themes.remove': z.object({ id: ThemeId }),
  /** For the shell to trash or reveal: the host knows the folder, the shell knows the OS (as `fs.resolve`) */
  'themes.resolve': z.object({ id: ThemeId }),
  'approvals.rules': z.object({ projectId: ProjectId.optional() }),
} as const
