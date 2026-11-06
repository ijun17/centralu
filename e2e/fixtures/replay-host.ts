import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { ToolName } from '@cc/protocol'
import { DRAINED, ENDED, PROBLEM, STARTED } from '../../packages/agent-host/src/adapters/frames/replay-agent.test-helpers.js'
import { Store } from '../../packages/agent-host/src/dev-services/store.js'
import { freePort, hostCall, Relay } from './real-host.js'
import { LINKED_RELAY_PORT, LINKED_TOKEN, side, startLinkedHost, type LinkedHost, type Side } from './linked-hosts.js'

/**
 * A host whose agents are recorded sessions (#1498, `replay-agent.test-helpers.ts`): the real store, session manager and
 * adapters on one temporary data folder, the page reaching it through the relay the linked-hosts project is built with.
 * Each recording a test plays is a project named after it, since a session replays the scenario its folder is named after.
 */

export type ReplayHost = { host: LinkedHost; side: Side; relay: Relay; projectId(scenario: string): string; folder(scenario: string): string; cleanup(): Promise<void> }

const lines = (host: LinkedHost, start: string): string[] => host.stderr().split('\n').filter((l) => l.startsWith(start))

/** What the replay found wrong: a frame the adapter sent that the recording does not hold, and a process that ended with frames of its own it was not given */
export const replayProblems = (host: LinkedHost): string[] => [...lines(host, PROBLEM), ...lines(host, ENDED).filter((l) => !l.includes(' own=0 '))]

/** How many processes the adapter has started so far */
export const replayStarts = (host: LinkedHost): number => lines(host, STARTED).length

/** Whether the recording was played to its end: its last frame was written, or a process ended and none of the recording is left to start */
export const replayedToTheEnd = (host: LinkedHost): boolean => lines(host, DRAINED).length > 0 || lines(host, ENDED).some((l) => l.endsWith(' later=0'))

export async function startReplayHost(scenarios: readonly string[]): Promise<ReplayHost> {
  const s = side('replay')
  const projectId = (scenario: string) => `p-${scenario}`
  const folder = (scenario: string) => join(s.dir, 'projects', scenario)
  const store = new Store(s.db)
  try {
    store.settings.setAppSetting('updates.auto', 'false')
    for (const scenario of scenarios) {
      const path = folder(scenario)
      mkdirSync(path, { recursive: true })
      store.projects.addProject({ id: projectId(scenario), path, name: scenario })
    }
  } finally {
    store.close()
  }
  const host = await startLinkedHost(s, await freePort(), undefined, { agent: 'replay' })
  const relay = new Relay(() => host.port)
  try {
    await relay.listen(LINKED_RELAY_PORT)
  } catch (err) {
    // A port still held by an earlier run: the host this started is not left running
    await host.kill()
    rmSync(s.dir, { recursive: true, force: true })
    throw err
  }
  return {
    host,
    side: s,
    relay,
    projectId,
    folder,
    async cleanup() {
      await relay.close()
      await host.kill()
      rmSync(s.dir, { recursive: true, force: true })
    },
  }
}

/** A session in the project of `scenario`, made the way a person's new session is but with the preset the recording was made under, and opened */
export async function openSession(page: Page, replay: ReplayHost, scenario: string, tool: ToolName, preset: string): Promise<string> {
  const cwd = replay.folder(scenario)
  const made = (await hostCall(replay.host.port, 'agents.createSession', { projectId: replay.projectId(scenario), cwd, tool, permissionPreset: preset }, LINKED_TOKEN)).result as { id: string }
  await page.getByTestId(`session-row-${made.id}`).click()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
  return made.id
}
