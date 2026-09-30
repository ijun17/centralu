/**
 * A name that points at one app — (scope, id). An app id is unique only within its scope: `notes`
 * in two different projects is two different apps. When `projectId` is null, the app belongs to
 * the user's folder rather than a project.
 *
 * Shared by the runtime's door (`runtime.ts`) and the broker desk (`desk.ts`) — if either one
 * imported the other, it would form a cycle.
 */
export type AppRef = { projectId: string | null; appId: string }
