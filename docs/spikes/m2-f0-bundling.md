# F-0 bundling spike results (2026-08-15)

> **Passed.** The release `.app` works from a clean path with a bundled sidecar.
> M2's single largest unknown was removed on day one — from here, even if A~E fail, the dogfooding path is alive.

## Decision (F-0a): run the system Node

| Candidate | Verdict |
|---|---|
| ① Node SEA | **rejected** — better-sqlite3 is a native addon, so the `.node` cannot go into the blob, and after injection macOS re-signing is needed as well. Too costly for what dogfooding needs |
| ② **system Node** | **adopted** — ship the bundled JS + the prebuilt `.node` + schema.sql and that is it. Dogfooding is limited to my machine, so assuming Node exists is fine |
| ③ Bun compile | on hold — N-API loading needs separate handling and there is no gain over ② |

The swap points were isolated to two places: `packages/agent-host/scripts/bundle.mjs` (producing the output) and
`host_command()` in `sidecar.rs` (how it is run). If the deployment target widens, only these two change.

## Output

```
apps/desktop/src-tauri/resources/host/
  main.mjs                       2.0MB  esbuild bundle (better-sqlite3 the only external)
  schema.sql                            the store looks next to the output first
  node_modules/better-sqlite3/          package.json + lib + the darwin-arm64 prebuild only
  bundle-info.json                      records the runtime and platform
```
10MB for the whole app. Built with `pnpm bundle:host`, run automatically by `tauri build`'s beforeBuildCommand.

## Measured results

- Bundled host run standalone (clean path `/tmp`): ready line printed, SQLite and schema fine
- `.app` + `.dmg` build succeeded
- `.app` copied to `/tmp/cc-clean/` and run → **spawns the bundled sidecar**
  (`/opt/homebrew/bin/node .../Resources/resources/host/main.mjs --port 0 --watch-parent`)
- UI connected, existing projects and sessions restored from SQLite
- **0 zombies after SIGKILL** — M1.5's stdin EOF self-termination works in the bundle too

## 4 traps solved

1. **The schema.sql path** — it was being read as a path relative to the source tree, which broke in the bundle.
   → Changed to pick whichever exists from a candidate list (next to the output → the source tree).
2. **The native addon** — esbuild cannot bundle it. → Marked external + only the prebuild shipped
   (avoiding a 26MB full copy). Placed in both `prebuilds/` and `build/Release/` to defend against loader implementation differences.
3. **CJS require in an ESM bundle** — better-sqlite3 is CJS, so a `createRequire` banner is injected.
4. **PATH in a GUI app** — an `.app` does not inherit the login shell's PATH and cannot find `node`.
   → Search common locations such as `/opt/homebrew/bin/node` directly.

## What is left (closed out in F)

- No code signing or notarisation — **explicitly outside the scope of dogfooding (my machine)**. Needed to distribute.
- No guidance for an environment without Node — right now a spawn failure only shows as "could not start agent-host".
  F-1 makes this concrete as "Node is required".
- `bundle-info.json` is only a record and is not read at runtime (prod is determined by the existence of main.mjs).
