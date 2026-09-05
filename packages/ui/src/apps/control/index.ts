import type { AppModule } from '../contract.js'
import { ControlRail } from './ControlRail.jsx'
import { ControlSettings } from './ControlSettings.jsx'

/** 관제 앱 (#80·#81) — 1호 앱. 레일이 전부고, 업무·반장은 다음 단계에 이 앱으로 들어온다 */
export const controlApp: AppModule = {
  id: 'control',
  title: 'Control rail',
  railPanel: ControlRail,
  settingsPanel: ControlSettings,
}
