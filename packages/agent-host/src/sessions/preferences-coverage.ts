import type { UiPreferences } from '@cc/protocol'

/**
 * Every stored preference and how the Assistant reaches it (#1978, owner rule 2026-11-05: what the person can set, the
 * assistant can set too). `preferences-coverage.test.ts` fails when a field of `UiPreferences` is not named here (the type
 * also fails to compile), when a named tool field does not exist in the tool's schema, or when an exclusion has no reason.
 * A new preference is added to Settings, to `set_preferences` (or the tool that already carries it) and to this table in
 * one change.
 *
 * Excluded by design, with the reason on each: sign-ins and credentials, OS permission prompts, pairing a machine and
 * the privacy choices only the person grants never reach the Assistant; none of those is a field of this record, so what
 * is excluded here is the rest of the record that is retired or has no field of the Assistant's yet.
 */
export type PreferenceReach =
  | { tool: 'set_preferences' | 'set_agent_limits'; field: string }
  | { excluded: string }

export const PREFERENCE_COVERAGE: Record<keyof UiPreferences, PreferenceReach> = {
  sendWithModifierEnter: { tool: 'set_preferences', field: 'sendWithModifierEnter' },
  // Settings picks a theme, not a mode: picking sets the mode to the theme's side and that side's field (docs/themes.md)
  themeMode: { tool: 'set_preferences', field: 'theme' },
  themeDark: { tool: 'set_preferences', field: 'theme' },
  themeLight: { tool: 'set_preferences', field: 'theme' },
  accent: { excluded: 'Gone from the product (2026-10-20): Settings does not offer it, so there is nothing to set.' },
  bodyFont: { tool: 'set_preferences', field: 'bodyFont' },
  codeFont: { tool: 'set_preferences', field: 'codeFont' },
  lineHeight: { tool: 'set_preferences', field: 'lineHeight' },
  textSize: { tool: 'set_preferences', field: 'textSize' },
  sessionTools: { excluded: 'Not a setting any more (2026-10-20): always on, Settings does not offer it.' },
  agentCeiling: { tool: 'set_agent_limits', field: 'agentCeiling' },
  agentDepth: { tool: 'set_agent_limits', field: 'agentDepth' },
  agentModels: { tool: 'set_preferences', field: 'agentModels' },
  hubAuto: {
    excluded: 'No set_preferences field yet: the call the window makes (prefs.set, and machines.hubAuto for a linked machine) turns it on or off with no card, with the limited credential too (owner decision 2026-11-05, method-rights.ts).',
  },
  continueAfterLimit: { tool: 'set_preferences', field: 'continueAfterLimit' },
  continueOnNetwork: { tool: 'set_preferences', field: 'continueOnNetwork' },
  foldedGroups: { tool: 'set_preferences', field: 'foldedGroups' },
  notifyPolicy: { tool: 'set_preferences', field: 'notifications' },
  autoCompact: { tool: 'set_preferences', field: 'autoCompact' },
}

/** The switches inside `notifyPolicy` that `set_preferences notifications` leaves out: the product no longer raises them (2026-10-20) */
export const NOTIFY_SWITCHES_RETIRED: readonly string[] = ['error', 'allDone']
