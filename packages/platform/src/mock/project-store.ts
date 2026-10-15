import type { ProjectInfo } from '@cc/protocol'

/** The registered projects, as the mock holds them — the session list, the trash, machines and the project port all read it */
export class ProjectStore {
  list: ProjectInfo[] = []

  constructor(private readonly changedFiles: () => number) {}

  /**
   * When returning a project, **recounts the change count from gitState** (issue #41).
   *
   * On the real host, the sidebar's number and the git panel's listing are two readings of
   * the same single `git status`. If the mock held the number separately, a test that changes
   * the file list would leave the number stale — an inconsistency the real thing could never
   * produce, and the contract this file's header lays out.
   */
  withGit(p: ProjectInfo): ProjectInfo {
    return p.git ? { ...p, git: { ...p.git, changedFiles: this.changedFiles() } } : { ...p }
  }
}
