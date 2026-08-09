import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { DEFAULT_DURATION_MS } from './model'
import type { BoardAgendaItem, BoardEvent, BoardRoom } from './model'
import type { Id } from '@convex/_generated/dataModel'
import {
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { fromInputValue, toInputValue } from '~/lib/datetime'

// Breaks, meals, registration, ceremonies (decision log #7). They share the
// grid and its overlap checks but carry no speakers and never release.

export function AgendaItemDialog({
  eventSlug,
  event,
  rooms,
  item,
  onClose,
}: {
  eventSlug: string
  event: BoardEvent
  rooms: Array<BoardRoom>
  /** Undefined = create. */
  item?: BoardAgendaItem
  onClose: () => void
}) {
  const create = useMutation(api.agenda.createAgendaItem)
  const update = useMutation(api.agenda.updateAgendaItem)
  const remove = useMutation(api.agenda.removeAgendaItem)
  const { pending, error, setError, run } = usePending()
  const zone = event.timezone
  const editing = item !== undefined

  const defaultStart = item?.startsAt ?? roundToHour(event.startsAt)
  const defaultEnd = item?.endsAt ?? defaultStart + DEFAULT_DURATION_MS
  const [title, setTitle] = useState(item?.title ?? '')
  const [start, setStart] = useState(toInputValue(defaultStart, zone))
  const [end, setEnd] = useState(toInputValue(defaultEnd, zone))
  const [roomId, setRoomId] = useState<string>(item?.roomId ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const save = () => {
    if (title.trim() === '') return setError('Name the block.')
    const startsAt = fromInputValue(start, zone)
    const endsAt = fromInputValue(end, zone)
    if (startsAt === null || endsAt === null) {
      return setError('Enter a valid start and end time.')
    }
    if (endsAt <= startsAt) {
      return setError('The end time must be after the start time.')
    }
    const room = roomId === '' ? undefined : (roomId as Id<'rooms'>)
    const desc = description.trim() === '' ? undefined : description.trim()
    void run(async () => {
      if (editing) {
        await update({
          eventSlug,
          itemId: item.itemId,
          patch: { title: title.trim(), startsAt, endsAt, roomId: room, description: desc },
        })
        pushToast('Block updated', `"${title.trim()}" was updated.`, 'calendar-days')
      } else {
        await create({
          eventSlug,
          title: title.trim(),
          startsAt,
          endsAt,
          roomId: room,
          description: desc,
        })
        pushToast('Block added', `"${title.trim()}" is on the board.`, 'calendar-days')
      }
      onClose()
    })
  }

  const doRemove = () => {
    if (item === undefined) return
    void run(async () => {
      await remove({ eventSlug, itemId: item.itemId })
      pushToast('Block removed', `"${item.title}" was removed from the board.`, 'trash-2')
      onClose()
    })
  }

  const roomOptions = [
    { value: '', label: 'All rooms' },
    ...rooms.map((room) => ({ value: room.roomId, label: room.name })),
  ]

  if (confirmingRemove && item !== undefined) {
    return (
      <Dialog
        open
        width={480}
        title="Remove this block?"
        description={`"${item.title}" is removed from the board. Agenda items notify no one, so nothing is sent.`}
        onClose={pending ? undefined : () => setConfirmingRemove(false)}
        footer={
          <>
            <Button disabled={pending} onClick={() => setConfirmingRemove(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={pending} onClick={doRemove}>
              {pending ? 'Removing…' : 'Remove block'}
            </Button>
          </>
        }
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      width={640}
      title={editing ? 'Edit block' : 'Add block'}
      description={`A break, meal, registration or ceremony. Times are in ${zone}.`}
      onClose={pending ? undefined : onClose}
      footer={
        <>
          {editing ? (
            <Button
              variant="ghost"
              iconLeft="trash-2"
              disabled={pending}
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </Button>
          ) : null}
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : editing ? 'Save block' : 'Add block'}
          </Button>
        </>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <Field label="Title" htmlFor="item-title" required>
          <Input
            id="item-title"
            value={title}
            autoFocus
            placeholder="Lunch"
            onChange={(e) => {
              setTitle(e.target.value)
            }}
          />
        </Field>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 12rem' }}>
            <Field label="Start" htmlFor="item-start" required>
              <Input
                id="item-start"
                type="datetime-local"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value)
                }}
              />
            </Field>
          </div>
          <div style={{ flex: '1 1 12rem' }}>
            <Field label="End" htmlFor="item-end" required>
              <Input
                id="item-end"
                type="datetime-local"
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value)
                }}
              />
            </Field>
          </div>
        </div>
        <Field label="Room" htmlFor="item-room" optional hint="Leave as all rooms for a venue-wide break.">
          <Select
            id="item-room"
            options={roomOptions}
            value={roomId}
            onChange={(e) => {
              setRoomId(e.target.value)
            }}
          />
        </Field>
        <Field label="Description" htmlFor="item-desc" optional>
          <Textarea
            id="item-desc"
            rows={2}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
            }}
          />
        </Field>
      </div>
    </Dialog>
  )
}

function roundToHour(ms: number): number {
  return Math.round(ms / (60 * 60 * 1000)) * 60 * 60 * 1000
}
