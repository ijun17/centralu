import { join } from 'node:path'
import type { ToolName } from '@cc/protocol'
import type { KeptRun } from '../dev-services/commands.js'
import type { KeptTerminal, PtyModule } from '../dev-services/terminal.js'
import type { AgentProcessHost, KeptAgent } from '../sessions/manager.js'
import { KeeperAgentProcess } from './agent-process.js'
import { KeeperChildren, type KeptChild } from './children-client.js'
import { KeeperPty, keeperPtyModule } from './keeper-pty.js'
import { parseTag } from './tags.js'

/**
 * What a host started by the keeper gets from it (#280 step 2): where to spawn agents and ptys so
 * they outlive this host, and what a previous host left running, sorted by kind for the services
 * that take each over.
 */
export type HeldChildren = {
  children: KeeperChildren
  processes: AgentProcessHost
  ptys: PtyModule
  kept: {
    agents: KeptAgent[]
    terminals: KeptTerminal[]
    runs: KeptRun[]
    /** Sessions with a live process among `agents` — their state survives the startup reset */
    sessionIds: Set<string>
  }
  /** Pids of the children still alive, for the stray scan (strays.ts rule 3) */
  heldPids(): Promise<number[]>
}

/**
 * Sorts what the keeper holds. Live agents, terminals and runs are taken over; a run that ended
 * while no host was attached is taken over too (its log and exit code are the point of keeping it);
 * an exited agent or terminal has nothing to give and is released. A tag this build does not read
 * is left alone — a newer build may have written it.
 */
export function sortKept(
  list: readonly KeptChild[],
  adopt: { agent(c: KeptChild): KeptAgent['process']; pty(c: KeptChild): KeptTerminal['pty'] },
): { kept: HeldChildren['kept']; release: string[] } {
  const kept: HeldChildren['kept'] = { agents: [], terminals: [], runs: [], sessionIds: new Set() }
  const release: string[] = []
  for (const c of list) {
    const tag = parseTag(c.tag)
    if (!tag) continue
    if (tag.kind === 'agent') {
      if (!c.alive) {
        release.push(c.id)
        continue
      }
      kept.agents.push({
        sessionId: tag.sessionId,
        tool: tag.tool as ToolName,
        process: adopt.agent(c),
        ...(tag.version ? { version: tag.version } : {}),
      })
      kept.sessionIds.add(tag.sessionId)
    } else if (tag.kind === 'terminal') {
      if (!c.alive) {
        release.push(c.id)
        continue
      }
      kept.terminals.push({ id: tag.id, cwd: tag.cwd, pty: adopt.pty(c), cols: c.cols, rows: c.rows })
    } else {
      kept.runs.push({ cwd: tag.cwd, command: tag.command, runId: tag.runId, startedAt: tag.startedAt, pty: adopt.pty(c) })
    }
  }
  return { kept, release }
}

/**
 * Connects to the keeper's child service in this data folder. Null when there is none to reach —
 * an older keeper, or a socket that would not bind: the host then spawns its own children as it
 * always did, and a restart ends them as it always did.
 */
export async function connectHeldChildren(dataDir: string): Promise<HeldChildren | null> {
  let children: KeeperChildren
  let list: KeptChild[]
  try {
    children = await KeeperChildren.connect(join(dataDir, 'children.sock'))
    list = await children.list()
  } catch (err) {
    console.error(`[keeper] no child service (${(err as Error).message}); this host keeps its own children`)
    return null
  }
  const { kept, release } = sortKept(list, {
    agent: (c) => KeeperAgentProcess.adopt(children, c),
    pty: (c) => KeeperPty.adopt(children, c),
  })
  for (const id of release) void children.release(id).catch(() => {})
  const n = kept.agents.length + kept.terminals.length + kept.runs.length
  console.error(
    `[keeper] child service connected (keeper pid ${children.keeperPid}); taking over ${n} kept: ` +
      `${kept.agents.length} agents, ${kept.terminals.length} terminals, ${kept.runs.length} command runs`,
  )
  return {
    children,
    processes: {
      spawn: (sessionId, tool, spec, version) =>
        KeeperAgentProcess.spawn(children, spec, { kind: 'agent', tool, sessionId, ...(version ? { version } : {}) }),
    },
    ptys: keeperPtyModule(children),
    kept,
    heldPids: async () => (await children.list()).filter((c) => c.alive).map((c) => c.pid),
  }
}
