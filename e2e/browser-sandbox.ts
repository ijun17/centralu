/** Refuse the macOS sandbox that strips Playwright's DYLD_* paths before any browser is launched (#592). */
export function assertBrowserSandbox(
  engine: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // A default run includes WebKit twins even though its warm-up uses Chromium. CI=1 is also used locally.
  if (platform === 'darwin' && env.CODEX_SANDBOX === 'seatbelt' &&
      (engine !== 'chromium' || env.STYLE_SNAPSHOT_BROWSER === 'webkit')) {
    const style = env.STYLE_SNAPSHOT_BROWSER === 'webkit' ? '; unset STYLE_SNAPSHOT_BROWSER=webkit' : ''
    throw new Error(`WebKit cannot run in this sandbox; run E2E_BROWSER=chromium with pnpm e2e, pnpm ux or pnpm perf${style}; CI runs WebKit`)
  }
}
