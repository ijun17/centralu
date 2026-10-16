import { z } from 'zod'
import { MachineId } from '../machines.js'

/**
 * Which linked machine a row comes from (#82, docs/plans/remote-hub.md). Absent or null: the hub's
 * own. Set by the hub on what it passes on from another machine, whose ids then read
 * `<machine>.<id>`; the UI groups by this field and never parses the prefix.
 */
export const machineField = { machine: z.string().nullable().optional() }

/**
 * The machine a per-machine question is for (#82): its agent CLIs, its usage, its folders. Absent:
 * the hub's own, which is what every call meant before linked machines existed.
 */
export const machineParam = { machine: MachineId.optional() }
