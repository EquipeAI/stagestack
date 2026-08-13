import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { getFunctionName } from 'convex/server'

// The composer's contract (W3): the preview is the SERVER's rendering of the
// draft — the editor never substitutes anything itself — and the palette lands
// a token in the field the organizer was last typing in.

const { state } = vi.hoisted(() => ({
  state: {
    preview: undefined as Record<string, unknown> | undefined,
    recipients: [] as Array<Record<string, unknown>>,
    previewArgs: null as Record<string, unknown> | null,
  },
}))

vi.mock('convex/react', () => ({
  useQuery: (
    ref: Parameters<typeof getFunctionName>[0],
    args: Record<string, unknown> | 'skip',
  ) => {
    const name = getFunctionName(ref)
    if (name === 'templates:previewRecipients') return state.recipients
    if (name === 'templates:preview') {
      if (args === 'skip') return undefined
      state.previewArgs = args
      return state.preview
    }
    return undefined
  },
  useMutation: () => vi.fn(),
}))

// eslint-disable-next-line import/first -- vi.mock is hoisted above this
import { TemplateEditorDialog } from './TemplateEditorDialog'

const TEMPLATE = {
  key: 'portal.invite',
  name: 'Speaker portal invitation',
  subject: 'Your speaker portal for {{event.name}}',
  html: '<p>Hi {{speaker.firstName}},</p>',
  customized: false,
}

beforeEach(() => {
  state.previewArgs = null
  state.recipients = [
    {
      eventContactId: 'ec_1',
      name: 'Dana Keynote',
      firstName: 'Dana',
      lastName: 'Keynote',
      email: 'dana@example.com',
      sample: false,
    },
  ]
  state.preview = {
    subject: 'Your speaker portal for Acme Summit',
    html: '<p>Hi Dana,</p>',
    recipient: {
      eventContactId: null,
      name: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      sample: true,
    },
  }
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  })
})

afterEach(cleanup)

function renderEditor(template: Partial<typeof TEMPLATE> = {}) {
  return render(
    <TemplateEditorDialog
      eventSlug="acme-summit"
      template={{ ...TEMPLATE, ...template }}
      onRequestReset={() => {}}
      onClose={() => {}}
    />,
  )
}

describe('TemplateEditorDialog', () => {
  test('shows the server-rendered subject, not a local substitution', () => {
    renderEditor()
    expect(screen.getByText('Your speaker portal for Acme Summit')).toBeTruthy()
    expect(state.previewArgs).toMatchObject({
      eventSlug: 'acme-summit',
      key: 'portal.invite',
    })
  })

  test('says out loud when the recipient is a stand-in, politely', () => {
    renderEditor()
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toContain(
      'Ada Lovelace is not a real speaker on this event',
    )
  })

  test('names the real recipient once one is rendered against', () => {
    state.preview = {
      ...state.preview,
      recipient: {
        eventContactId: 'ec_1',
        name: 'Dana Keynote',
        firstName: 'Dana',
        lastName: 'Keynote',
        email: 'dana@example.com',
        sample: false,
      },
    }
    renderEditor()
    expect(screen.getByRole('status').textContent).toBe(
      'As Dana Keynote would receive it.',
    )
  })

  test('choosing a speaker asks the server for that person’s copy', () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText(/Preview as/), {
      target: { value: 'ec_1' },
    })
    expect(state.previewArgs).toMatchObject({ eventContactId: 'ec_1' })
  })

  test('a palette token lands in the body at the cursor', () => {
    renderEditor()
    const body = screen.getByLabelText<HTMLTextAreaElement>(/Body/)
    fireEvent.focus(body)
    body.setSelectionRange(6, 6)

    fireEvent.click(
      screen.getByRole('button', { name: 'Insert speaker last name token' }),
    )
    expect(body.value).toBe('<p>Hi {{speaker.lastName}}{{speaker.firstName}},</p>')
    expect(document.activeElement).toBe(body)
  })

  test('a palette token lands in the subject once the subject has focus', () => {
    renderEditor()
    const subject = screen.getByLabelText<HTMLInputElement>(/Subject/)
    fireEvent.focus(subject)
    subject.setSelectionRange(subject.value.length, subject.value.length)

    fireEvent.click(screen.getByRole('button', { name: 'Insert link token' }))
    expect(subject.value).toBe('Your speaker portal for {{event.name}}{{link}}')
  })

  // REGRESSION (codex, W3): the warning validated against the GLOBAL catalog,
  // so a real-but-unpassed token — {{speaker.firstName}} in a decision email,
  // which passes no speaker — drew no warning at all, previewed empty and sent
  // with the token silently removed.
  test('warns about a variable this template’s send does not pass, and says that is what it is', () => {
    renderEditor({
      key: 'decision.accepted',
      name: 'Decision — accepted',
      subject: 'Your talk at {{event.name}}',
      html: '<p>Hi {{speaker.firstName}},</p>',
    })
    expect(
      screen.getByText(
        "{{speaker.firstName}} is a real variable, but this template's send passes no value for it. It renders as nothing.",
      ),
    ).toBeTruthy()
  })

  test('a misspelling is a different sentence from an unavailable variable', () => {
    renderEditor({
      key: 'decision.accepted',
      html: '<p>Hi {{speaker.nickname}}, about {{speaker.firstName}}.</p>',
    })
    expect(
      screen.getByText(
        "{{speaker.nickname}} is not a StageStack variable — check the spelling. {{speaker.firstName}} is a real variable, but this template's send passes no value for it. They render as nothing.",
      ),
    ).toBeTruthy()
  })

  test('a variable the template DOES pass draws no warning', () => {
    renderEditor()
    expect(screen.queryByText('These render as empty')).toBeNull()
  })

  test('the preview region is labelled', () => {
    renderEditor()
    expect(screen.getByRole('region', { name: 'Preview' })).toBeTruthy()
  })
})
