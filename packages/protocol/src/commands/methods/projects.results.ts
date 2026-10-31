import { z } from 'zod'
import { Attachment, GitBranch, GitCommit, GitDiff, GitFileStatus } from '../../entities.js'
import { FsEntry, FsFile } from '../files.js'
import { ProjectInfo, SavedCommand } from '../projects.js'

/** The results of the `projects` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./projects.params.ts */
export const projectsResults = {
  'git.status': z.array(GitFileStatus),
  'git.diff': GitDiff,
  'git.log': z.array(GitCommit),
  'git.commitDetail': z.object({ files: z.array(z.string()), diff: z.string(), truncated: z.boolean() }),
  'git.branches': z.array(GitBranch),
  'git.ignoredEntries': z.array(z.object({ path: z.string(), bytes: z.number().nullable() })),
  'git.checkout': z.object({
    ok: z.boolean(),
    conflicts: z.array(z.string()),
    message: z.string().optional(),
    cancelled: z.literal(true).optional(),
  }),
  'git.stage': z.object({ ok: z.literal(true) }),
  'git.commit': z.object({
    ok: z.boolean(),
    message: z.string().optional(),
    cancelled: z.literal(true).optional(),
  }),
  'git.push': z.object({
    ok: z.boolean(),
    message: z.string().optional(),
    cancelled: z.literal(true).optional(),
  }),
  'git.cancel': z.object({ cancelled: z.boolean() }),
  'attachments.save': Attachment,
  'fs.listDir': z.array(FsEntry),
  'fs.watch': z.object({ watched: z.number() }),
  'fs.readFile': FsFile,
  'fs.move': z.object({ path: z.string(), moved: z.boolean() }),
  'fs.importFile': z.object({ path: z.string() }),
  'fs.resolve': z.object({ path: z.string() }),
  'projects.add': ProjectInfo,
  'projects.inspect': z.object({
    path: z.string(),
    exists: z.boolean(),
    folder: z.boolean(),
    git: z.boolean(),
    origin: z.string().nullable(),
    project: z.object({ id: z.string(), name: z.string() }).nullable(),
  }),
  'projects.create': ProjectInfo,
  'projects.createPreview': z.object({
    parent: z.string(),
    path: z.string().nullable(),
    error: z.string().nullable(),
  }),
  'projects.delete': z.object({ ok: z.literal(true) }),
  'projects.deleteOutlook': z.object({ folder: z.enum(['stays', 'may_move', 'around_may_move', 'unsure']) }),
  'projects.setTrusted': z.object({ ok: z.literal(true) }),
  'projects.reorder': z.array(ProjectInfo),
  'projects.setCommands': z.array(SavedCommand),
  'worktrees.setTrunk': z.object({ ok: z.literal(true) }),
  'projects.setWorktreeSetup': z.object({ ok: z.literal(true) }),
  'projects.setAgentInstructions': z.object({ ok: z.literal(true) }),
  'projects.list': z.array(ProjectInfo),
  'projects.gitStatus': ProjectInfo,
  'projects.origin': z.object({ origin: z.string().nullable() }),
  'files.search': z.array(z.object({ path: z.string(), name: z.string() })),
} as const
