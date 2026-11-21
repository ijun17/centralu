import type { ProjectInfo } from '@cc/protocol/client'
import { RowMenu } from './RowMenu.jsx'
import { ActionRow } from './ActionRow.jsx'
import { ReconnectRow } from './ReconnectRow.jsx'

/**
 * The action menu on a project row: a labeled list, not icons, since some actions must not be pressed to find out what
 * they do. Delete sits below a divider, apart from the everyday actions.
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
      {/* Bringing a disconnected machine back comes first (#1533) */}
      {project.machine && <ReconnectRow machine={project.machine} projectName={project.name} anchorEl={anchorEl} onClose={onClose} />}
      {/*
        The sidebar's one way to start a session, at once: the empty screen switches the tool and offers past conversations
      */}
      <ActionRow label="New session" onClick={pick(onNewSession)} testId={`new-session-${project.name}`} />
      {/* A project with the app manifest at its root is an app (#1141) */}
      {onOpenApp && <ActionRow label="Open as app" onClick={pick(onOpenApp)} testId={`open-app-${project.name}`} />}
      {/*
        M4 C-1. Shown for an untrusted project too: the dialog says why and offers trust, where a missing row would not
      */}
      {onNewApp && <ActionRow label="New app…" onClick={pick(onNewApp)} testId={`new-app-${project.name}`} />}
      {/*
        On the project's own machine (#82). Not in the file tree's tab strip: it would push tabs into "more"
      */}
      {onOpenInVsCode && (
        <ActionRow
          label="Open in VS Code"
          onClick={pick(onOpenInVsCode)}
          testId={`open-vscode-${project.name}`}
        />
      )}
      {/*
        Trust (M4, decision 3): a toggle row, no confirmation. Off is the safe direction; on was read and pressed
      */}
      <ActionRow
        label={project.trusted ? 'Stop trusting this project' : trustListsApps ? 'Trust this project…' : 'Trust this project'}
        onClick={pick(onToggleTrust)}
        testId={`toggle-trust-${project.name}`}
      />
      {/*
        Beside trust, the other project-wide setting (#1161 item 2)
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
