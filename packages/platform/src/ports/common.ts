export type Unsubscribe = () => void

export type PlatformError = {
  code: string
  message: string
  retryable: boolean
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'resync_required'

/** Which linked machine a question is for (#82, docs/plans/remote-hub.md); null or absent: this computer (the hub) */
export type MachineRef = string | null | undefined
