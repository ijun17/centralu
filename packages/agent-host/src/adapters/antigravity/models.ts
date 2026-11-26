import { ModelOption } from '@cc/protocol'
import { z } from 'zod'
import { asObj } from '../../json-value.js'
import { toolNotInstalled } from '../core/tool-process.js'
import type { ConfigOption } from '../acp/wire.js'
import { readCachedAgyModels, writeCachedAgyModels, type AgyHome } from './agent-files.js'
import type { AgyArchive } from './release.js'
import type { AgySetup } from './setup.js'

/** Baseline models available in Antigravity when no cache exists yet */
export const AGY_BASELINE_MODELS: readonly ModelOption[] = [
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    tiers: [],
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    tiers: [],
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    tiers: [],
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    tiers: [],
  },
  {
    id: 'gpt-oss-120b-medium',
    label: 'GPT-OSS 120B (Medium)',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    tiers: [],
  },
]

function extractSelectOptions(options: ConfigOption['options']): { value: string; name?: string }[] {
  if (!Array.isArray(options)) return []
  const out: { value: string; name?: string }[] = []
  for (const raw of options) {
    const opt = asObj(raw)
    if (Array.isArray(opt.options)) {
      for (const nestedRaw of opt.options) {
        const nested = asObj(nestedRaw)
        if (typeof nested.value === 'string') {
          out.push({ value: nested.value, ...(typeof nested.name === 'string' ? { name: nested.name } : {}) })
        }
      }
    } else if (typeof opt.value === 'string') {
      out.push({ value: opt.value, ...(typeof opt.name === 'string' ? { name: opt.name } : {}) })
    }
  }
  return out
}

/** Converts ACP configOptions to protocol ModelOption[] */
export function toModelOptions(configOptions: readonly ConfigOption[]): ModelOption[] {
  const modelOpt = configOptions.find((c) => c.id === 'model' || c.category === 'model')
  if (!modelOpt) return []

  const thoughtOpt = configOptions.find(
    (c) => c.category === 'thought_level' || c.id === 'thought_level' || c.id === 'thinking_level',
  )
  const rawEfforts = extractSelectOptions(thoughtOpt?.options)
  const efforts = rawEfforts.map((o) => o.value)
  const defaultEffort =
    typeof thoughtOpt?.currentValue === 'string' && efforts.includes(thoughtOpt.currentValue)
      ? thoughtOpt.currentValue
      : efforts.length > 0
        ? (efforts.includes('medium') ? 'medium' : (efforts[0] ?? null))
        : null

  const modelItems = extractSelectOptions(modelOpt.options)
  return modelItems.map((item) => ({
    id: item.value,
    label: item.name || item.value,
    efforts: [...efforts],
    defaultEffort,
    tiers: [],
  }))
}

/** Saves discovered models to the Antigravity home cache */
export async function saveAgyModels(home: AgyHome, models: readonly ModelOption[]): Promise<void> {
  if (models.length === 0) return
  await writeCachedAgyModels(home, `${JSON.stringify(models, null, 2)}\n`)
}

/** Lists available Antigravity models from cache, or baseline if uncached */
export async function listAgyModels(
  home: AgyHome,
  archive: AgyArchive | null,
  setup: AgySetup,
  signedOut: () => Error,
  label: string,
  install?: string,
): Promise<ModelOption[]> {
  if (!archive || !setup.installed()) {
    throw toolNotInstalled(label, install)
  }
  if (setup.current().state !== 'ready') {
    throw signedOut()
  }
  try {
    const raw = await readCachedAgyModels(home)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      const checked = z.array(ModelOption).safeParse(parsed)
      if (checked.success && checked.data.length > 0) {
        return checked.data
      }
    }
  } catch {
    // Missing or invalid cache file falls back to baseline
  }
  return [...AGY_BASELINE_MODELS]
}
