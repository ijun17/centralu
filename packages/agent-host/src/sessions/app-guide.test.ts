import { describe, expect, it } from 'vitest'
import type { OrchestratorTools } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import { APP_GUIDE_TOPICS } from './app-guide.js'
import {
  MANAGER_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_TOOLS,
  DELEGATE_TOOLS,
  SCOPED_INSTRUCTIONS,
  profileAllows,
  runOrchestratorTool,
} from './orchestrator-tools.js'

/**
 * The guide does not speak of a tool that does not exist (M4 P-4).
 *
 * The app guide is the text the orchestrator reads to explain the app to a person, and under M4 it
 * also becomes the first thing an agent building an app reads. That text kept advertising
 * `archive_session` even after the archive feature was removed (58d2335) — if the orchestrator
 * trusted it and called the tool, "unknown tool" would come back, and a person would end up being
 * told about a feature that does not exist. The control-rail app's (#81, removed in #97) tools had
 * the opposite problem: it knew about none of them.
 *
 * The per-seat tool list is now generated from the registry, so that side cannot go wrong anymore.
 * What remains at risk is a tool name inside a hand-written sentence. So every word shaped like a
 * tool name (snake_case) is pulled out of the whole text and checked against the registry.
 */

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

/** Every tool name in the registry */
const KNOWN = new Set<string>([...ORCHESTRATOR_TOOLS.map((t) => t.name), ...DELEGATE_TOOLS.map((t) => t.name)])

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
  { profile: 'scoped', heading: 'Tools a coordinating session calls' },
  { profile: 'reader', heading: 'Tools every other session calls' },
]

describe('the app guide speaks only of tools that exist in the registry', () => {
  it('no topic contains a tool name that is not in the registry', async () => {
    const unknown = toolLikeWords(await wholeGuide()).filter((w) => !KNOWN.has(w))
    expect(unknown).toEqual([])
  })

  it('the same holds for the instructions given to the model', () => {
    const text = [ORCHESTRATOR_INSTRUCTIONS, MANAGER_INSTRUCTIONS, SCOPED_INSTRUCTIONS].join('\n')
    expect(toolLikeWords(text).filter((w) => !KNOWN.has(w))).toEqual([])
  })

  it('every seat lists, without omission, every tool it can call', async () => {
    const text = await guide('orchestrator')
    for (const { profile, heading } of SEATS) {
      const section = seatSection(text, heading)
      const allowed = ORCHESTRATOR_TOOLS.filter((t) => profileAllows(profile, t.name)).map((t) => t.name)
      expect(allowed.length).toBeGreaterThan(0)
      expect(allowed.filter((n) => !section.includes(`- ${n}:`))).toEqual([])
    }
  })

  it('says nothing of the removed control rail, its tasks or their foremen (#97)', async () => {
    const text = await wholeGuide()
    expect(text).not.toMatch(/control rail|control_|board_read|board_update|foreman|\btasks?\b/i)
  })
})
