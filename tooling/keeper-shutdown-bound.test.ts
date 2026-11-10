/**
 * The keeper (Rust) and the host (TypeScript) name one number: how long a host's shutdown may take (#2141, #2142). A Windows host is
 * given that and a margin after the polite request, so it is not ended while it waits for the stops of its terminals' trees. It is two
 * languages, so this fails when they differ.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHUTDOWN_BOUND_MS } from '../packages/agent-host/src/lifecycle/shutdown.js'

describe("the keeper's name for the host's shutdown bound", () => {
  it('is the same number as the host has', () => {
    const rs = readFileSync(fileURLToPath(new URL('../apps/desktop/src-tauri/keeper/src/host_proc/mod.rs', import.meta.url)), 'utf8')
    const secs = /pub const HOST_SHUTDOWN_BOUND: Duration = Duration::from_secs\((\d+)\);/.exec(rs)?.[1]
    expect(Number(secs) * 1000).toBe(SHUTDOWN_BOUND_MS)
  })
})
