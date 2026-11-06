import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fakeInstall, HOST_TEST_ARCHIVE } from '../packages/agent-host/src/adapters/antigravity/agent-files.test-helpers.js'
import { AntigravityAdapter, antigravityProfile, type AgyProfile } from '../packages/agent-host/src/adapters/antigravity/index.js'
import { fileURLToPath } from 'node:url'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec } from '../packages/agent-host/src/adapters/contract.js'

/** The cheapest model `agy models` offers that is Google's own flash, at its lowest thinking level: a recording only needs the frames */
export const AGY_MODEL = 'gemini-3.8-flash-low'

const MODEL_PROXY = fileURLToPath(new URL('./frames-record-agy-model.mjs', import.meta.url))

/**
 * Antigravity as the installed `agy` runs it (`agy acp`), in a folder of its own: the profile's data folder, `GEMINI_HOME`, `--gemini-dir`
 * and the process's home are all inside the run's temporary folder, so no setting, skill, conversation or log of the person's is read or
 * written. It holds a copy of the sign-in token alone (none for a signed-out scenario). The agent refreshes the access token from the
 * refresh token; if the copy changed, `finish` puts it back into the person's file unless that file changed meanwhile, as Codex's is.
 * The adapter is the real one with the real profile, but for what it starts: `agy acp` in place of the pinned archive's server
 * (Centralu pins a registry release; the installed CLI is the next one), and the version it reports.
 */
export function temporaryAgy(parent: string, scenario: string, signedOut: boolean): { adapter(spawn: (spec: AgentSpawnSpec) => AgentProcess): AgentAdapter; finish(): void } {
  const dir = join(parent, `agy-${scenario}`)
  const profile = antigravityProfile({ dataDir: dir })
  fakeInstall(profile.home, HOST_TEST_ARCHIVE)
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const real = join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  const copy = join(profile.home.geminiHome, 'antigravity-cli', 'antigravity-oauth-token')
  if (!signedOut) {
    if (!existsSync(real)) throw new Error('agy is not signed in: sign in with the agy CLI first')
    mkdirSync(dirname(copy), { recursive: true })
    copyFileSync(real, copy)
  }
  const before = signedOut ? '' : readFileSync(copy, 'utf8')
  const version = execFileSync('agy', ['--version'], { encoding: 'utf8' }).trim()
  const recorded: AgyProfile = {
    ...profile,
    async launch() {
      const started = await profile.launch()
      if (!started) throw new Error('the profile does not launch')
      // Through the proxy that sets the model (`frames-record-agy-model.mjs`)
      return { ...started, command: process.execPath, args: [MODEL_PROXY, AGY_MODEL, 'agy', 'acp', '--gemini-dir', profile.home.geminiHome, '--disable-telemetry'], env: { ...started.env, HOME: home, USERPROFILE: home } }
    },
    installedVersion: async () => version,
  }
  let done = false
  return {
    adapter: (spawn) => new AntigravityAdapter(recorded, spawn),
    finish() {
      if (done || signedOut) return
      done = true
      if (!existsSync(copy) || !existsSync(real)) return
      const now = readFileSync(copy, 'utf8')
      if (now === before) return
      if (readFileSync(real, 'utf8') !== before) return console.error("[record] the sign-in was refreshed during the run, and the person's own file was too: left as it is")
      const next = `${real}.${process.pid}.tmp`
      writeFileSync(next, now, { mode: 0o600 })
      renameSync(next, real)
      console.log("[record] the sign-in was refreshed during the run: kept in the person's token file")
    },
  }
}
