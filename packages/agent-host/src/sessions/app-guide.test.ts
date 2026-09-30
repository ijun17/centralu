import { describe, expect, it } from 'vitest'
import type { OrchestratorTools } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import { HOST_APPS } from '../apps/registry.js'
import { APP_GUIDE_TOPICS } from './app-guide.js'
import {
  MANAGER_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_TOOLS,
  SCOPED_INSTRUCTIONS,
  appToolEntries,
  profileAllows,
  registerAppTools,
  runOrchestratorTool,
} from './orchestrator-tools.js'

/**
 * The guide does not speak of a tool that does not exist (M4 P-4).
 *
 * The app guide is the text the orchestrator reads to explain the app to a person, and under M4 it
 * also becomes the first thing an agent building an app reads. That text kept advertising
 * `archive_session` even after the archive feature was removed (58d2335) — if the orchestrator
 * trusted it and called the tool, "unknown tool" would come back, and a person would end up being
 * told about a feature that does not exist. The control-rail app's (#81) tools had the opposite
 * problem: it knew about none of them.
 *
 * The per-seat tool list is now generated from the registry, so that side cannot go wrong anymore.
 * What remains at risk is a tool name inside a hand-written sentence. So every word shaped like a
 * tool name (snake_case) is pulled out of the whole text and checked against the registry.
 */

/** Registers the registry's app tools — the same shape as what the manager does at startup (only `enabled` is decided by the test) */
function registerHostApps(enabled: boolean): void {
  registerAppTools(
    HOST_APPS.flatMap((app) => {
      const t = app.tools
      if (!t) return []
      return t.defs.map((d) => ({
        name: d.name,
        description: d.description,
        schema: d.schema,
        profiles: d.profiles ?? t.profiles,
        enabled: () => enabled,
        run: async () => ({ text: '' }),
      }))
    }),
  )
}

/** app_guide never calls the manager — an empty stub is enough */
const noTools = {} as OrchestratorTools

async function guide(topic?: string): Promise<string> {
  const r = await runOrchestratorTool(noTools, 'app_guide', topic ? { topic } : {})
  expect(r.isError).toBeFalsy()
  return r.text
}

async function wholeGuide(): Promise<string> {
  const parts = [await guide()]
  for (const t of APP_GUIDE_TOPICS) parts.push(await guide(t))
  return parts.join('\n')
}

/** Every tool name in the registry — a name exists even when its app is turned off */
const KNOWN = new Set<string>([
  ...ORCHESTRATOR_TOOLS.map((t) => t.name),
  ...HOST_APPS.flatMap((a) => a.tools?.defs.map((d) => d.name) ?? []),
])

function toolLikeWords(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])]
}

/** The list section for one seat, within the orchestrator topic */
function seatSection(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = text.indexOf('\n## ', start + 1)
  return text.slice(start, next < 0 ? undefined : next)
}

const SEATS: { profile: ToolProfile; heading: string }[] = [
  { profile: 'orchestrator', heading: 'Tools the orchestrator calls' },
  { profile: 'manager', heading: 'Tools the worktree manager calls' },
  { profile: 'scoped', heading: 'Tools the lead calls' },
]

describe('the app guide speaks only of tools that exist in the registry', () => {
  it('no topic contains a tool name that is not in the registry', async () => {
    registerHostApps(true)
    const unknown = toolLikeWords(await wholeGuide()).filter((w) => !KNOWN.has(w))
    expect(unknown).toEqual([])
  })

  it('the same holds for the instructions given to the model', () => {
    const text = [ORCHESTRATOR_INSTRUCTIONS, MANAGER_INSTRUCTIONS, SCOPED_INSTRUCTIONS].join('\n')
    expect(toolLikeWords(text).filter((w) => !KNOWN.has(w))).toEqual([])
  })

  it('every seat lists, without omission, every tool it can call — including app tools', async () => {
    registerHostApps(true)
    const text = await guide('orchestrator')
    for (const { profile, heading } of SEATS) {
      const section = seatSection(text, heading)
      const allowed = [
        ...ORCHESTRATOR_TOOLS.filter((t) => profileAllows(profile, t.name)).map((t) => t.name),
        ...appToolEntries(profile).map((t) => t.name),
      ]
      expect(allowed.length).toBeGreaterThan(0)
      expect(allowed.filter((n) => !section.includes(`- ${n}:`))).toEqual([])
    }
    // Proof that a control-rail app tool actually appeared — so the assertion above cannot pass on an empty app list
    expect(text).toContain('- control_create_task:')
  })

  it('does not advertise a turned-off app\'s tools — calling one would be refused', async () => {
    registerHostApps(false)
    const text = await guide('orchestrator')
    const appTools = HOST_APPS.flatMap((a) => a.tools?.defs.map((d) => d.name) ?? [])
    expect(appTools.length).toBeGreaterThan(0)
    expect(appTools.filter((n) => text.includes(`- ${n}:`))).toEqual([])
    // The core tools are still there
    expect(text).toContain('- list_sessions:')
  })
})
