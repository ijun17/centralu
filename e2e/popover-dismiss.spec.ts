import { popoverDismissTests } from './fixtures/popover-dismiss.js'

/** Popovers and menus close the one way: Escape for the innermost, a window blur, focus back to the button (#428). */
popoverDismissTests()
