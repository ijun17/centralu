import { z } from 'zod'
import { MachineId } from '../machines.js'

/**
 * The linked machine a row comes from; absent or null is the hub's own. The hub sets it on what it passes on, whose
 * ids then read `<machine>.<id>`; the UI groups by this field and never parses the prefix.
 */
export const machineField = { machine: z.string().nullable().optional() }

/** The machine a per-machine question (agent CLIs, usage, folders) is for; absent is the hub's own */
export const machineParam = { machine: MachineId.optional() }
