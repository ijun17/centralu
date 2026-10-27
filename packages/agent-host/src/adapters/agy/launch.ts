/**
 * The arguments that start one `agy` process for a session (docs/plans/antigravity-adapter.md §3.1). A plain function: the
 * session core starts a NEW process after every interrupt and every change of model or effort (`agy` ends its process on
 * SIGINT), each time with `--conversation`, so it asks for the arguments again with the conversation id it learned.
 *
 * `-p=` is last: `-p` takes a value, and stream-json input needs the empty one attached to the flag (§1.1). Never
 * `--continue` (it picks the folder's latest conversation, which may be another session's, §3.1).
 */
export type AgyLaunch = {
  model?: string
  effort?: string
  /** The folder with Centralu's hooks and tools, passed as a customization root (§3.2) */
  pluginRoot: string
  /** The conversation to resume (`externalId`) */
  resume?: string | null
}

export function launchArgs(o: AgyLaunch): string[] {
  return [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    // The gate is the only permission check (§1.2): `agy`'s own would soft-deny what the gate allowed
    '--dangerously-skip-permissions',
    '--add-dir',
    o.pluginRoot,
    ...(o.resume ? ['--conversation', o.resume] : []),
    '-p=',
  ]
}
