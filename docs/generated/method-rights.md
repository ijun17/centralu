# What the limited credential may call

Generated from `packages/agent-host/src/transport/method-rights.ts` by `pnpm docs:rights`; do not edit by hand.
The rule behind each class is in [security-boundaries.md](../security-boundaries.md), "Who holds full power" (#1405).
The token (a window, or a hub linked to this host) calls every method.

## everyday

With the limited credential: runs.

- `agents.account`
- `agents.applyVersions`
- `agents.autoCompact`
- `agents.cancelInstallTool`
- `agents.cancelSignIn`
- `agents.capabilities`
- `agents.clearBackgroundTasks`
- `agents.commands`
- `agents.detect`
- `agents.exportHandoffNote`
- `agents.exportHandoffRecord`
- `agents.forkConversation`
- `agents.interrupt`
- `agents.listExternalSessions`
- `agents.mcpProposals`
- `agents.models`
- `agents.orchestratorSkills`
- `agents.reportOwed`
- `agents.restartSession`
- `agents.resumeSession`
- `agents.send`
- `agents.setAutoApplyVersions`
- `agents.setSleepPolicy`
- `agents.skillProposals`
- `agents.sleepPolicy`
- `agents.stopBackgroundTask`
- `agents.switchTool`
- `agents.usage`
- `agents.versions`
- `agents.worktreeStatus`
- `approvals.deleteRule`
- `approvals.rules`
- `apps.askBuilder`
- `apps.builder`
- `apps.check`
- `apps.create`
- `apps.createBuilder`
- `apps.errors`
- `apps.forgetPermission`
- `apps.inlineViews`
- `apps.list`
- `apps.permissions`
- `apps.questions`
- `apps.reach`
- `apps.restart`
- `apps.restoreVersion`
- `apps.review`
- `apps.runs`
- `apps.sendError`
- `apps.usage`
- `apps.versions`
- `attachments.save`
- `commands.log`
- `commands.resize`
- `commands.run`
- `commands.state`
- `commands.stop`
- `files.search`
- `fs.importFile`
- `fs.listDir`
- `fs.move`
- `fs.readFile`
- `fs.resolve`
- `fs.watch`
- `git.branches`
- `git.cancel`
- `git.checkout`
- `git.commit`
- `git.commitDetail`
- `git.diff`
- `git.ignoredEntries`
- `git.log`
- `git.push`
- `git.stage`
- `git.status`
- `grid.get`
- `host.activity`
- `host.stop`
- `machines.activity`
- `machines.askConsents`
- `machines.cancelUpdate`
- `machines.disconnect`
- `machines.list`
- `machines.need`
- `machines.probe`
- `machines.reconnect`
- `machines.setAutoReconnect`
- `machines.setConnect`
- `machines.sshHosts`
- `machines.withdrawAsk`
- `messages.image`
- `messages.load`
- `messages.search`
- `messages.subagent`
- `messages.subagentTrashed`
- `orchestrator.configure`
- `orchestrator.get`
- `orchestrator.peek`
- `prefs.get`
- `processes.stop`
- `processes.strays`
- `projectConsents.list`
- `projectConsents.revoke`
- `projects.createPreview`
- `projects.deleteOutlook`
- `projects.gitStatus`
- `projects.inspect`
- `projects.list`
- `projects.origin`
- `projects.reorder`
- `requests.list`
- `sessions.list`
- `sessions.markRead`
- `sessions.rename`
- `sessions.reorder`
- `subagents.trash`
- `subagents.usage`
- `terminal.close`
- `terminal.create`
- `terminal.input`
- `terminal.list`
- `terminal.resize`
- `terminal.restart`
- `themes.import`
- `themes.list`
- `themes.resolve`
- `themes.save`
- `trash.list`
- `trash.read`
- `trash.readRun`
- `trash.restore`
- `trash.restoreSubagentSteps`
- `updates.status`
- `usage.history`
- `workspace.load`
- `worktrees.createManager`
- `worktrees.setTrunk`

## asks

With the limited credential: waits for the person's card in the window and runs once allowed; refused at once when no window that shows the card is attached.

- `agents.archiveIfAtRest`
- `agents.deleteAgentChild`
- `agents.deleteOrchestratorSkill`
- `agents.deleteSession`
- `agents.installTool`
- `agents.signIn`
- `apps.enable`
- `apps.importCommit`
- `apps.remove`
- `machines.acceptVersions`
- `machines.add`
- `machines.autostart`
- `machines.install`
- `machines.remove`
- `machines.rollback`
- `machines.uninstall`
- `projects.add`
- `projects.create`
- `projects.delete`
- `projects.setAgentInstructions`
- `projects.setCommands`
- `projects.setTrusted`
- `projects.setWorktreeSetup`
- `trash.empty`
- `trash.purge`
- `trash.purgeRuns`
- `trash.purgeSubagentSteps`

Asks only for some parameters (everyday otherwise):

- `agents.createSession`, when the preset is above `normal`, or it carries a hub's preset (`fromHub`)
- `agents.updateSettings`, when it sets a preset other than `safe`
- `apps.setShared`, when it shares the app
- `machines.hubAuto`, when it turns the switch on
- `machines.setAsks`, when it turns the switch on
- `machines.update`, when `when` is `now`, or the hub's automatic updates are off, or the machine does not run an older release that the update brings to the hub's own version
- `prefs.set`, when it sets the agent ceiling or depth, turns hub auto on, or turns approval notifications or their sound off
- `updates.apply`, when the person's Automatic updates are off, or something is running (a turn, a card waiting, background work, a terminal or a command)
- `updates.setAuto`, when it turns automatic updates on
- `updates.setAutoApply`, when it turns automatic applying on

## window

With the limited credential: refused, never a card: the person's own answers and the window's own state.

- `agents.answerQuestion`
- `agents.archiveLosses`
- `agents.resolveMcpProposal`
- `agents.resolveSkillProposal`
- `agents.respondApproval`
- `apps.answerQuestion`
- `apps.closeView`
- `apps.holdViews`
- `apps.importCancel`
- `apps.importPrepare`
- `apps.inlineReopen`
- `apps.invoke`
- `apps.openView`
- `apps.readResource`
- `apps.recoverView`
- `apps.setSecret`
- `apps.viewDocument`
- `apps.viewFrame`
- `apps.viewMessage`
- `grid.set`
- `mail.close`
- `mail.held`
- `mail.list`
- `mail.reassign`
- `mail.reply`
- `mail.resume`
- `mail.thread`
- `mail.unblock`
- `mail.wake`
- `requests.answer`
- `sessions.clearError`
- `updates.answerApply`
- `updates.reportApply`
- `workspace.save`

## link

With the limited credential: refused: a hub linked to this host calls it, with the token.

- `host.handover`
- `host.hubAuto`
- `host.hubOffer`
- `host.lastAnswer`
- `host.readSession`
- `host.recall`
- `host.send`
- `host.sessions`
- `host.setHubAuto`

## bridge

With the limited credential: refused: a session's own tool channel, which a Codex bridge reaches with its own credential.

- `apps.sessionCall`
- `apps.sessionTools`
- `orchestrator.tool`
- `orchestrator.tools`
