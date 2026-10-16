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
import type { OrchestratorSlice } from './state/orchestrator.js'

/**
 * The store's state and actions as one type (`AppState`), and the shapes of what it holds. The store
 * (`useStore`, store.ts) builds it; the modules split out of store.ts (#428) import these types from
 * here rather than from the store, so none of them depends on the store itself. Those that hold
 * actions take the store's `set` and `get` (`StoreSet`, `StoreGet`).
 */

/** The store's own `set` and `get`, as the modules holding its actions receive them */
export type StoreSet = StoreApi<AppState>['setState']
export type StoreGet = StoreApi<AppState>['getState']

export type { Overlay } from './state/layers.js'
export type { Notice } from './state/notifications.js'
export type { Draft, SubagentSteps } from './state/conversation.js'
export { EMPTY_DRAFT } from './state/conversation.js'
export type { PinnedView, InlineView } from './state/appViews.js'

/**
 * The store's state and actions as one type: the intersection of one type per concept
 * (`store/state/`), so every field and action sits with the others it works with.
 */
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
  OrchestratorSlice
