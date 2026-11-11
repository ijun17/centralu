# Adapters: one per agent CLI

One adapter per agent CLI, under `packages/agent-host/src/adapters/<tool>/`.

| File | What it holds |
|---|---|
| [contract.md](contract.md) | The `AgentAdapter` interface and its implementation rules |
| [claude-query-options.md](claude-query-options.md) | Claude's query options and independent-session messaging |
| [adding-a-tool.md](adding-a-tool.md) | The procedure for adding a new tool |
| [vendor-drift-checks.md](vendor-drift-checks.md) | The checks to run before an SDK or CLI upgrade |
