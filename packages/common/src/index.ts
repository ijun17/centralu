/**
 * Small pure helpers that the host and the screen both run (docs/architecture.md §2): no IO, no React, no domain.
 * A helper of this kind is written once here, so a fix reaches every caller on both sides of the process.
 */
export * from './listeners.js'
export * from './pending-requests.js'
