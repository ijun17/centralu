/** Types of bundle-host.mjs (plain JavaScript, run by bundle.mjs under plain node), for a test that builds the host as it ships */
export function bundleHostScript(o: { root: string; outfile: string; buildId: string }): Promise<void>
export function bundleInfoText(o: { root: string; buildId: string }): string
