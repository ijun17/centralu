import type { AppModule } from '../contract.js'
import { ControlRail } from './ControlRail.jsx'
import { ControlSettings } from './ControlSettings.jsx'

/** The control app (#80/#81) — app #1. The rail is all of it; tasks and the foreman come into
 * this app in the next stage */
export const controlApp: AppModule = {
  id: 'control',
  title: 'Control rail',
  railPanel: ControlRail,
  settingsPanel: ControlSettings,
}
