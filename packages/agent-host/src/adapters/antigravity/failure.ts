import type { ToolSetupFailureReason } from '@cc/protocol'

/** Why Centralu's install or sign-in of Antigravity stopped, as a word a screen can act on (`ToolSetup.failure`) */
export class InstallFailure extends Error {
  constructor(
    readonly reason: ToolSetupFailureReason,
    message: string,
  ) {
    super(message)
  }
}
