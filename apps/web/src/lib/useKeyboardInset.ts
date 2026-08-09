import { useEffect } from 'react'

/**
 * Publishes the on-screen keyboard's height to CSS as `--kb`.
 *
 * Why this exists: when a phone keyboard opens, iOS Safari (and Chrome on
 * Android since 108) resizes only the *visual* viewport. The layout viewport,
 * and therefore every CSS unit including `dvh`, is unchanged — so a
 * `position: fixed` bottom bar or a bottom-sheet footer does not move, and the
 * keyboard simply covers it. The `interactive-widget` viewport key would fix
 * that on Android, but it does not exist on iOS, so parity needs this shim.
 *
 * `visualViewport.height + offsetTop` is the part of the layout viewport still
 * visible; what is missing from `innerHeight` is the keyboard.
 *
 * Consumers use it as an additive inset, so it degrades to 0 everywhere the API
 * is missing and on every desktop browser:
 *
 *   bottom: calc(var(--kb, 0px) + var(--safe-bottom));
 */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const root = document.documentElement
    let raf = 0

    const sync = () => {
      // resize/scroll on the visual viewport fire at touch-move frequency
      // while the keyboard animates; coalescing to one write per frame keeps
      // this off the critical path of the interaction.
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
        root.style.setProperty('--kb', `${Math.round(kb)}px`)
      })
    }

    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
    sync()

    return () => {
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
      cancelAnimationFrame(raf)
      root.style.removeProperty('--kb')
    }
  }, [])
}
