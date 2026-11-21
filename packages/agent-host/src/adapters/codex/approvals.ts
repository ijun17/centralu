import { asObj, str } from '../../json-value.js'
import { type ApprovalDetail } from '@cc/protocol'
import { fileEditDetail, type FileChange } from '../file-changes.js'
import { changeKindOf } from './items.js'
import { paramsOf } from './params.js'

/**
 * **A file-change request carries no change** (#169): it names the item and nothing else. Measured against codex-cli
 * 0.153.4 (scripts/probe-codex-file-approval.mts): item/started carries the fileChange with its `changes`, then
 * item/fileChange/requestApproval {threadId, turnId, itemId, startedAtMs, reason, grantRoot} 1ms later. No version of the
 * request has `params.item.changes`, so the changes come from the item, which the adapter remembers by id (`itemChanges`).
 *
 * The older `applyPatchApproval` carries its own changes keyed by path (generated/ApplyPatchApprovalParams.ts: an update
 * has `unified_diff`, an add or a delete `content`). Not measured: app-server 0.153.4 sent the v2 request above.
 *
 * A command request carries its command and cwd at the top level (measured in the same run); `item` is
 * read first only because older versions were written against it.
 */
export function approvalDetailFrom(
  method: string,
  params: Record<string, unknown>,
  itemChanges?: readonly FileChange[],
): ApprovalDetail {
  if (method === 'item/commandExecution/requestApproval') {
    const item = asObj(params.item)
    /*
     * Everything else the request says is kept (#683; generated v2 `CommandExecutionRequestApprovalParams`):
     * a network approval carries its host in `networkApprovalContext` and may have no command at all, `kind:
     * 'writeStdin'` is input to a terminal already running, and `reason` is why the agent asks. Without them the
     * card reads `Run ` and nothing, which a list row could then allow.
     */
    const p = paramsOf({ params }, 'item/commandExecution/requestApproval')
    const net = asObj(p.networkApprovalContext)
    return {
      kind: 'command',
      command: str(item.command) || str(p.command),
      cwd: str(item.cwd) || str(p.cwd),
      ...(str(p.reason) ? { reason: str(p.reason) } : {}),
      ...(str(net.host) ? { network: { host: str(net.host), protocol: str(net.protocol) } } : {}),
      ...(str(p.kind) === 'writeStdin' ? { stdin: true } : {}),
    }
  }
  if (method === 'item/fileChange/requestApproval') return fileEditDetail(itemChanges ?? [])
  if (method === 'applyPatchApproval') {
    const changes = Object.entries(asObj(params.fileChanges)).map(([path, c]) => ({
      path,
      diff: str(asObj(c).unified_diff) || str(asObj(c).content),
      // generated FileChange: the same `type` (add, delete, update with move_path) as the v2 kind
      ...changeKindOf(asObj(c)),
    }))
    return fileEditDetail(changes)
  }
  return { kind: 'other', raw: JSON.stringify(params).slice(0, 2000) }
}

/** Converts an approval response into a Codex decision (only the ones we use, out of the six) */
export function toCodexDecision(decision: 'allow' | 'deny' | 'always'): string {
  if (decision === 'deny') return 'decline'
  if (decision === 'always') return 'acceptForSession' // Maps exactly to "always allow, this session" (confirmed in M0)
  return 'accept'
}
