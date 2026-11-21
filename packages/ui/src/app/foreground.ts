/**
 * Notifications are held while the app is in front, so a wrong answer drops them silently. `visibility` alone is not
 * enough: after a switch to another app (blur), an occlusion event still finds the window 'visible'.
 */
export function isForeground(hasFocus: boolean, visibility: DocumentVisibilityState): boolean {
  return hasFocus && visibility === 'visible'
}
