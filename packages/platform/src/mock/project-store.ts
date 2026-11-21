import type { ProjectInfo } from '@cc/protocol/client'

export class ProjectStore {
  list: ProjectInfo[] = []

  constructor(private readonly changedFiles: () => number) {}

  /** Recounts the change count from gitState: on the host both are one `git status` (#41) */
  withGit(p: ProjectInfo): ProjectInfo {
    return p.git ? { ...p, git: { ...p.git, changedFiles: this.changedFiles() } } : { ...p }
  }
}
