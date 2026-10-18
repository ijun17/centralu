/**
 * What the installed tool says it can do, and what the adapter knowingly leaves out (#270).
 *
 * The weekly drift run used to look in one direction only: does the latest vendor surface still carry every name the
 * adapter touches (#46)? A command, message type or capability that **became possible** reached nobody. `/goal` worked
 * headless in the person's Claude Code for weeks while Centralu still answered it with a refusal written down on
 * 2026-09-07, and both drift checks stayed green, as they should for what they ask.
 *
 * This part of the contract asks the other question. Each adapter fills it in, so a new adapter gets the check by
 * filling it in too:
 *
 *   - `gather` + `read`: what the tool offers, read **without starting a turn** (versions, schemas, generated bindings,
 *     type declarations, the CLI's `--help`). `gather` does the reading; `read` is pure, so a test can feed it recorded
 *     inputs.
 *   - `limitations`: what the adapter blocks, drops or works around, each with the measurement it rests on. These used
 *     to be dated code comments that nothing re-checked when the tool moved.
 *   - `baseline`: everything the tool offered when someone last reviewed it, kept in `adapters/<tool>/surface-baseline.ts`
 *     and rewritten by `pnpm drift:surface --record`.
 *
 * The drift run (`scripts/surface-drift.mts`) compares the three (`compareSurface`) and files an issue for what is new.
 */

/** The three sorts of thing a tool can offer. Names are the tool's own; a prefix says where a capability was read. */
export type SurfaceKind = 'command' | 'message' | 'capability'

export const SURFACE_KINDS: readonly SurfaceKind[] = ['command', 'message', 'capability']

/** One reading of a tool's surface. A kind left out was not read from these sources, and is not compared. */
export type ToolSurface = {
  /** The versions read, as the tool and its packages print them ("2.1.296 (Claude Code) · SDK 0.3.302") */
  version: string
  offered: Partial<Record<SurfaceKind, readonly string[]>>
}

/** The surface someone last reviewed: every name the tool offered then, per kind */
export type SurfaceBaseline = ToolSurface & {
  /** The day it was recorded (YYYY-MM-DD) */
  recorded: string
}

/** What the adapter does about something the tool offers, or did not offer when it was measured */
export type SurfaceTreatment =
  /** Answered or refused here; never reaches the tool */
  | 'blocked'
  /** Received and not shown or stored (only `host.log` says so, `UnmappedTypes`) */
  | 'dropped'
  /** Reached another way than the tool's own (a different request, read off the stream) */
  | 'worked-around'

export type SurfaceLimitation = {
  kind: SurfaceKind
  /** The name as `read` reports it */
  name: string
  treatment: SurfaceTreatment
  /** When and on what it was measured: "2026-09-07, SDK 0.3.231 and 0.3.263" */
  measured: string
  /**
   * Whether the tool offered `name` when this was measured. False: the limitation rests on its absence, so the name
   * appearing says the limitation may be gone. True: the tool offers it and the adapter does not use it, so the name
   * disappearing says this entry is stale.
   */
  offeredWhenMeasured: boolean
  /**
   * The adapter reads the offer itself at run time and stops limiting when the tool offers the name (the Claude
   * adapter's `/goal`, gated on the CLI's command list). Its appearing is then no news, and is not reported.
   */
  followsOffer?: boolean
  /** What the adapter does instead, and where; one or two sentences */
  note: string
}

/** Text the reader works from, keyed by where it came from ("sdk.d.ts", "claude --help") */
export type SurfaceInputs = Readonly<Record<string, string>>

/** What `gather` may use. The drift run provides it, pointed at the latest published versions. */
export type SurfaceEnv = {
  /** The folder of an npm package at the version being watched */
  packageDir(name: string): Promise<string>
  /** Runs an installed CLI with arguments that start no session (`--version`, `--help`, schema generation); its stdout */
  run(command: string, args: readonly string[]): Promise<string>
  /** A new empty folder, removed when the run ends */
  tempDir(): string
}

export type AdapterSurface = {
  gather(env: SurfaceEnv): Promise<SurfaceInputs>
  /** Pure: the same inputs give the same surface. Throws when an input it needs is missing or no longer parses. */
  read(inputs: SurfaceInputs): ToolSurface
  readonly limitations: readonly SurfaceLimitation[]
  readonly baseline: SurfaceBaseline
}
