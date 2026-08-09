import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { DEFAULT_DURATION_MS, slotClock } from './model'
import type { BoardEvent, BoardRoom, BoardSession } from './model'
import type { Id } from '@convex/_generated/dataModel'
import { Button, Callout, Dialog, Field, Input, Select } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { fromInputValue, toInputValue } from '~/lib/datetime'

// The non-drag path to a placement (M6): room + start + end, in event time.
// This is the whole scheduling story on a phone, and the refine-after-drop
// editor on a desktop. Everything here is a draft — it notifies no one.

export function PlaceDialog({
  eventSlug,
  event,
  session,
  rooms,
  onClose,
}: {
  eventSlug: string
  event: BoardEvent
  session: BoardSession
  rooms: Array<BoardRoom>
  onClose: () => void
}) {
  const schedule = useMutation(api.agenda.scheduleSession)
  const { pending, error, setError, run } = usePending()
  const zone = event.timezone

  const defaultStart = session.startsAt ?? roundToHour(event.startsAt)
  const defaultEnd = session.endsAt ?? defaultStart + DEFAULT_DURATION_MS
  const [start, setStart] = useState(toInputValue(defaultStart, zone))
  const [end, setEnd] = useState(toInputValue(defaultEnd, zone))
  const [roomId, setRoomId] = useState<string>(session.roomId ?? '')

  const wasScheduled = session.startsAt !== undefined

  const save = () => {
    const startsAt = fromInputValue(start, zone)
    const endsAt = fromInputValue(end, zone)
    if (startsAt === null || endsAt === null) {
      return setError('Enter a valid start and end time.')
    }
    if (endsAt <= startsAt) {
      return setError('The end time must be after the start time.')
    }
    void run(async () => {
      await schedule({
        eventSlug,
        sessionId: session.sessionId,
        slot: {
          startsAt,
          endsAt,
          roomId: roomId === '' ? undefined : (roomId as Id<'rooms'>),
        },
      })
      pushToast(
        'Session placed',
        `"${session.title}" is on the board at ${slotClock(startsAt, endsAt, zone)} (${zone}). Nothing was sent — release the slot when you're ready to tell the speakers.`,
        'calendar-days',
      )
      onClose()
    })
  }

  const unschedule = () => {
    void run(async () => {
      await schedule({ eventSlug, sessionId: session.sessionId, slot: null })
      pushToast(
        'Sent to unscheduled',
        `"${session.title}" is back in the tray. Any released slot stays with the speakers until you cancel it.`,
        'calendar-days',
      )
      onClose()
    })
  }

  const roomOptions = [
    { value: '', label: 'No room' },
    ...rooms.map((room) => ({ value: room.roomId, label: room.name })),
  ]

  return (
    <Dialog
      open
      width={480}
      title={wasScheduled ? 'Edit placement' : 'Place session'}
      description={`"${session.title}" — times are in ${zone}. This is a draft; it notifies no one.`}
      onClose={pending ? undefined : onClose}
      footer={
        <>
          {wasScheduled ? (
            <Button variant="ghost" disabled={pending} onClick={unschedule}>
              Send to unscheduled
            </Button>
          ) : null}
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : wasScheduled ? 'Save placement' : 'Place session'}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        {rooms.length === 0 ? (
          <Callout tone="attention" title="No rooms yet">
            You can place this on the timeline without a room, but the Room view
            needs at least one room. Add rooms in Settings.
          </Callout>
        ) : null}
        <Field label="Room" htmlFor="place-room" optional>
          <Select
            id="place-room"
            options={roomOptions}
            value={roomId}
            onChange={(e) => {
              setRoomId(e.target.value)
            }}
          />
        </Field>
        <Field label="Start" htmlFor="place-start" required>
          <Input
            id="place-start"
            type="datetime-local"
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
            }}
          />
        </Field>
        <Field label="End" htmlFor="place-end" required>
          <Input
            id="place-end"
            type="datetime-local"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value)
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
