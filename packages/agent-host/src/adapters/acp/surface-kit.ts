import { z } from 'zod'
import { asObj } from '../../json-value.js'
import { startToolProcess } from '../core/tool-process.js'
import { AcpConnection } from './connection.js'

const Initialized = z.looseObject({ agentCapabilities: z.unknown().optional(), authMethods: z.array(z.looseObject({ id: z.string() })).optional() })

/** What an ACP tool's surface read (#270) shares: asking `initialize` with no session and no login, and naming what it answers */
export async function acpInitialize(spec: Parameters<typeof startToolProcess>[0], label: string, stderrLine?: (line: string) => string | null): Promise<string> {
  const conn = new AcpConnection(startToolProcess(spec), { onNotification: () => {}, onRequest: async () => null, onExit: () => {} }, label, stderrLine)
  try {
    const init = await conn.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'centralu-surface', version: '1' } }, 60_000)
    return JSON.stringify(init)
  } finally {
    await conn.dispose()
  }
}

/** Keys of a capability object, flattened (`sessionCapabilities.list`), so a new one shows as a new name */
function capabilityNames(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : []
  const entries = Object.entries(asObj(value))
  if (entries.length === 0) return prefix ? [prefix] : []
  return entries.flatMap(([k, v]) => (typeof v === 'object' && v !== null ? capabilityNames(v, prefix ? `${prefix}.${k}` : k) : [prefix ? `${prefix}.${k}` : k]))
}

/** The capabilities and sign-in methods (`authMethods.<id>`) an `initialize` answer offers, sorted */
export function acpCapabilities(initialize: string | undefined): string[] {
  const init = Initialized.parse(JSON.parse(initialize ?? '{}'))
  return [...capabilityNames(init.agentCapabilities), ...(init.authMethods ?? []).map((a) => `authMethods.${a.id}`)].sort()
}
