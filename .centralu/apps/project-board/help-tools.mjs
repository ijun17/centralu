// help: which of this app's tools for which repository task (#957), read on demand. Not in the server's
// instructions: those sit in every session's cached prompt, and an app added or changed would rebuild
// it (#512). The text is fixed, the same for every call.
import { z } from './runtime/centralu-app-runtime.mjs'
import { answer } from './reply.mjs'

export const GUIDE = [
  'Project board: which tool for which repository task, instead of gh or git by hand.',
  '- Merge one PR once CI is green → merge_when_green, which answers at once (not gh pr merge); to merge once CI is green, queue_merge. Without maintain or admin, mark it ready for the maintainer → mark_ready (not gh pr ready).',
  '- Merge several PRs or a stack, unattended → queue_merge, then merge_queue to follow and unqueue to take one out (not a loop of gh pr merge / gh run rerun). Run the watch command queue_merge answers in the background to hear when an item needs you or lands.',
  '- Land an auto-tier change (docs, fixture data, UI assets: pnpm tier) → push its branch, made from main, and hand it over with integrate (no open_pr, no queue_merge, no stack): it judges the tier itself, refuses anything else, and opens and lands the pull request as the record.',
  '- A stacked PR after the PR under it merged → rebase_stack (not git rebase --onto and git push --force).',
  '- CI of a PR or commit → ci_status; a failed job → read_failed_job (not gh pr checks / gh run view).',
  '- Open a PR → open_pr; comment → comment; file an issue → file_issue; a commit message → commit_check (not gh pr create / gh pr comment / gh issue create).',
  '- A release → release_status, then release (not gh release or git tag).',
  "- The board → list_items, get_items, list_needs_decision, set_item_fields, add_item; the owner's saved answers → list_owner_answers, then comment and mark_answer_recorded.",
].join('\n')

export const tools = {
  help: {
    config: {
      title: 'Which board tool for which task',
      description: 'Which of this app\'s tools to use for a repository task instead of gh or git by hand: merging, a merge queue, stacks, CI, pull requests, comments, issues, releases, the board.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: async () => answer(GUIDE, {}),
  },
}
