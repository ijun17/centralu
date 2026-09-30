import type { ModelOption } from '@cc/protocol'

/** Only the part of the SDK Query needed for the model list (external types do not leave the adapter). */
export type ModelQuery = {
  supportedModels(): Promise<
    {
      value: string
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
 * **We do not write the list ourselves.** It carries whatever the SDK reports. We used to
 * hardcode it, and when Fable shipped it could not be selected — we do not want to repeat the
 * situation where the tool ships an update and only this app stays behind.
 *
 * Reasoning effort support and its levels also differ by model, so they are read here as well.
 */
export async function readClaudeModels(q: ModelQuery): Promise<ModelOption[]> {
  const rows = await q.supportedModels()
  return rows.map((m) => ({
    id: m.value,
    label: m.displayName || m.value,
    description: m.description || undefined,
    // If supportsEffort is false, ignore any levels sent along — two answers would conflict.
    efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
    defaultEffort: null,
    // Claude has no speed tiers (measured — the SDK has no corresponding concept).
    tiers: [],
  }))
}
