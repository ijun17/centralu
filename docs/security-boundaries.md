# Security boundaries and residual limits

These controls reduce risks from untrusted repository and agent content. They do not
sandbox an already-executing process with the user's OS privileges.

## Inter-agent content

Worker reports retain their provenance in stored history and the UI. Reports from
unprofiled workers to privileged/profiled sessions become host-authored notifications;
ordinary orchestrator/manager/coordinator instructions retain their content and attachments.
Worker-originated records are excluded from privileged conversation memory. Read-session,
preview and recall text is framed as structured untrusted data, not human authorization.

JSON framing prevents ambiguous transcript-line assembly; it does **not** make text safe
for an LLM to obey or eliminate prompt injection. Tool scopes and typed approval checks
remain the deterministic authorization boundaries.

## Local transport

The host listens on loopback and requires a nonempty token. Browser/WebView connections
must additionally match the explicit origin allowlist. A client without an Origin header
still needs the token; Origin is a browser defense, not native-client identity. Literal
`Origin: null` is rejected. Development tokens should be generated per launch and shared
only with the intended local client. Mock/demo modes do not connect to the host.

## Project files and native handoff

Existing filesystem targets are checked against the canonical project root. Symlinks
resolving inside that root are supported; outside targets and dangling links are rejected.
Text/image reads require a regular-file descriptor, bound allocation/read size, and compare
opened-file identity. Native reveal/trash checks are additional absolute/no-symlink checks;
they are **not** independent proof of project containment. Opening in an IDE does not fall
back to a generic OS opener that could execute repository-authored content.

Limits:

- An in-root hardlink shares an inode with its other names. Canonical pathname checks do
  not establish where that inode originated, so they do not close hardlink-based access.
- Validation and OS pathname use are separate operations. Same-user replacement races
  remain, especially for move/import/list/watch and native handoff. Descriptor identity
  checks narrow the read window but are not an atomic descriptor-relative filesystem sandbox.
- Project containment does not confine provider tools or terminal commands intentionally
  executed with the user's permissions. Approval policy and OS isolation are separate layers.

Do not expand the scope of these claims without stronger implementation and platform-level
validation. In particular, do not describe these checks as complete filesystem isolation.
