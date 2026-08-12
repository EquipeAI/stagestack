import type { CSSProperties } from 'react'
import { useAnnouncements } from '~/lib/announce'

// The app's ONE pair of live regions (see lib/announce.ts). Mounted once, at
// the document root, for three reasons:
//
//   - a live region has to be in the document before its content arrives; a
//     region inserted with the message already inside is not reliably spoken;
//   - it must exist on every route, not only the ones that render a toast
//     viewport — /invite runs mutations through usePending and has no toasts;
//   - two regions is the whole set. Nesting live regions, or having several
//     announce the same event, is how one action gets read out twice.
//
// The only other `aria-live` in the codebase is ActionResult's, which
// describes the element it is attached to. Nothing else may declare one.

const HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
}

export function LiveRegion() {
  const { polite, assertive } = useAnnouncements()
  return (
    <>
      <div style={HIDDEN} role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div style={HIDDEN} role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </>
  )
}
