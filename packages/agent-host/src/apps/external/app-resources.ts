import type { ListResourcesResult, ReadResourceResult } from '@modelcontextprotocol/client'
import { invalidReason, type AppEntry } from './app-entry.js'
import type { AppLifecycle } from './app-lifecycle.js'
import type { AppRef } from './ref.js'
import type { RuntimeTiming } from './runtime-types.js'
import { maskedError } from './secrets.js'
import { AppUnavailableError } from './unavailable.js'
import { resourceUriOf } from './visibility.js'

/**
 * An app's resources and its fixed screen (runtime.ts): reading one, listing them, and the home
 * tool's screen. Each starts the app the first time it is needed, under the lifecycle's rules
 */
export class AppResources {
  constructor(
    private readonly timing: RuntimeTiming,
    private readonly lifecycle: AppLifecycle,
    private readonly require: (ref: AppRef) => AppEntry,
  ) {}

  /**
   * Reads an app's resource — the path a screen uses to read its own `ui://` document and resources
   * (B-3, B-4's `onreadresource`). Not a tool call, so no run record is kept, but the rules for
   * starting the app (trust, only when first needed) are the same.
   */
  async readResource(ref: AppRef, uri: string): Promise<ReadResourceResult> {
    const e = this.require(ref)
    return this.lifecycle.use(e, async (proc) => {
      try {
        return await proc.client.readResource({ uri }, { timeout: this.timing.connectTimeoutMs })
      } catch (err) {
        // The app's own error goes on to a screen and over the linked-machine relay: masked like its log (#1142)
        throw maskedError(err, (t) => proc.log.mask(t))
      }
    })
  }

  /**
   * The list of resources an app offers (MCP `resources/list`, following pagination) — the basis an
   * in-conversation screen (B-1) uses to check that a `ui://` a tool declared **actually belongs to
   * this app** (from the plan, "blocking impersonation"). Starts the app under the same rule as
   * reading. Follows only up to a page cap — so an app that keeps handing out the next page cannot
   * hold the host hostage.
   */
  async listResources(ref: AppRef, maxPages = 20): Promise<ListResourcesResult['resources']> {
    const e = this.require(ref)
    return this.lifecycle.use(e, async (proc) => {
      const out: ListResourcesResult['resources'] = []
      let cursor: string | undefined
      for (let page = 0; page < maxPages; page++) {
        const r = await proc.client.listResources(cursor ? { cursor } : {}, { timeout: this.timing.connectTimeoutMs }).catch((err: unknown) => {
          throw maskedError(err, (t) => proc.log.mask(t))
        })
        out.push(...r.resources)
        cursor = r.nextCursor
        if (!cursor) break
      }
      return out
    })
  }

  /**
   * The tool that opens the fixed screen, and that screen itself (B-2) — the manifest's `home`, and
   * that tool's declared `_meta.ui.resourceUri`. Since this needs the tool list, if the app is down,
   * **this is where it starts**.
   *
   * A tool declaring no screen is never accepted. A fixed screen is one born from a tool call (from
   * the plan, "the two places a screen can appear"), and calling a tool with no screen would leave
   * only a result with nothing to open. Calling it anyway would leave the person watching the app's
   * state change with nothing appearing on screen. So this is refused **before** ever calling it. The
   * reason is worded for a person, since it shows up on screen verbatim.
   */
  async homeView(ref: AppRef): Promise<{ tool: string; resourceUri: string }> {
    const e = this.require(ref)
    if (!e.manifest) throw new AppUnavailableError(invalidReason(e))
    const home = e.manifest.home
    if (!home) throw new AppUnavailableError('This app has no screen: its manifest names no home tool')
    const all = await this.lifecycle.use(e, async () => e.life.tools ?? [])
    const found = all.find((t) => t.tool.name === home)
    if (!found) throw new AppUnavailableError(`This app has no screen: its home tool "${home}" is not in its tool list`)
    const ui = resourceUriOf(found.tool)
    if (ui.error) throw new AppUnavailableError(`This app's screen is declared wrong: ${ui.error}`)
    if (!ui.uri) throw new AppUnavailableError(`This app has no screen: its home tool "${home}" declares no _meta.ui.resourceUri`)
    return { tool: home, resourceUri: ui.uri }
  }
}
