import type { ChangeEvent, ReactNode } from 'react'
import { Button } from '~/ds'

/**
 * A file chooser that a keyboard can reach.
 *
 * The pattern this replaces was `<Button as="label">` wrapping an
 * `<input type="file" style={{display:'none'}}>`. A bare `<label>` has no
 * tabindex and no activation behaviour, and a `display:none` input is removed
 * from the tab order — so between them there was no keyboard path to "Choose a
 * file" at all (WCAG 2.1.1).
 *
 * The fix is the canonical one: the input stays the real control and is only
 * *visually* hidden, so it keeps its focus, its Enter/Space activation and its
 * native "file upload button" role. The styled label rides along, and picks up
 * the focus ring through `:focus-within` (see `.file-button` in app.css)
 * because the ring would otherwise land on a control nobody can see.
 */
export function FileButton({
  children,
  onFile,
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  id,
  variant,
  size,
  iconLeft = 'upload',
}: {
  children: ReactNode
  /** The first chosen file. The only thing any current caller wants. */
  onFile?: (file: File) => void
  /** Every chosen file, in the order the picker returned them. */
  onFiles?: (files: Array<File>) => void
  accept?: string
  /** Forwarded to the input. No caller sets it today; the prop exists so a
   *  multi-file surface cannot be built by reaching around this component. */
  multiple?: boolean
  disabled?: boolean
  /** Set when an outer `Field htmlFor` has to name this control. */
  id?: string
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  iconLeft?: string
}) {
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // Cleared so choosing the same file twice in a row still fires a change.
    event.target.value = ''
    if (files.length === 0) return
    if (onFiles !== undefined) onFiles(files)
    if (onFile !== undefined) onFile(files[0])
  }
  return (
    <Button
      as="label"
      className="file-button"
      variant={variant}
      size={size}
      iconLeft={iconLeft}
      // The DS already styles `.ss-btn[aria-disabled=true]`; the input carries
      // the real `disabled`, which is what actually stops activation.
      aria-disabled={disabled ? true : undefined}
    >
      {/* Also wrapped by the label, so a control with no `id` is still named
          by the button text — the `id` is only for an outer Field's `for`. */}
      <input
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={onChange}
        className="file-button__input"
      />
      {children}
    </Button>
  )
}
