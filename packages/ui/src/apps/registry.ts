import type { AppModule } from './contract.js'
import { controlApp } from './control/index.js'

/**
 * The app registry (#81) — the only line through which core knows about apps (symmetric with
 * the registry on the host side). Removing an app here means it does not exist on screen at
 * all. Toggling one off only stops it from being rendered — it does not delete anything.
 */
export const APPS: readonly AppModule[] = [controlApp]
