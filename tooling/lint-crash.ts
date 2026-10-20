/**
 * Imported first by tooling/lint.ts: a crash (a list that cannot be read, an ESLint or config error, running out of
 * memory, an option it does not take) exits 2, apart from findings (1). The weekly tighten job
 * (.github/workflows/lint-tighten.yml) lowers the lists whatever findings main has, and fails on a crash instead of
 * reporting "nothing to open" for ever (#1343 review).
 */
const crash = (e: unknown) => {
  console.error(e)
  process.exit(2)
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

export {}
