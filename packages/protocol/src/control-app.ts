import type { ToolName } from './entities.js'

/*
 * The document shape for the control app (#80, #81) — **defined exactly once** (M4 P-5).
 *
 * The app's state is a single JSON document, and the protocol only ever carries it as `unknown`
 * (`apps.*`). That principle still holds here: the types in this file are not used by any
 * schema on the wire, and no other file in this package knows about them. The reason they live
 * here is single — this app has two halves (the host's tools and observation, the UI's rail and
 * settings) that **read and write the same document**, and this package is the only place both
 * halves can import (agent-host only knows protocol, ui only knows core, ports and protocol).
 *
 * What happened because there was never one shared copy: the host declared `notifies` as
 * required, while the UI declared it optional. The shape that actually got saved was the UI's —
 * before the document existed yet, the UI wrote `{ ...(doc ?? {}), metrics }`, with no notifies
 * field at all. The host then fell over on `doc.notifies.push` against that document — after a
 * fresh install, one inline reply from the rail was enough that every control_notify call after
 * it failed with a TypeError, and watches went silently quiet (reproduced in
 * apps/control.test.ts). Keeping the shape in one place is not about saving on types; it is
 * about making sure both halves read the saved truth the same way.
 *
 * Why a type rather than a zod schema: there is no place this document gets validated (the wire
 * only carries it as `unknown`). Adding a schema would read as though a check happens that
 * nobody actually runs.
 */

export type ControlNotify = {
  id: string
  text: string
  sessionId?: string
  priority?: 'high' | 'normal'
  ts: number
}

/**
 * A declarative watch (#80 checkpoint v1 — notification only, no pausing).
 *
 * A session running in bypass mode cannot be paused mid-way — an approval request is something
 * the tool's own permission mode produces, and bypass mode never produces one. So v1's contract
 * is "watch, and call out the moment something matches."
 */
export type ControlWatch = { id: string; pattern: string; sessionId?: string }

/** A task — several sessions plus one foreman (coordinating session) plus one board. Not deleted on completion (can be reconvened). */
export type ControlTask = {
  id: string
  title: string
  goal: string
  members: string[]
  coordinatorId: string
  status: 'active' | 'done'
  createdAt: number
}

/**
 * Settings for spawning the foreman — cheap models are not allowed, since filtering out noise
 * takes judgment (the person's decision: opus / terra high tier).
 * Tool is an open-ended name (#74): which tools exist is decided by the host's adapters.
 */
export type ForemanSettings = { tool: ToolName; model?: string; effort?: string }

/**
 * The control app's document, in full. **Every field is optional** — depending on which half
 * wrote first, any field can be missing, and the reader treats a missing field as its default.
 */
export type ControlDoc = {
  notifies?: ControlNotify[]
  /** Judgment counters (#80) — inlineReplies, railOpens */
  metrics?: Record<string, number>
  watches?: ControlWatch[]
  tasks?: ControlTask[]
  foreman?: ForemanSettings
}
