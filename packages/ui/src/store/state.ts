import type { StoreApi } from 'zustand'
import type { ConnectionSlice } from './state/connection.js'
import type { ProjectsSlice } from './state/projects.js'
import type { SessionsSlice } from './state/sessions.js'
import type { ConversationSlice } from './state/conversation.js'
import type { LayoutSlice } from './state/layout.js'
import type { GridSlice } from './state/grid.js'
import type { LayersSlice } from './state/layers.js'
import type { NotificationsSlice } from './state/notifications.js'
import type { MachinesSlice } from './state/machines.js'
import type { PreferencesSlice } from './state/preferences.js'
import type { AppsSlice } from './state/apps.js'
import type { AppViewsSlice } from './state/appViews.js'
import type { NavigationSlice } from './state/navigation.js'
import type { AssistantSlice } from './state/assistant.js'
import type { MailSlice } from './state/mail.js'

// The store's types live here, not in store.ts, so the modules holding its parts never import the store (#428).

export type StoreSet = StoreApi<AppState>['setState']
export type StoreGet = StoreApi<AppState>['getState']

export type { Overlay } from './state/layers.js'
export type { Notice } from './state/notifications.js'
export type { Draft, SubagentSteps } from './state/conversation.js'
export { EMPTY_DRAFT } from './state/conversation.js'
export type { PinnedView, InlineView } from './state/appViews.js'

export type AppState = ConnectionSlice &
  ProjectsSlice &
  SessionsSlice &
  ConversationSlice &
  LayoutSlice &
  GridSlice &
  LayersSlice &
  NotificationsSlice &
  MachinesSlice &
  PreferencesSlice &
  AppsSlice &
  AppViewsSlice &
  NavigationSlice &
  AssistantSlice &
  MailSlice
