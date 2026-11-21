import type { ToolName } from '@cc/protocol'
import { AntigravityAdapter, antigravityProfile } from './antigravity/index.js'
import { ClaudeAdapter } from './claude/index.js'
import { CodexAdapter } from './codex/index.js'
import { CursorAgentAdapter } from './cursor-agent/index.js'
import { OpenCodeAdapter } from './opencode/index.js'
import type { AgentAdapter } from './contract.js'

/**
 * The one place that names the vendors this build ships with (#59): an adapter introduces itself (`descriptor` rides along
 * with `agents.detect`), so neither the shared protocol nor a screen lists them, and a new tool changes only this list. One
 * function gives the descriptor tests the whole set, the only place their rules (distinct marks, real commands) can be checked.
 */
export function createAdapters(opts: { openUrl?: (url: string) => void } = {}): Map<ToolName, AgentAdapter> {
  // `openUrl`: the host's way to open an address for the person outside its work (Antigravity's sign-in, `main.ts`)
  const all: AgentAdapter[] = [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new CursorAgentAdapter(),
    new OpenCodeAdapter(),
    new AntigravityAdapter(antigravityProfile(opts.openUrl ? { signIn: { openUrl: opts.openUrl } } : {})),
  ]
  return new Map(all.map((a) => [a.tool, a]))
}

/**
 * The registry is the only fallback for a tool choice. A saved name wins only while this build
 * still ships its adapter; otherwise the first registered adapter is the compatible default.
 * An empty registry has no default: a host can serve projects and apps without any agent adapters.
 */
export function registeredTool(adapters: ReadonlyMap<ToolName, AgentAdapter>, preferred?: ToolName | null): ToolName | null {
  if (preferred && adapters.has(preferred)) return preferred
  return adapters.keys().next().value ?? null
}
