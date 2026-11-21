import { z } from 'zod'

/** Where this install stands against the registry, and the host's update: docs/agent-host/lifecycle/updates.md */
export const UpdateStatus = z.object({
  current: z.string(),
  /** Null until a check succeeds, and never "up to date": a check that reached no network is no good news */
  latest: z.string().nullable().default(null),
  /** By the comparison the launcher ships (`isNewerVersion`) */
  newer: z.boolean().default(false),
  /** The host re-checks on its own schedule */
  auto: z.boolean().default(true),
  /** Install, then relaunch once nothing is busy. The host's stored default is on; the wire's is off, for older hosts */
  autoApply: z.boolean().default(false),
  /** The host stops at `restart_required`; an unknown phase reads `updating` (docs/protocol.md §4), showing `error` */
  phase: z
    .enum(['idle', 'checking', 'updating', 'waiting_for_npm', 'restart_required', 'failed'])
    .default('idle')
    .catch('updating'),
  /** A failed check is recorded too, or "Check now" would look like a dead button */
  error: z.string().nullable().default(null),
  checkedAt: z.number().nullable().default(null),
})
export type UpdateStatus = z.infer<typeof UpdateStatus>

/** Installed agent CLIs, and whether sessions move to a newer one: docs/agent-host/lifecycle/agent-cli-updates.md */
export const AgentVersions = z.object({
  /** By tool name. Null: not installed, or unreadable; a tool absent is not checked yet */
  installed: z.record(z.string(), z.string().nullable()).default({}),
  /** An idle session older than the installed CLI restarts on it and resumes; true is what an older host means */
  autoApply: z.boolean().default(true),
  checkedAt: z.number().nullable().default(null),
})
export type AgentVersions = z.infer<typeof AgentVersions>

/** docs/agent-host/lifecycle/agent-cli-updates.md "Putting idle sessions to sleep" */
export const SleepPolicy = z.object({
  /** Minutes of quiet before an idle session's process ends; null never */
  afterMinutes: z.number().int().positive().nullable().default(15),
})
export type SleepPolicy = z.infer<typeof SleepPolicy>
