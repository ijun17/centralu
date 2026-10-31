import { z } from 'zod'
import { HostRequest, UpdateStatus } from '../../entities.js'
import {
  HostActivity,
  HostLastAnswerResult,
  HostReadSessionResult,
  HostRecallHit,
  HostSessionRow,
  MachineAskConsent,
  MachineAutostartResult,
  MachineInfo,
  MachineInstallResult,
  MachineProbe,
  MachineUninstallResult,
  SshHostList,
} from '../../machines.js'

/** The results of the `host` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./host.params.ts */
export const hostResults = {
  'updates.status': UpdateStatus,
  'updates.setAuto': UpdateStatus,
  'updates.setAutoApply': UpdateStatus,
  'updates.apply': UpdateStatus,
  'updates.answerApply': z.object({ ticket: z.string().nullable() }),
  'updates.reportApply': z.object({}),
  'ui.reportCrash': z.object({}),
  'requests.list': z.array(HostRequest),
  'requests.answer': z.object({ ok: z.boolean() }),
  'machines.list': z.array(MachineInfo),
  'machines.add': MachineInfo,
  'machines.sshHosts': SshHostList,
  'machines.probe': MachineProbe,
  'machines.remove': z.object({ ok: z.literal(true) }),
  'machines.reconnect': MachineInfo,
  'machines.disconnect': MachineInfo,
  'machines.revokeCredential': MachineInfo,
  'machines.setAutoReconnect': MachineInfo,
  'machines.setConnect': MachineInfo,
  'machines.need': MachineInfo,
  'machines.acceptVersions': MachineInfo,
  'machines.install': MachineInstallResult,
  'machines.update': MachineInstallResult,
  'machines.cancelUpdate': MachineInfo,
  'machines.rollback': MachineInstallResult,
  'machines.uninstall': MachineUninstallResult,
  'machines.autostart': MachineAutostartResult,
  'machines.activity': z.object({ activity: HostActivity.nullable() }),
  'machines.hubAuto': z.object({ state: z.enum(['on', 'off', 'older', 'unreachable']) }),
  'machines.setAsks': MachineInfo,
  'machines.askConsents': z.array(MachineAskConsent),
  'machines.withdrawAsk': z.object({ ok: z.literal(true) }),
  'host.activity': HostActivity,
  'host.sessions': z.array(HostSessionRow),
  'host.readSession': HostReadSessionResult,
  'host.recall': z.array(HostRecallHit),
  'host.hubAuto': z.object({ allowed: z.boolean() }),
  'host.setHubAuto': z.object({ allowed: z.boolean() }),
  'host.credentials': z.object({
    credentials: z
      // Unbounded: every one the folder holds, so the hub's count of those it does not list is exact (#1405 review)
      // `gone` (#1405 review): used there, and no longer listed. `check` (additive): an HMAC of the call's `nonce` under the
      // credential's verifier, for the hub to tell its own from another secret under the same id. Additive
      // `publicKey` (#1711, additive): a hub's key entry, listed with its public key, which a hub compares with its own
      .array(z.object({ id: z.string().max(16), label: z.string().max(80), created: z.number(), replaced: z.boolean().catch(false).default(false), gone: z.boolean().optional(), check: z.string().max(64).optional(), publicKey: z.string().max(64).optional().catch(undefined) }))
      .nullable(),
    /** The error code while serve.json is there but cannot be read (#1405 review; `credentials` is null then). Additive */
    unreadable: z.string().max(40).nullable().optional(),
    /**
     * Every credential used on that host under a hub's label (`hub:`), listed or gone, by first use (#1405 review): the
     * hub of that label tells the ones it paired itself from one something else paired under it. Additive
     */
    usedUnderHubLabels: z.array(z.object({ id: z.string().max(16), label: z.string().max(80), created: z.number(), check: z.string().max(64).optional(), publicKey: z.string().max(64).optional().catch(undefined) })).optional(),
    /**
     * The id of every credential this host's record holds as used, whether the list shows it or not (#1712): a hub that was
     * told of a use clears it once the host it is read from has it in its record, and keeps it when a host that started
     * again has no record of it. Absent from a host before it: the hub clears what it was told as before. Additive
     */
    usedIds: z.array(z.string().max(16)).optional(),
  }),
  'host.lastAnswer': HostLastAnswerResult,
  'host.send': z.object({ ok: z.literal(true) }),
  'host.stop': z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), busy: HostActivity, calls: z.number().int() }),
  ]),
  'host.handover': z.object({ ok: z.literal(true) }),
  'host.hubOffer': z.object({ ok: z.literal(true) }),
} as const
