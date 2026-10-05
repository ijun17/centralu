import { agentVersionsTests } from './fixtures/agent-versions.js'

/** A session that runs an older agent CLI than the one installed (#297): the header's line, its action, and the Settings switch. */
agentVersionsTests()
