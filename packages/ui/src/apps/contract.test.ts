import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AppId, AppModule } from './contract.js'

/**
 * Guards against the app id being closed back off (M4 P-1).
 *
 * Building an app module with a name only known at runtime (here, a string read from JSON) is
 * exactly the shape an external app takes when registering itself. If the union were closed back
 * off, this file would fail to compile — that check is `tsc -b`'s job. vitest does not look at
 * types, so the runtime assertion here only confirms the value made it through as-is.
 */
describe('the app id is an open string', () => {
  it('can build an app module even with a name the build does not know', () => {
    const discovered: string = JSON.parse('"resource-search"')
    const mod: AppModule = { id: discovered, title: 'Resource search' }

    expectTypeOf<AppId>().toEqualTypeOf<string>()
    expect(mod.id).toBe('resource-search')
  })
})
