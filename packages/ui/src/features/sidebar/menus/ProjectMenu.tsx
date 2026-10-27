import type { ProjectInfo } from '@cc/protocol/client'
import { RowMenu } from './RowMenu.jsx'
import { ActionRow } from './ActionRow.jsx'
import { ReconnectRow } from './ReconnectRow.jsx'

/**
 * The action menu on a project row.
 *
 * The reason it is one labeled list instead of three icons is **that names are needed.** `+` could
 * be learned to mean new session, but there is no way to know before pressing that a branch icon
 * means the worktree manager and a trash icon means deleting the project — and one of those is the
 * kind of thing that must not be pressed just to find out.
 *
 * Delete sits **at the very bottom, below a divider.** The two above it are things done every day,
 * while this is something done once, and they must not sit in the same group when the hand is
 * moving from memory.
 */

export function ProjectMenu({
  project,
  anchorEl,
  onClose,
  onNewSession,
  onOpenApp,
  onNewApp,
  onToggleTrust,
  trustListsApps,
  onOpenInVsCode,
  onAgentInstructions,
  onDelete,
}: {
  project: ProjectInfo
  anchorEl: HTMLElement | null
  onClose: () => void
  /** Starts a session: at once with what the project remembers (#543), or in the window a worktree proposal waits in */
  onNewSession: () => void
  /** The project is an app (#1141): open its screen */
  onOpenApp?: () => void
  onNewApp?: () => void
  onToggleTrust: () => void
  /** Trusting opens the card listing the project's apps (#1141), so the row ends in an ellipsis */
  trustListsApps?: boolean
  /** A project on a linked machine VS Code can reach over Remote-SSH (#82): its folder there */
  onOpenInVsCode?: () => void
  /** The instructions every agent started in the project reads after its task (#1161 item 2) */
  onAgentInstructions: () => void
  onDelete: () => void
}) {
  const pick = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <RowMenu anchorEl={anchorEl} testId={`project-menu-open-${project.name}`} onClose={onClose}>
      {/* A project on a machine that is not connected: bringing it back comes first (#1533); nothing here for one that is connected or on this computer */}
      {project.machine && <ReconnectRow machine={project.machine} projectName={project.name} anchorEl={anchorEl} onClose={onClose} />}
      {/*
        The only way to start a session from the sidebar since its `+` went (owner, 2026-10-18). It starts one at once:
        the empty screen switches the tool and offers past conversations, so no window of options is needed here.
      */}
      <ActionRow label="New session" onClick={pick(onNewSession)} testId={`new-session-${project.name}`} />
      {/* A project whose folder has the app manifest at its root is an app (#1141): its screen, by name */}
      {onOpenApp && <ActionRow label="Open as app" onClick={pick(onOpenApp)} testId={`open-app-${project.name}`} />}
      {/*
        New app (M4 C-1) — right below new session. Both are "add one more thing to this project,"
        so they belong in the same group. It shows up even for an untrusted project too: the dialog
        states why and lets the person trust it right there (if the row disappeared from the menu
        instead, there would be nowhere to ask why it is missing).
      */}
      {onNewApp && <ActionRow label="New app…" onClick={pick(onNewApp)} testId={`new-app-${project.name}`} />}
      {/*
        The whole project in VS Code, on its own machine (#82). It lives here and not in the file tree's tab strip:
        there it took the width the strip counts tabs by, and pushed the terminal tab into "more" in a narrow panel.
      */}
      {onOpenInVsCode && (
        <ActionRow
          label="Open in VS Code"
          onClick={pick(onOpenInVsCode)}
          testId={`open-vscode-${project.name}`}
        />
      )}
      {/*
        Trust (M4, decision 3). Asked once at registration, and changed from here afterward. A
        single toggle row, not a confirmation dialog: turning it off is the safe direction, which
        stops apps and ignores settings, and turning it on is something the person did by opening
        the menu, reading the label and pressing it.
      */}
      <ActionRow
        label={project.trusted ? 'Stop trusting this project' : trustListsApps ? 'Trust this project…' : 'Trust this project'}
        onClick={pick(onToggleTrust)}
        testId={`toggle-trust-${project.name}`}
      />
      {/*
        The project's own setting for the agents its sessions start (#1161 item 2). Beside trust, which is the other
        setting of the project as a whole; a dialog, since it is a text to read and edit, not a toggle.
      */}
      <ActionRow
        label="Instructions for agents…"
        onClick={pick(onAgentInstructions)}
        testId={`agent-instructions-${project.name}`}
      />
      <div className="my-1 border-t border-line" />
      <ActionRow
        label="Delete project…"
        onClick={pick(onDelete)}
        testId={`delete-project-${project.name}`}
        danger
      />
    </RowMenu>
  )
}
