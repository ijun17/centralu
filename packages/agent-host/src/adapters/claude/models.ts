import type { ModelOption } from '@cc/protocol'

/** Only the part of the SDK Query needed for the model list (external types do not leave the adapter). */
export type ModelQuery = {
  supportedModels(): Promise<
    {
      value: string
      resolvedModel?: string
      displayName?: string
      description?: string
      supportsEffort?: boolean
      supportedEffortLevels?: string[]
    }[]
  >
}

/**
 * The list of selectable models (`supportedModels()`).
 *
 * **We do not write the list ourselves**: it is whatever the SDK reports, so a model the tool ships is selectable here
 * at once. Reasoning effort support and its levels differ by model, so they are read here as well.
 */
export async function readClaudeModels(q: ModelQuery): Promise<ModelOption[]> {
  const rows = await q.supportedModels()
  return rows.map((m) => ({
    id: m.value,
    // The model an alias names now: lets a stored full id be matched to the entry that covers it (#1989)
    ...(m.resolvedModel ? { resolved: m.resolvedModel } : {}),
    label: m.displayName || m.value,
    description: m.description || undefined,
    // If supportsEffort is false, ignore any levels sent along — two answers would conflict.
    efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
    defaultEffort: null,
    // Claude has no speed tiers (measured — the SDK has no corresponding concept).
    tiers: [],
  }))
}
