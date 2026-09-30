import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PermissionPreset } from '@cc/protocol'
import type { OrchestratorTools } from '../contract.js'

/**
 * Files in an untrusted project do not reach a Codex thread (M4 decision 3, #92).
 *
 * The whole of this contract is "what did we send when starting the thread" (the same approach as
 * verbosity.test.ts). What Codex does with that value was confirmed only from source and the
 * 0.153.4 binary (logged out — see the comment on repoFilesConfig).
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start' || method === 'thread/resume') return Promise.resolve({ thread: { id: 't1' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const paramsOf = (method: string) => state.requests.find((r) => r.method === method)?.params as Record<string, unknown>
const configOf = (method: string) => paramsOf(method).config as Record<string, unknown>

let cwd: string
beforeEach(() => {
  state.requests.length = 0
  // macOS's temp folder sits under a /var -> /private/var symlink — a real case where the two spellings diverge
  cwd = mkdtempSync(join(tmpdir(), 'cc-codex-trust-'))
})

const start = (permissionPreset: PermissionPreset, projectTrusted: boolean | undefined, extra: Record<string, unknown> = {}) =>
  new CodexAdapter().createSession({ sessionId: 's1', cwd, permissionPreset, projectTrusted, ...extra }, () => {})

const PRESET: Record<PermissionPreset, Record<string, unknown>> = {
  safe: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  normal: {},
  auto: { approvalPolicy: 'never', sandbox: 'workspace-write' },
}

function ancestors(p: string): string[] {
  const out: string[] = []
  for (let d = p; ; d = dirname(d)) {
    out.push(d)
    if (dirname(d) === d) return out
  }
}

describe('do files in the repository reach a Codex thread (#92)', () => {
  for (const preset of ['safe', 'normal', 'auto'] as const) {
    it(`${preset}: for an untrusted project, that folder and every ancestor are written "untrusted", only for this thread — the permission options are unchanged`, async () => {
      await start(preset, false)
      const params = paramsOf('thread/start')
      const config = configOf('thread/start')
      // Both the path as written and the real path (with symlinks resolved), all the way to the root
      const keys = [...new Set([...ancestors(cwd), ...ancestors(realpathSync.native(cwd))])]
      expect(config.projects).toEqual(Object.fromEntries(keys.map((k) => [k, { trust_level: 'untrusted' }])))
      expect(config.project_doc_max_bytes).toBe(0)
      // The preset's permission mapping is independent of trust — normal still follows the user's own ~/.codex/config.toml
      expect({ approvalPolicy: params.approvalPolicy, sandbox: params.sandbox }).toEqual({
        approvalPolicy: PRESET[preset].approvalPolicy,
        sandbox: PRESET[preset].sandbox,
      })
    })

    it(`${preset}: a trusted project is unchanged from before — neither trust nor a document ceiling is loaded`, async () => {
      await start(preset, true)
      const params = paramsOf('thread/start')
      const config = configOf('thread/start')
      expect(config.projects).toBeUndefined()
      expect(config.project_doc_max_bytes).toBeUndefined()
      expect({ approvalPolicy: params.approvalPolicy, sandbox: params.sandbox }).toEqual({
        approvalPolicy: PRESET[preset].approvalPolicy,
        sandbox: PRESET[preset].sandbox,
      })
    })
  }

  it('the same decision is loaded on resume too — settings from the repository must not come back alive after waking up', async () => {
    await start('normal', false, { resumeExternalId: 'ext-1' })
    const config = configOf('thread/resume')
    expect(config.projects).toMatchObject({ [cwd]: { trust_level: 'untrusted' } })
    expect(config.project_doc_max_bytes).toBe(0)

    state.requests.length = 0
    await start('normal', true, { resumeExternalId: 'ext-1' })
    expect(configOf('thread/resume').projects).toBeUndefined()
  })

  it('unknown trust means untrusted — even an orchestrator with no project starts that folder as "untrusted"', async () => {
    await start('normal', undefined, {
      orchestratorTools: {} as OrchestratorTools,
      orchestratorBridge: { url: 'ws://127.0.0.1:1', token: 't' },
    })
    const config = configOf('thread/start')
    expect(config.projects).toMatchObject({ [cwd]: { trust_level: 'untrusted' } })
    expect(config.project_doc_max_bytes).toBe(0)
    expect(config.mcp_servers).toBeDefined() // Merged into one block — neither overwrites the other
  })

  const BRIDGE = { orchestratorTools: {} as OrchestratorTools, orchestratorBridge: { url: 'ws://127.0.0.1:1', token: 't' } }

  it('a session reading no files at all (noSettingFiles — orchestrator and coordination sessions) turns off the repository layer even when marked trusted — both start and resume', async () => {
    await start('normal', true, { ...BRIDGE, noSettingFiles: true, toolProfile: 'orchestrator' })
    await start('normal', true, { ...BRIDGE, noSettingFiles: true, toolProfile: 'scoped', resumeExternalId: 'ext-1' })
    for (const method of ['thread/start', 'thread/resume']) {
      expect(configOf(method).projects).toMatchObject({ [cwd]: { trust_level: 'untrusted' } })
      expect(configOf(method).project_doc_max_bytes).toBe(0)
    }
  })

  /*
   * Merely receiving the bridge (orchestrator tools) does not turn off AGENTS.md (#152). It used
   * to load `project_doc_max_bytes: 0` whenever the bridge was present, so the manager and the
   * session that creates the worktree lost AGENTS.md even in a trusted project.
   */
  it('a project session that receives the bridge (manager, session that creates it) follows trust just like a worker — both start and resume', async () => {
    const seen: string[] = []
    for (const toolProfile of ['manager', 'builder'] as const) {
      for (const projectTrusted of [true, false]) {
        for (const resumeExternalId of [undefined, 'ext-1']) {
          state.requests.length = 0
          await start('normal', projectTrusted, { ...BRIDGE, toolProfile, resumeExternalId })
          const config = configOf(resumeExternalId ? 'thread/resume' : 'thread/start')
          seen.push(`${toolProfile} trusted=${projectTrusted} ${resumeExternalId ? 'resume' : 'start'}: doc=${config.project_doc_max_bytes ?? 'read'} projects=${config.projects ? 'untrusted' : 'untouched'}`)
          expect(config.mcp_servers).toBeDefined()
        }
      }
    }
    expect(seen).toEqual([
      'manager trusted=true start: doc=read projects=untouched',
      'manager trusted=true resume: doc=read projects=untouched',
      'manager trusted=false start: doc=0 projects=untrusted',
      'manager trusted=false resume: doc=0 projects=untrusted',
      'builder trusted=true start: doc=read projects=untouched',
      'builder trusted=true resume: doc=read projects=untouched',
      'builder trusted=false start: doc=0 projects=untrusted',
      'builder trusted=false resume: doc=0 projects=untrusted',
    ])
  })
})

/*
 * An inherited handoff note (#142) — Codex **changes nothing** even when given the note folder.
 * Neither readOnly nor workspaceWrite in the generated type (codex-cli 0.153.4 `SandboxPolicy`)
 * has a read scope — the only thing blocked is writing outside the writable roots
 * (`writableRoots`), so a note in the data folder is already readable. Touching the sandbox would
 * only end up overriding the user's own settings (normal). We could not confirm with a real
 * thread while logged out — what this checks is that "what is sent stays the same."
 */
describe('the folder for an inherited note (#142)', () => {
  for (const preset of ['safe', 'normal', 'auto'] as const) {
    it(`${preset}: what is sent to the thread and turn stays the same even when readableDirs is given — neither the writable roots nor the sandbox widens`, async () => {
      const sent = async (extra: Record<string, unknown>) => {
        state.requests.length = 0
        const h = await start(preset, true, extra)
        h.send('please read the notes')
        await vi.waitFor(() => expect(paramsOf('turn/start')).toBeDefined())
        await h.dispose()
        return state.requests.map((r) => ({ method: r.method, params: JSON.stringify(r.params) }))
      }
      const plain = await sent({})
      const heir = await sent({ readableDirs: [join(cwd, 'data', 'handoff', 'p1')] })
      expect(heir).toEqual(plain)
      expect(JSON.stringify(heir)).not.toMatch(/writableRoots|sandboxPolicy|handoff/)
    })
  }
})
