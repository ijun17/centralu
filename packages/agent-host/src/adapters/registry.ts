import type { ToolName } from '@cc/protocol'
import { ClaudeAdapter } from './claude/index.js'
import { CodexAdapter } from './codex/index.js'
import { CursorAgentAdapter } from './cursor-agent/index.js'
import { AgyAdapter } from './agy/index.js'
import { OpenCodeAdapter } from './opencode/index.js'
import type { AgentAdapter } from './contract.js'

/**
 * The one place that names the vendors this build ships with.
 *
 * It used to be several. `ToolName` was an enum in `@cc/protocol` and `TOOL_META` beside it
 * held each vendor's label, glyph and install command, so a tool existed in the shared
 * protocol, in the adapter, and in every screen that drew a row per tool. Adding a third
 * (#59) meant finding all of them.
 *
 * Now an adapter introduces itself — `descriptor` rides along with `agents.detect` — and
 * this list is the only thing that has to change. Keeping it one function also gives the
 * descriptor tests something to hold: the rules that used to live in the protocol's shape
 * (marks are distinct, the commands are real) can only be checked across the whole set.
 */
export function createAdapters(): Map<ToolName, AgentAdapter> {
  const all: AgentAdapter[] = [new ClaudeAdapter(), new CodexAdapter(), new CursorAgentAdapter(), new OpenCodeAdapter(), new AgyAdapter()]
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
