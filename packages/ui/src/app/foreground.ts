/**
 * Is the app in front of the person right now.
 *
 * The notification policy hinges on this: do not notify while it is in front (that would be
 * noise). So if this judgment is wrong, notifications disappear silently — the kind of failure
 * that leaves no trace at all.
 *
 * Two signals are needed:
 *   - `hasFocus`   is it covered by another app (false when switching apps on a Mac)
 *   - `visibility` is it minimized or covered by another tab
 *
 * The visibilitychange handler used to look only at `visibility`. So after switching to another
 * app (becoming false via blur), if another occlusion event fired, it went back to true — because
 * the window was still 'visible'. From that moment on, notifications were blocked.
 */
export function isForeground(hasFocus: boolean, visibility: DocumentVisibilityState): boolean {
  return hasFocus && visibility === 'visible'
}
