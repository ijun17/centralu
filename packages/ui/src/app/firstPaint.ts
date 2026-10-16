import { applyCachedTheme } from './theme.js'
import { applyCachedTypography } from './typography.js'

/** The longest the first frame waits for the bundled fonts: a font that cannot load must not keep the window blank */
export const FONT_WAIT_MS = 3000

/**
 * What an entry does before it draws the app, shared by the browser entry and the desktop entry (#850 item 16).
 *
 * The theme and the text size the last run chose are applied at once: the preferences arrive a round trip later
 * (theme.ts, typography.ts), and even a waiting screen should open in them.
 *
 * The bundled fonts (#731) start loading now, and the returned promise settles once they are in. The app is drawn
 * after that. Drawn before, the first layout would use the fallback's metrics and move when the fonts arrive: a
 * conversation pinned to its bottom would end up above it (seen in CI, where the fonts load slower), and the code
 * font would leave the first path or terminal blank for its load (font-display: block). After `FONT_WAIT_MS` it
 * settles anyway and the app draws with the fallback. It never rejects.
 *
 * The desktop entry used to skip this wait (#850 item 16), so the jump the browser no longer had could still happen
 * in the app.
 */
export function prepareFirstPaint(doc: Pick<Document, 'fonts'> = document, waitMs = FONT_WAIT_MS): Promise<void> {
  applyCachedTheme()
  applyCachedTypography()
  return Promise.race([
    Promise.all([doc.fonts?.load('13px Pretendard'), doc.fonts?.load('12px D2Coding')]).then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
  ])
}
