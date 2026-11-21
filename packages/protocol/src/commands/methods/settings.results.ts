import { z } from 'zod'
import { ApprovalScope, GridPanel, UiPreferences } from '../../entities.js'
import { ThemeFileEntry } from '../../theme.js'
import { machineField } from '../machine-fields.js'

/** Results of the `settings` methods, read through `parseRpcResult`. Params and what each method does: ./settings.params.ts */
export const settingsResults = {
  'workspace.save': z.object({ ok: z.literal(true) }),
  'approvals.deleteRule': z.object({ ok: z.literal(true) }),
  'workspace.load': z.record(z.string(), z.unknown()).nullable(),
  'grid.get': z.array(GridPanel),
  'grid.set': z.array(GridPanel),
  'prefs.get': UiPreferences,
  'prefs.set': UiPreferences,
  'themes.list': z.array(ThemeFileEntry),
  'themes.save': ThemeFileEntry,
  'themes.import': ThemeFileEntry,
  'themes.remove': z.object({ removed: z.boolean(), keptAt: z.string().nullable() }),
  'themes.resolve': z.object({ path: z.string() }),
  'approvals.rules': z.array(
    z.object({
      id: z.number(),
      scope: ApprovalScope,
      matcher: z.string(),
      decision: z.string(),
      createdAt: z.number(),
      /** Without it, the same rule of two projects looks like one row in Settings */
      projectId: z.string().nullable().default(null),
      sessionId: z.string().nullable().default(null),
      /** A linked machine's rule: its `id` is then folded into a negative number the hub maps back */
      ...machineField,
    }),
  ),
} as const
