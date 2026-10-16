import { z } from 'zod'

/**
 * Where this install stands against the registry (issue #43).
 *
 * **One shape carries both the answer and what we are doing about it.** The check and
 * the update are two steps of one errand ("am I behind, and can I stop being behind"),
 * and the screen shows one line for the whole errand — splitting them would force the
 * UI to stitch two facts back together and to invent what to show when they disagree.
 *
 * The host owns every field here; nothing on this list is decided on the UI side.
 */
export const UpdateStatus = z.object({
  /** The running build's version — `APP_VERSION`, the value this app was built from */
  current: z.string(),
  /**
   * What the registry's `latest` tag points at, or null until a check has succeeded.
   *
   * Null is not "up to date". A check that never reached the network must not read as
   * good news — that mistake is what let #42 hide for a whole release.
   */
  latest: z.string().nullable().default(null),
  /** `latest` outranks `current`, by the comparison the launcher ships (`isNewerVersion`) */
  newer: z.boolean().default(false),
  /** Whether the host re-checks on its own schedule. Settings turns this on and off */
  auto: z.boolean().default(true),
  /**
   * "Apply updates automatically when idle" (#352). Off by default. With it on, the host
   * installs a newer version as soon as a check finds one, and the desktop window applies it
   * (relaunch, then the keeper and host switch) once nothing is busy.
   *
   * Defaults to false so a window attached to an older host that sends no such field reads
   * it as off (protocol.md §4: a field added to a host payload carries a default).
   */
  autoApply: z.boolean().default(false),
  /**
   * What the update is doing right now.
   *
   * `restart_required` is where the host stops: the new version is on disk and the running
   * process is still the old one. The host never replaces the running app itself. What
   * comes next is the window's (#352): "Apply now" relaunches it from the updated bundle, or,
   * with `autoApply`, it does so by itself once no session is working or waiting and no
   * terminal or command is running — never mid-turn.
   */
  phase: z.enum(['idle', 'checking', 'updating', 'waiting_for_npm', 'restart_required', 'failed']).default('idle'),
  /**
   * Why the last check or update did not work, or null when nothing went wrong.
   *
   * A failed *check* is swallowed everywhere it matters (it never breaks startup and
   * never interrupts) but it is still recorded here, because "Check now" that answers
   * with nothing at all is indistinguishable from a button that does nothing.
   */
  error: z.string().nullable().default(null),
  /** When the last successful check finished (epoch ms), or null if none ever has */
  checkedAt: z.number().nullable().default(null),
})
export type UpdateStatus = z.infer<typeof UpdateStatus>

/**
 * The agent CLIs installed on this machine, and whether sessions move to a newer one by
 * themselves (#297).
 *
 * Every session runs its own agent process, started from the CLI that was installed at the time.
 * An update to `claude` or `codex` reaches a session only when its process starts again, and with
 * the keeper (#280) a process can outlive many app restarts. This is the host's half of noticing:
 * which version is installed now. Which version each session runs is on the session
 * (`SessionInfo.agentVersion`).
 *
 * Owned by the host, like `UpdateStatus`: the host reads the installed versions and the host
 * restarts sessions.
 */
export const AgentVersions = z.object({
  /**
   * The version installed now, by tool name. Null: the tool is not installed, or its version could
   * not be read. A tool missing from the record has not been checked yet.
   */
  installed: z.record(z.string(), z.string().nullable()).default({}),
  /**
   * "Move idle sessions to a newly installed agent CLI" (#297). **On by default** (the owner's
   * decision, 2026-10-05): with it on, a session whose process is older than the installed CLI is
   * restarted on the new one once it is fully idle. The conversation continues through resume.
   *
   * Defaults to true so a window on an older host that sends no such field reads it as the setting
   * a host that never saw it would have (protocol.md §4).
   */
  autoApply: z.boolean().default(true),
  /** When the installed versions were last read (epoch ms), or null if never */
  checkedAt: z.number().nullable().default(null),
})
export type AgentVersions = z.infer<typeof AgentVersions>

/**
 * When the host puts an idle session to sleep (#568, docs/agent-host.md §4.6.1). Each session runs its own agent process
 * (a Claude process was 240-300 MB after a few turns and kept growing while idle, #561); a session that has been idle
 * this long has its process ended and stays listed, asleep, until a message or its composer wakes it.
 *
 * Owned by the host, like `AgentVersions`: the host decides and ends the processes.
 */
export const SleepPolicy = z.object({
  /** Minutes of quiet before an idle session sleeps; null never. 15 by default (the owner's decision, 2026-10-12) */
  afterMinutes: z.number().int().positive().nullable().default(15),
})
export type SleepPolicy = z.infer<typeof SleepPolicy>
