/**
 * Calls the builds of what runs in a window drop wherever their result is unused (their arguments are still
 * evaluated), in our code and in the dependencies they bundle: the window's Vite builds (`apps/desktop`, `apps/web`)
 * and the app runtime's view script (packages/agent-host/scripts/build-app-runtime.mjs). A plain script, so the
 * runtime build can import it too.
 *
 * `console.debug`: ext-apps' PostMessageTransport logs every app message with it, the whole tool result as an argument,
 * on both sides (the window's bridge and the view), and the engine's console store keeps the last messages with their
 * arguments (V8 1000; WebKit 90–99, with developer extras on). A busy app view held about 18 MB of the window's heap
 * that way (`perf:memory --steps appview`, a board of 150 cards) for a log no one reads. `pnpm dev` still logs.
 */
export const PURE_CALLS = ['console.debug']
