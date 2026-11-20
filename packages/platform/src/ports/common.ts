export type Unsubscribe = () => void

export type PlatformError = {
  code: string
  message: string
  retryable: boolean
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'resync_required'

/**
 * Which linked machine a per-machine question is for (#82, docs/plans/remote-hub.md): its agent
 * CLIs, its usage, its folders. Null or absent: this computer (the hub).
 */
export type MachineRef = string | null | undefined
