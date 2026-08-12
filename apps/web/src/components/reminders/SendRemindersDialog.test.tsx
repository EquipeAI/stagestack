import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SendRemindersDialog } from './SendRemindersDialog'

afterEach(cleanup)

const base = {
  recipients: 4,
  tasks: 9,
  unreachableSpeakers: 0,
  overCap: false,
  cap: 200,
  blocked: null,
}

function sendButton() {
  return screen.getByRole('button', { name: 'Send reminders' })
}

describe('SendRemindersDialog', () => {
  test('states the audience, the exclusions and the consequence before sending', () => {
    render(
      <SendRemindersDialog
        preview={{ ...base, unreachableSpeakers: 2 }}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(screen.getByText('Who qualifies')).toBeTruthy()
    expect(screen.getByText('Who is excluded')).toBeTruthy()
    expect(screen.getByText('What it changes')).toBeTruthy()
    expect(document.body.textContent).toContain('4 recipients')
    expect(document.body.textContent).toContain('9 outstanding tasks')
    expect(document.body.textContent).toContain('2 speakers have')
    expect(document.body.textContent).toContain('reset the cadence clock')
    expect(sendButton().hasAttribute('disabled')).toBe(false)
  })

  test('an over-cap set says the send will be refused, and blocks it', () => {
    render(
      <SendRemindersDialog
        preview={{ ...base, overCap: true }}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(document.body.textContent).toContain('will be refused')
    expect(document.body.textContent).toContain('200')
    expect(sendButton().hasAttribute('disabled')).toBe(true)
  })

  test('an archived event and an empty audience both block the send', () => {
    const { unmount } = render(
      <SendRemindersDialog
        preview={{ ...base, blocked: 'archived' as const }}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(document.body.textContent).toContain('Archived events')
    expect(sendButton().hasAttribute('disabled')).toBe(true)
    unmount()

    render(
      <SendRemindersDialog
        preview={{ ...base, recipients: 0, tasks: 0 }}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(document.body.textContent).toContain('Nobody has an outstanding')
    expect(sendButton().hasAttribute('disabled')).toBe(true)
  })

  test('nothing can be sent before the audience is known', () => {
    render(
      <SendRemindersDialog
        preview={undefined}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(document.body.textContent).toContain('Working out who')
    expect(sendButton().hasAttribute('disabled')).toBe(true)
  })
})
