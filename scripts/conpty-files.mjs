/**
 * node-pty's files a Windows host's terminals cannot run without (#849), relative to its
 * `prebuilds/<platform>/` folder: `conpty.node` loads `conpty/conpty.dll` from beside itself, which
 * starts `conpty/OpenConsole.exe` for every pty. With the DLL there but OpenConsole.exe missing, every
 * terminal is dead, with no fallback: the DLL loads, so Windows' own ConPTY is never tried.
 *
 * Plain JavaScript, so the bundling script (`packages/agent-host/scripts/bundle.mjs`, run by `node`)
 * and the release checks (`host-package.mts`, `release-npm.mts`) read one list.
 */
export const CONPTY_FILES = ['conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
