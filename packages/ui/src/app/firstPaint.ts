import { applyCachedTheme } from './theme.js'
import { applyCachedTypography } from './typography.js'

/** The longest the first frame waits for the bundled fonts: a font that cannot load must not keep the window blank */
const FONT_WAIT_MS = 3000

/**
 * Before either entry draws the app (#850 item 16): applies the last run's theme and text size (preferences arrive a
 * round trip later) and waits for the bundled fonts (#731); never rejects. Drawn with the fallback's metrics, the
 * layout moves when they arrive (a pinned conversation ends above its bottom, seen in CI) and the code font leaves the
 * first path or terminal blank (font-display: block).
 */
export function prepareFirstPaint(doc: Pick<Document, 'fonts'> = document, waitMs = FONT_WAIT_MS): Promise<void> {
  applyCachedTheme()
  applyCachedTypography()
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.all([doc.fonts?.load('13px Pretendard'), doc.fonts?.load('12px D2Coding')]).then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
    }),
  ]).finally(() => clearTimeout(timer))
}
