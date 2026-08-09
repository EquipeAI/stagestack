import type * as React from 'react'
import { Dialog } from '~/ds'
import { useEscape } from '~/lib/useEscape'

/** The design system's Dialog plus Escape-to-close. Every dialog on this
 * screen goes through here so the behaviour is written once. */
export function Modal({
  title,
  description,
  width,
  onClose,
  footer,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  width?: number
  onClose: () => void
  footer?: React.ReactNode
  children?: React.ReactNode
}) {
  useEscape(onClose)
  return (
    <Dialog
      title={title}
      description={description}
      width={width}
      onClose={onClose}
      footer={footer}
    >
      {children}
    </Dialog>
  )
}
