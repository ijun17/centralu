import { RESERVED_APP_IDS } from '@cc/protocol'
import type { OrchestratorTools } from '../adapters/contract.js'
import type { ExternalApps } from '../apps/external/runtime.js'
import type { Store } from '../dev-services/store.js'
import { proposedMcpServerNameError } from './orchestrator-tools.js'

/** One line of app description — within the manifest's cap (2000 characters), so a long command
 * does not turn into the wrong app */
const clampLine = (text: string): string => (text.length > 500 ? `${text.slice(0, 499)}…` : text)

/** The app_setting key where the orchestrator's MCP proposal list lives (propose_mcp_server flow) */
const MCP_PROPOSALS_KEY = 'orchestrator_mcp_proposals'
/**
 * The **old** directory of approved MCP servers (before M4 A-7). Approved servers now live as apps
 * in the user folder, and this key is only read by the migration (migrateApprovedMcpServers) — it
 * is never loaded into an adapter.
 */
const LEGACY_MCP_SERVERS_KEY = 'orchestrator_mcp_servers'

/** Orchestrator skills (#71) — live in the DB, not as files (a worker can write files but cannot
 * write to the DB) */
const SKILL_PROPOSALS_KEY = 'orchestrator_skill_proposals'
const SKILLS_KEY = 'orchestrator_skills'
/** Skill budget (the answer to #71's open question): cap count and length so it does not erode the
 * system prompt */
const SKILL_MAX_COUNT = 10
const SKILL_MAX_CHARS = 2_000

const isText = (v: unknown): v is string => typeof v === 'string'
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)

/**
 * A list kept in one app_settings row, read the way another build may have left it (#384): a row that is not JSON or
 * not a list reads as empty, and an element without the fields this build needs is skipped. An element keeps every
 * field it has, so writing the list back after a change does not drop what a newer build added to it.
 */
function storedList<T>(raw: string | null, has: (x: Record<string, unknown>) => boolean): T[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  return v.filter((x): x is T => typeof x === 'object' && x !== null && !Array.isArray(x) && has(x as Record<string, unknown>))
}

export interface ProposalResult {
  ok: boolean
  error?: string
}

/** A proposal answer, plus whether the caller has to restart the orchestrator **after** it (the
 * change is already saved by then) */
export type ProposalOutcome = ProposalResult & { restart: boolean }

/**
 * The orchestrator's MCP-server and skill proposals (#71, M4 A-7): proposing, the person's answer,
 * the approved skills, and the one-time move of previously approved servers into apps.
 *
 * It never restarts anything itself — an answer that changes what the orchestrator runs with says
 * so in `restart`, and the session manager does the restart.
 */
export class OrchestratorProposals {
  constructor(
    private readonly store: Pick<Store, 'appSetting' | 'setAppSetting' | 'deleteAppSetting'>,
    /** The external app runtime, or undefined on a host without one */
    private readonly apps: () => ExternalApps | undefined,
  ) {}

  /** MCP server proposals waiting on the person's approval */
  mcpProposals(): { name: string; command: string; args: string[]; why?: string }[] {
    return storedList(this.store.appSetting(MCP_PROPOSALS_KEY), (x) => isText(x.name) && isText(x.command) && isTextList(x.args))
  }

  /** Saves an MCP server proposal (propose_mcp_server) — validation and persistence only */
  proposeMcpServer(spec: Parameters<OrchestratorTools['proposeMcpServer']>[0]): ProposalResult {
    /*
     * The naming rule is **deliberately different** from the skill naming rule right below (#93).
     * A skill name is only ever used as a subheading in the role prompt, but an MCP server name
     * becomes a tool prefix, and that prefix is the basis on which an approval exception is
     * checked — the same letters carry a different weight. An `app-` prefix is blocked right here,
     * since that namespace belongs to external apps (M4 A-5, proposedMcpServerNameError).
     */
    const nameError = proposedMcpServerNameError(spec.name)
    if (nameError) return { ok: false, error: nameError }
    /*
     * Once approved, it becomes the user-folder app `<name>` (M4 A-7). So the name shares its slot
     * with app ids — it can never take a reserved id, or an existing user app's id. Overwriting one
     * is exactly swapping out a command.
     */
    if (RESERVED_APP_IDS.includes(spec.name)) {
      return { ok: false, error: `"${spec.name}" is a reserved app name — propose a different name` }
    }
    if (this.userAppExists(spec.name)) return { ok: false, error: `"${spec.name}" is already installed` }
    const proposals = this.mcpProposals().filter((p) => p.name !== spec.name)
    proposals.push({ name: spec.name, command: spec.command, args: spec.args, why: spec.why })
    this.store.setAppSetting(MCP_PROPOSALS_KEY, JSON.stringify(proposals))
    return { ok: true }
  }

  /** Saves a skill proposal (propose_skill) — validation and persistence only */
  proposeSkill(spec: Parameters<OrchestratorTools['proposeSkill']>[0]): ProposalResult {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(spec.name)) {
      return { ok: false, error: 'The name must be alphanumeric characters, hyphens, and underscores, 32 characters or fewer' }
    }
    if (!spec.content.trim()) return { ok: false, error: 'The content is empty' }
    if (spec.content.length > SKILL_MAX_CHARS) {
      return { ok: false, error: `The content is too long (${spec.content.length} characters > ${SKILL_MAX_CHARS}) — keep only the essentials of the procedure` }
    }
    if (this.orchestratorSkills().some((s) => s.name === spec.name)) {
      return { ok: false, error: `The "${spec.name}" skill already exists — the person has to delete it first before it can be changed` }
    }
    if (this.orchestratorSkills().length >= SKILL_MAX_COUNT) {
      return { ok: false, error: `There are already ${SKILL_MAX_COUNT} skills — the system prompt budget is full, so suggest to the person that a less-used one be deleted` }
    }
    const proposals = this.skillProposals().filter((p) => p.name !== spec.name)
    proposals.push({ name: spec.name, content: spec.content, why: spec.why })
    this.store.setAppSetting(SKILL_PROPOSALS_KEY, JSON.stringify(proposals))
    return { ok: true }
  }

  /** Does an app with this id already exist in the user folder — that is the slot an approved MCP server
   * lands in (even a broken manifest still occupies its slot) */
  private userAppExists(id: string): boolean {
    return !!this.apps()?.list().some((a) => a.projectId === null && a.appId === id)
  }

  /**
   * Approved MCP servers from the old directory (before M4 A-7) — read only by the migration.
   * A malformed entry is filtered out right here: there is nothing to migrate for an entry when it is unclear
   * what it would even launch.
   */
  private legacyMcpServers(): { name: string; command: string; args: string[] }[] {
    try {
      const raw = this.store.appSetting(LEGACY_MCP_SERVERS_KEY)
      const list = raw ? (JSON.parse(raw) as unknown) : []
      if (!Array.isArray(list)) return []
      return list.filter(
        (x): x is { name: string; command: string; args: string[] } =>
          !!x && typeof x.name === 'string' && typeof x.command === 'string' && Array.isArray(x.args) && x.args.every((a: unknown) => typeof a === 'string'),
      )
    } catch {
      return []
    }
  }

  /**
   * Migrates a previously approved MCP server into a user-folder app (M4 A-7) — runs once, when the
   * runtime is received (startup).
   *
   * **Idempotent no matter how many times it runs.** `installUserApp` is called for each entry, and
   * that function simply returns the existing app if an app for the same server already exists — if
   * migration is interrupted and runs again on the next startup, it never creates a duplicate app, and
   * an already-migrated app is never touched again.
   *
   * **Only entries that migrated successfully are removed from the old key.** An entry that failed to
   * migrate stays in the key and is retried on every startup, logging the reason. There are two kinds
   * of these: a name that cannot become an app id (like `centralu`, approved before #93 — that name
   * was shadowed by a built-in server and never ran even once), and an id where a different app already
   * exists (an app the person built is never overwritten). A leftover entry is never loaded anywhere —
   * the adapter no longer reads this key at all. Once everything migrates, the key is deleted.
   */
  migrateApprovedMcpServers(rt: ExternalApps): void {
    const legacy = this.legacyMcpServers()
    if (legacy.length === 0) {
      if (this.store.appSetting(LEGACY_MCP_SERVERS_KEY) !== null) this.store.deleteAppSetting(LEGACY_MCP_SERVERS_KEY)
      return
    }
    const left: typeof legacy = []
    for (const s of legacy) {
      try {
        rt.installUserApp({
          id: s.name,
          name: s.name,
          description: clampLine(`Previously approved MCP server (propose_mcp_server): ${[s.command, ...s.args].join(' ')}`),
          server: { command: s.command, args: s.args },
        })
      } catch (err) {
        left.push(s)
        console.error(`[apps] approved MCP server "${s.name}" was not moved into an app: ${(err as Error).message}`)
      }
    }
    if (left.length === 0) this.store.deleteAppSetting(LEGACY_MCP_SERVERS_KEY)
    else this.store.setAppSetting(LEGACY_MCP_SERVERS_KEY, JSON.stringify(left))
    const moved = legacy.length - left.length
    if (moved > 0) console.error(`[apps] ${moved} approved MCP server(s) moved into user-folder apps`)
  }

  /** Skill proposals waiting on the person's approval (#71) */
  skillProposals(): { name: string; content: string; why?: string }[] {
    return storedList(this.store.appSetting(SKILL_PROPOSALS_KEY), (x) => isText(x.name) && isText(x.content))
  }

  /** Skills that have been approved and loaded into the orchestrator's role prompt (#71) */
  orchestratorSkills(): { name: string; content: string }[] {
    return storedList(this.store.appSetting(SKILLS_KEY), (x) => isText(x.name) && isText(x.content))
  }

  /**
   * Turns approved skills into a block appended to the role prompt (#71). This is tool-agnostic text
   * — the same text goes to Claude as a systemPrompt append and to Codex as developerInstructions
   * (one authoring format, N adapters — the same kind of line NormalizedEvent draws for events).
   */
  skillsPrompt(): string {
    const skills = this.orchestratorSkills()
    if (skills.length === 0) return ''
    return (
      '\n\n## Approved skills (procedures the person has approved — follow them in the matching situation)\n' +
      skills.map((s) => `### ${s.name}\n${s.content}`).join('\n\n')
    )
  }

  /** The person's answer to a skill proposal (#71) — if approved, it is saved and the orchestrator is
   * restarted */
  resolveSkillProposal(name: string, approve: boolean): ProposalOutcome {
    const proposals = this.skillProposals()
    const hit = proposals.find((p) => p.name === name)
    if (!hit) return { ok: false, error: `No pending skill proposal named "${name}"`, restart: false }
    this.store.setAppSetting(SKILL_PROPOSALS_KEY, JSON.stringify(proposals.filter((p) => p.name !== name)))
    if (!approve) return { ok: true, restart: false }

    const skills = this.orchestratorSkills().filter((s) => s.name !== name)
    skills.push({ name: hit.name, content: hit.content })
    this.store.setAppSetting(SKILLS_KEY, JSON.stringify(skills))
    return { ok: true, restart: true }
  }

  /** Deletes a skill (the answer to #71's open question: a skill that can only be added, never removed, is
   * worse than none at all) */
  deleteOrchestratorSkill(name: string): ProposalOutcome {
    const skills = this.orchestratorSkills()
    if (!skills.some((s) => s.name === name)) return { ok: false, error: `No skill named "${name}"`, restart: false }
    this.store.setAppSetting(SKILLS_KEY, JSON.stringify(skills.filter((s) => s.name !== name)))
    // If a deleted skill stayed in the prompt, the deletion would be a lie — it is swapped in immediately
    return { ok: true, restart: true }
  }

  /**
   * The person's answer to a proposal (dogfooding request, option b — propose -> one-click approval
   * -> the app installs and restarts).
   *
   * If approved, that server becomes **a viewless app in the user folder** (M4 A-7, decision 8). Once
   * it is an app, calls go through the broker (visibility, run log), it comes up only when first
   * needed and goes back down when idle, and it can be removed from the list (`apps.remove`). A
   * user-folder app is attached to the orchestrator (decision 4) — the same slot a previously approved
   * server used to attach to. In a session, its server name is `app-<name>`.
   *
   * And this **restarts the orchestrator** — since a restart is a resume, the conversation continues.
   * Claude's server set can change without a restart (setMcpServers), but Codex only ever receives its
   * server set when a new thread is launched. What the person approving is waiting for is "usable
   * now", so this goes through the same path regardless of the tool.
   *
   * If the app fails to be created, the proposal is left in place — the person can see why and reject it.
   */
  resolveMcpProposal(name: string, approve: boolean): ProposalOutcome {
    const proposals = this.mcpProposals()
    const hit = proposals.find((p) => p.name === name)
    if (!hit) return { ok: false, error: `No pending proposal named "${name}"`, restart: false }
    const dropProposal = () => this.store.setAppSetting(MCP_PROPOSALS_KEY, JSON.stringify(proposals.filter((p) => p.name !== name)))
    if (!approve) {
      dropProposal()
      return { ok: true, restart: false }
    }

    const rt = this.apps()
    if (!rt) return { ok: false, error: 'External apps are unavailable — the approved server has nowhere to run', restart: false }
    try {
      rt.installUserApp({
        id: hit.name,
        name: hit.name,
        description: clampLine(hit.why?.trim() || `MCP server approved by the person (propose_mcp_server): ${[hit.command, ...hit.args].join(' ')}`),
        server: { command: hit.command, args: hit.args },
      })
    } catch (err) {
      return { ok: false, error: `Could not install "${name}" as an app: ${(err as Error).message}`, restart: false }
    }
    dropProposal()

    // Swapped even while it is running — what the person who approved this is waiting for is "usable now"
    return { ok: true, restart: true }
  }
}
