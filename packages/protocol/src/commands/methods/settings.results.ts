import { z } from 'zod'
import { ApprovalScope, GridPanel, UiPreferences } from '../../entities.js'
import { ThemeFileEntry } from '../../theme.js'
import { machineField } from '../machine-fields.js'

/** The results of the `settings` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./settings.params.ts */
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
  'themes.resolve': z.object({ path: z.string() }),
  'approvals.rules': z.array(
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
} as const
