/**
 * Calls the window's Vite builds (`apps/desktop`, `apps/web`) drop wherever their result is unused, in our code and in
 * the dependencies they bundle.
 *
 * `console.debug`: ext-apps' PostMessageTransport logs every app message with it, the whole tool result as an argument,
 * and the engine's console store keeps the last messages with their arguments (V8 1000; WebKit 90–99, with developer
 * extras on). A busy app view held about 18 MB of the window's heap that way (`perf:memory --steps appview`, a board of
 * 150 cards) for a log no one reads. `pnpm dev` still logs. The app runtime's view build drops the same calls
 * (packages/agent-host/scripts/build-app-runtime.mjs).
 */
export const PURE_CALLS = ['console.debug']
