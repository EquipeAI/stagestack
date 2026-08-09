import { pushToast } from '~/components/toast'

// One clipboard path for the whole app. The async API is absent on insecure
// origins and inside some embedded browsers, and it rejects when the page is
// not focused — a copy button that silently does nothing is worse than one
// that says it failed, so every outcome is reported.

/** Selection-based fallback for browsers without an async clipboard. */
function copyBySelection(text: string): boolean {
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  document.body.removeChild(area)
  return copied
}

/** True when the text reached the clipboard. Reports either way. */
export async function copyToClipboard(
  text: string,
  toast: string,
): Promise<boolean> {
  if (typeof window === 'undefined' || text === '') return false
  let copied = false
  try {
    // Absent (not merely rejecting) on insecure origins, so the access itself
    // is inside the guard.
    await navigator.clipboard.writeText(text)
    copied = true
  } catch {
    copied = false
  }
  if (!copied) copied = copyBySelection(text)
  pushToast(
    copied ? toast : 'Copy failed',
    copied
      ? undefined
      : 'This browser blocked the clipboard — select the text and copy it by hand.',
    copied ? 'copy' : undefined,
  )
  return copied
}
