import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { ToolName } from '@cc/protocol'
import { DRAINED, ENDED, PROBLEM, STARTED } from '../../packages/agent-host/src/adapters/frames/replay-agent.test-helpers.js'
import { Store } from '../../packages/agent-host/src/dev-services/store.js'
import { freePort, hostCall, Relay } from './real-host.js'
import { side, startLinkedHost, type LinkedHost, type Side } from './linked-hosts.js'

// What the replay project's own server is built with (e2e/playwright.config.ts)
const REPLAY_TOKEN = 'e2e-replay-token'
const REPLAY_UI_ORIGIN = 'http://127.0.0.1:5181'
const REPLAY_RELAY_PORT = 5182

/**
 * A host whose agents are recorded sessions (#1498, `replay-agent.test-helpers.ts`): the real store, session manager and
 * adapters on one temporary data folder, the page reaching it through the relay the replay project is built with.
 * Each recording a test plays is a project named after it, since a session replays the scenario its folder is named after.
 * The tests of a worker share one host (starting it takes about two seconds, which was most of a test), each reading only
 * what the host says from the moment its run began (`run`).
 */

export type ReplayHost = { host: LinkedHost; side: Side; relay: Relay; projectId(scenario: string): string; folder(scenario: string): string; run(): ReplayRun; cleanup(): Promise<void> }

/** One test's part of a host that many tests share: what the host says from the moment the run began */
export type ReplayRun = {
  /** Everything the host has written to stderr since the run began */
  stderr(): string
  /** What the replay found wrong: a frame the adapter sent that the recording does not hold, and a process that ended with frames of its own it was not given */
  problems(): string[]
  /** How many processes the adapter has started so far in the run */
  starts(): number
  /** Whether the recording was played to its end: its last frame was written, or a process ended and none of the recording is left to start */
  toTheEnd(): boolean
  /** Deletes the session, which stops its process, and waits until every process the run started has said that it ended */
  end(sessionId: string): Promise<void>
}

const lines = (text: string, start: string): string[] => text.split('\n').filter((l) => l.startsWith(start))

/** A host with a project for each of `scenarios` (a scenario of two tools is one project: a session replays the recording of its own tool) */
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
  const host = await startLinkedHost(s, await freePort(), undefined, { agent: 'replay', token: REPLAY_TOKEN, origin: REPLAY_UI_ORIGIN })
  const relay = new Relay(() => host.port)
  try {
    await relay.listen(REPLAY_RELAY_PORT)
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
    run() {
      const from = host.stderr().length
      const said = () => host.stderr().slice(from)
      const run: ReplayRun = {
        stderr: said,
        problems: () => [...lines(said(), PROBLEM), ...lines(said(), ENDED).filter((l) => !l.includes(' own=0 '))],
        starts: () => lines(said(), STARTED).length,
        toTheEnd: () => lines(said(), DRAINED).length > 0 || lines(said(), ENDED).some((l) => l.endsWith(' later=0')),
        async end(sessionId) {
          await hostCall(host.port, 'agents.deleteSession', { sessionId }, REPLAY_TOKEN)
          await expect.poll(() => lines(said(), ENDED).length >= run.starts(), { timeout: 15_000 }).toBe(true)
        },
      }
      return run
    },
    async cleanup() {
      await relay.close()
      await host.kill()
      // Windows keeps a folder busy for a moment after the process that had it open is gone
      rmSync(s.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    },
  }
}

/** A session in the project of `scenario`, made the way a person's new session is but with the preset the recording was made under, and opened */
export async function openSession(page: Page, replay: ReplayHost, scenario: string, tool: ToolName, preset: string): Promise<string> {
  const cwd = replay.folder(scenario)
  const made = (await hostCall(replay.host.port, 'agents.createSession', { projectId: replay.projectId(scenario), cwd, tool, permissionPreset: preset }, REPLAY_TOKEN)).result as { id: string }
  await page.getByTestId(`session-row-${made.id}`).click()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
  return made.id
}
