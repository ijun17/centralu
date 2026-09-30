import type { HostAppModule } from './contract.js'
import { controlHostApp } from './control.js'

/**
 * The app registry (#81) — **the one line the core knows about apps.**
 *
 * A compile-time array. There is deliberately no story for dynamic loading, versioning, or third
 * parties — an app is a module inside the repository, and the contract holds only what its two
 * consumers (control, the next app) have proven they need. Leave an app out here and it does not
 * exist: no tools, no state, no UI.
 */
export const HOST_APPS: readonly HostAppModule[] = [controlHostApp]
