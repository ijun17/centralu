import { useEffect, useRef, useState } from 'react'

/** How long a copy button says "Copied" before it offers the copy again */
const COPIED_MS = 2000

/**
 * Copies text to the clipboard and says so: `copied` is true for a moment after a copy that worked, for the button to read
 * "Copied" where it read "Copy". A window with no clipboard access, or a refusal, leaves it false.
 */
export function useCopied(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = (text: string) => {
    clearTimeout(timer.current)
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      },
      () => setCopied(false),
    )
  }
  return { copied, copy }
}
