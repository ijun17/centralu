import { z } from 'zod'
import { AppReach } from '../../app-drag.js'
import {
  AppErrorBundle,
  AppId,
  AppPermission,
  AppQuestion,
  AppReview,
  AppRun,
  AppUsage,
  AppVersions,
  ExternalAppInfo,
  ProjectConsent,
  SessionId,
} from '../../entities.js'
import { SessionInfo } from '../sessions.js'

const AppHomeViewResult = z.object({
  instanceId: z.string(),
  tool: z.string(),
  resourceUri: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  toolResult: z.looseObject({ content: z.array(z.record(z.string(), z.unknown())) }),
  runId: z.string(),
})

/** The results of the `apps` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./apps.params.ts */
export const appsResults = {
  'apps.viewFrame': z.object({
    url: z.string(),
    allow: z.string(),
    sandbox: z.object({
      csp: z.object({
        connectDomains: z.array(z.string()),
        resourceDomains: z.array(z.string()),
        frameDomains: z.array(z.string()),
        baseUriDomains: z.array(z.string()),
      }),
      permissions: z.record(z.string(), z.object({})),
    }),
  }),
  'apps.viewDocument': z.object({
    appId: AppId,
    projectId: z.string().nullable(),
    uri: z.string(),
    origin: z.enum(['opaque', 'app']),
    resource: z.looseObject({ contents: z.array(z.unknown()) }),
  }),
  'apps.openView': AppHomeViewResult,
  'apps.closeView': z.object({ ok: z.literal(true) }),
  'apps.recoverView': AppHomeViewResult,
  'apps.holdViews': z.object({ missing: z.array(z.string()) }),
  'apps.inlineReopen': z.object({
    instanceId: z.string(),
    appId: AppId,
    projectId: z.string().nullable(),
    tool: z.string(),
    toolInput: z.record(z.string(), z.unknown()),
    toolResult: z.looseObject({ content: z.array(z.unknown()) }).optional(),
    cancelled: z.string().optional(),
  }),
  'apps.inlineViews': z.array(
    z.object({
      callId: z.string(),
      appId: AppId,
      projectId: z.string().nullable(),
      tool: z.string(),
      kept: z.boolean(),
      instanceId: z.string().nullable(),
    }),
  ),
  'apps.viewMessage': z.object({ ok: z.literal(true) }),
  'apps.readResource': z.looseObject({ contents: z.array(z.looseObject({ uri: z.string() })) }),
  'apps.invoke': z.object({
    text: z.string(),
    isError: z.boolean().optional(),
    status: z.enum(['ok', 'error', 'cancelled', 'rejected']).optional(),
    runId: z.string().optional(),
    result: z.unknown().optional(),
  }),
  'apps.list': z.array(ExternalAppInfo),
  'apps.runs': z.array(AppRun),
  'apps.restart': z.object({ ok: z.literal(true) }),
  'apps.remove': z.object({ ok: z.literal(true) }),
  /**
   * Creating an app also stands up its building session (C-2). If that session fails to stand
   * up, the app still remains — `builder` is null and `builderError` states why. In that case
   * it can be stood up again with `apps.createBuilder`.
   */
  'apps.create': z.object({
    app: ExternalAppInfo,
    builder: SessionInfo.nullable(),
    builderError: z.string().optional(),
  }),
  'apps.builder': SessionInfo.nullable(),
  'apps.errors': z.object({ latest: AppErrorBundle.nullable(), recent: z.array(AppErrorBundle) }),
  'apps.reach': AppReach,
  'apps.questions': z.array(AppQuestion),
  'apps.answerQuestion': z.object({ ok: z.literal(true) }),
  'projectConsents.list': z.array(ProjectConsent),
  'projectConsents.revoke': z.object({ ok: z.literal(true) }),
  'apps.permissions': z.array(AppPermission),
  'apps.forgetPermission': z.object({ ok: z.literal(true) }),
  'apps.usage': AppUsage,
  'apps.createBuilder': SessionInfo,
  'apps.sendError': z.object({ sessionId: SessionId }),
  'apps.askBuilder': z.object({ sessionId: SessionId }),
  'apps.check': z.object({
    ok: z.boolean(),
    text: z.string(),
    findings: z.array(
      z.object({ level: z.enum(['problem', 'warning']), where: z.string(), message: z.string() }),
    ),
  }),
  'apps.setShared': z.object({ ok: z.literal(true) }),
  'apps.setSecret': z.object({ ok: z.literal(true) }),
  'apps.importPrepare': z.object({ token: z.string(), review: AppReview }),
  'apps.importCommit': ExternalAppInfo,
  'apps.importCancel': z.object({ ok: z.literal(true) }),
  'apps.review': AppReview,
  'apps.enable': ExternalAppInfo,
  'apps.versions': AppVersions,
  'apps.restoreVersion': ExternalAppInfo,
  'apps.sessionTools': z.object({ tools: z.array(z.record(z.string(), z.unknown())) }),
  'apps.sessionCall': z.object({
    content: z.array(z.unknown()),
    isError: z.boolean().optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
  }),
} as const
