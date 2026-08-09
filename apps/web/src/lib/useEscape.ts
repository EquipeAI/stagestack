import { useEffect, useRef } from 'react'

// The design system's Dialog is presentational — it closes on the scrim and on
// its own close button, but not on Escape. This is the one place that gap is
// filled, and it is stack-aware: a confirm opened on top of a detail dialog
// takes the key, and the dialog underneath stays put.

const stack: Array<() => void> = []

export function useEscape(onEscape: () => void) {
  const latest = useRef(onEscape)
  latest.current = onEscape

  useEffect(() => {
    const entry = () => latest.current()
    stack.push(entry)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (stack[stack.length - 1] !== entry) return
      event.stopPropagation()
      entry()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      const at = stack.indexOf(entry)
      if (at >= 0) stack.splice(at, 1)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
