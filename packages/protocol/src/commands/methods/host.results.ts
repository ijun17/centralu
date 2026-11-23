import { z } from 'zod'
import { HostRequest, UpdateStatus } from '../../entities.js'
import { LinkedAppCallResult, LinkedAppsResult } from '../../linked-apps.js'
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

/** Results of the `host` methods, read through `parseRpcResult`. Params and what each method does: ./host.params.ts */
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
      // Unbounded, so the hub's count of those it does not list is exact. `gone`, `check`, `publicKey`: docs/protocol.md §3 "host"
      .array(z.object({ id: z.string().max(16), label: z.string().max(80), created: z.number(), replaced: z.boolean().catch(false).default(false), gone: z.boolean().optional(), check: z.string().max(64).optional(), publicKey: z.string().max(64).optional().catch(undefined) }))
      .nullable(),
    /** The error code while serve.json is there but cannot be read (`credentials` is null then) */
    unreadable: z.string().max(40).nullable().optional(),
    /** By first use: the hub of that `hub:` label tells the ones it paired itself from one paired under it by something else */
    usedUnderHubLabels: z.array(z.object({ id: z.string().max(16), label: z.string().max(80), created: z.number(), check: z.string().max(64).optional(), publicKey: z.string().max(64).optional().catch(undefined) })).optional(),
    /**
     * Every id this host's record holds as used, listed or not: a hub clears a use it was told of only once the record has
     * it, and keeps it when a restarted host has none. Absent from an older host, and the hub clears what it was told.
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
  'host.systemEnding': z.object({ ok: z.literal(true) }),
  // `mail`: this host takes `host.mail`, so the hub's task for a child here says to mail
  // `apps`: this host answers `host.apps` and `host.appCall`
  // `tasks`: this host takes the hub's tasks as mail and reports them back (`host.mail` with `task`)
  // `lacks`: the offer's `open` tasks this host never received; an older host sends none
  // `host`: this host's id in mail addresses (`hubSelfId`), by which the hub reads its mail in the hub's terms
  'host.hubOffer': z.object({
    ok: z.literal(true),
    mail: z.boolean().optional(),
    apps: z.boolean().optional(),
    tasks: z.boolean().optional(),
    lacks: z.array(z.string().max(200)).max(500).optional(),
    host: z.string().max(200).optional(),
  }),
  // As `hub.mail` answers (machines-hub.ts `HubMailResult`, which the window's bundle leaves out)
  'host.mail': z.union([
    z.object({ ok: z.literal(true), messageId: z.string().min(1).max(200), to: z.string().max(500), address: z.string().max(300).optional(), quiet: z.literal(true).optional() }),
    z.object({ ok: z.literal(false), why: z.string().min(1).max(100), text: z.string().max(4000) }),
  ]),
  'host.mailRows': z.object({ ok: z.literal(true) }),
  // The tasks moved; one this host does not have from that hub, or settled already, is left out
  'host.mailMove': z.union([z.object({ ok: z.literal(true), moved: z.number().int().min(0) }), z.object({ ok: z.literal(false), why: z.string().min(1).max(100), text: z.string().max(4000) })]),
  'host.cards': z.object({ cards: z.array(z.object({ card: z.string().max(200), requestId: z.string().max(200), kind: z.enum(['question', 'approval']), answerable: z.boolean() })).max(50) }),
  'host.answerCard': z.object({ ok: z.literal(true) }),
  'host.stopTask': z.object({ stopped: z.boolean() }),
  'host.apps': LinkedAppsResult,
  'host.appCall': LinkedAppCallResult,
  'host.appCancel': z.object({ ok: z.literal(true) }),
  'host.appNotice': z.object({ ok: z.literal(true) }),
} as const
