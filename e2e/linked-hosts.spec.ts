import { linkedHostsTests } from './fixtures/linked-hosts-scenarios.js'
import { linkedHostsUiTests } from './fixtures/linked-hosts-ui-scenarios.js'

/** A hub linked to a second host, driven through the real UI (#82, docs/plans/remote-hub.md §8) */
linkedHostsTests()
/** The phase 1 screens for linked machines: Settings → Machines, the grouped sidebar, away and back, versions (#82) */
linkedHostsUiTests()
