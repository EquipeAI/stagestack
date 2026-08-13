import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { sameParams } from '@convex/shared/viewParams'
import { activeView, isUnnarrowed, presetList } from './model'
import type { Id } from '@convex/_generated/dataModel'
import type { ViewModule, ViewParams } from '@convex/shared/viewParams'
import type { MenuButtonItem } from '~/ds'
import type { StoredView } from './model'
import { Button, Dialog, Field, Input, MenuButton } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { copyToClipboard } from '~/lib/clipboard'

// The toolbar's saved-view slot, made real (W2).
//
// One component for every module table, because a view is the same idea on all
// of them: the URL already holds the state, this gives that state a name. The
// picker is the DS `MenuButton` — a real `role="menu"` with roving focus,
// arrow keys, Escape and focus return (W6) — so nothing about keyboard access
// is re-invented here.
//
// A shared view is its URL. There is no share model and no permission: "Copy
// link" copies the address bar, which carries the params and never this view's
// id, so the recipient gets the filters and none of the sender's preferences.

export function SavedViewsMenu({
  eventSlug,
  module,
  params,
  onApply,
}: {
  eventSlug: string
  module: ViewModule
  /** The params currently in the URL, as a view would store them. */
  params: ViewParams
  onApply: (params: ViewParams) => void
}) {
  const data = useQuery(api.savedViews.list, { eventSlug, module })
  const create = useMutation(api.savedViews.create)
  const rename = useMutation(api.savedViews.rename)
  const updateParams = useMutation(api.savedViews.updateParams)
  const remove = useMutation(api.savedViews.remove)
  const setDefault = useMutation(api.savedViews.setDefault)
  const { pending, error, setError, run } = usePending({ announce: false })

  const [dialog, setDialog] = useState<'save' | 'rename' | null>(null)
  const [name, setName] = useState('')
  // WHICH view is on screen, carried rather than inferred. Two views can hold
  // the same filters, and the URL cannot tell them apart — so the picker
  // remembers the row that was picked, and `activeView` drops it the moment the
  // params stop matching it. Switching views is still pure URL navigation:
  // `onApply` does the same thing it always did, this only names the result.
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null)

  const saved: Array<StoredView> = (data?.views ?? []).map((view) => ({
    viewId: view.viewId,
    name: view.name,
    params: view.params,
    isDefault: view.isDefault,
  }))
  const active = activeView(module, params, saved, selectedViewId)

  /** Pick a saved view: its params go to the URL, its id stays here. */
  const applySaved = (view: { viewId: string; params: ViewParams }) => {
    setSelectedViewId(view.viewId)
    onApply(view.params)
  }

  // `activeView` only IGNORES a pick the params have left behind; the state has
  // to FORGET it. Leaving it stored re-armed it on the way back: navigate off
  // filters two views share, come back to them, and Delete pointed at the view
  // picked on the previous visit — a row nobody chose this time.
  //
  // Keyed on the params CHANGING, not on their current value: `applySaved`
  // stores the id one render before the URL catches up, so comparing against
  // the params still on screen at that moment would throw away the pick it had
  // just made.
  const seenParams = useRef(params)
  useEffect(() => {
    if (sameParams(seenParams.current, params)) return
    seenParams.current = params
    setSelectedViewId((current) => {
      if (current === null) return null
      const picked = saved.find((view) => view.viewId === current)
      return picked !== undefined && sameParams(picked.params, params)
        ? current
        : null
    })
  })

  // The personal default, applied on a first visit that carries no filters of
  // its own. A link's own params always win — this only ever fires on the bare
  // route, and only once per mount, so it can never fight the organizer's own
  // navigation afterwards.
  const applied = useRef(false)
  useEffect(() => {
    if (applied.current || data === undefined) return
    applied.current = true
    if (data.defaultViewId === null) return
    if (!isUnnarrowed(module, params)) return
    const preferred = data.views.find(
      (view) => view.viewId === data.defaultViewId,
    )
    if (preferred !== undefined) applySaved(preferred)
    // Keyed on the query landing, not on `params`: this is a first-visit
    // decision, not a rule the URL has to keep satisfying afterwards.
  }, [data, module, params, onApply])

  // The model composed the sentence; it is printed verbatim.
  const report = (message: string) => {
    pushToast(message)
  }

  const items: Array<MenuButtonItem | false> = [
    ...(data === undefined
      ? [{ id: 'loading', label: 'Loading your views…', onSelect: () => {}, disabled: true }]
      : [{ id: 'summary', label: data.summary, onSelect: () => {}, disabled: true }]),
    { id: 'presets', label: 'Built in', onSelect: () => {}, disabled: true },
    ...presetList(module).map((preset) => ({
      id: `preset:${preset.id}`,
      label:
        active.kind === 'preset' && active.id === preset.id
          ? `${preset.name} — current`
          : preset.name,
      onSelect: () => {
        setSelectedViewId(null)
        onApply(preset.params)
      },
    })),
    saved.length > 0 && {
      id: 'saved',
      label: 'Saved by you',
      onSelect: () => {},
      disabled: true,
    },
    ...saved.map((view) => ({
      id: `saved:${view.viewId}`,
      label: [
        view.name,
        active.kind === 'saved' && active.id === view.viewId
          ? '— current'
          : active.kind === 'ambiguous' && active.ids.includes(view.viewId)
            ? '— same filters'
            : '',
        view.isDefault ? '· default' : '',
      ]
        .filter((part) => part !== '')
        .join(' '),
      onSelect: () => applySaved(view),
    })),
    { id: 'actions', label: 'This view', onSelect: () => {}, disabled: true },
    {
      id: 'save',
      label: 'Save this view…',
      disabled: pending,
      onSelect: () => {
        setError(null)
        setName('')
        setDialog('save')
      },
    },
    active.kind === 'saved' && {
      id: 'update',
      label: `Update “${active.name}” to what is on screen`,
      disabled: pending,
      onSelect: () => {
        void run(async () => {
          const result = await updateParams({
            eventSlug,
            viewId: active.id as Id<'savedViews'>,
            params,
          })
          report(result.message)
        })
      },
    },
    active.kind === 'saved' && {
      id: 'rename',
      label: 'Rename…',
      disabled: pending,
      onSelect: () => {
        setError(null)
        setName(active.name)
        setDialog('rename')
      },
    },
    active.kind === 'saved' && {
      id: 'default',
      label: active.isDefault
        ? 'Stop opening this table on this view'
        : 'Set as my default for this table',
      disabled: pending,
      onSelect: () => {
        void run(async () => {
          const result = await setDefault({
            eventSlug,
            viewId: active.id as Id<'savedViews'>,
            isDefault: !active.isDefault,
          })
          report(result.message)
        })
      },
    },
    active.kind === 'saved' && {
      id: 'delete',
      label: `Delete “${active.name}”`,
      tone: 'danger' as const,
      disabled: pending,
      onSelect: () => {
        void run(async () => {
          const result = await remove({
            eventSlug,
            viewId: active.id as Id<'savedViews'>,
          })
          // The row it named is gone; nothing is picked any more.
          setSelectedViewId(null)
          report(result.message)
        })
      },
    },
    {
      id: 'copy',
      label: 'Copy link to this view',
      onSelect: () => {
        if (typeof window === 'undefined') return
        void copyToClipboard(
          window.location.href,
          'Link copied — it carries these filters.',
        )
      },
    },
  ]

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed === '') return
    void run(async () => {
      const result =
        dialog === 'rename' && active.kind === 'saved'
          ? await rename({
              eventSlug,
              viewId: active.id as Id<'savedViews'>,
              name: trimmed,
            })
          : await create({ eventSlug, module, name: trimmed, params })
      // A view just saved from these params IS the one on screen — including
      // when an identical one already existed under another name.
      if (dialog !== 'rename') setSelectedViewId(result.viewId)
      report(result.message)
      setDialog(null)
    })
  }

  return (
    <>
      <MenuButton
        icon="list-filter"
        iconRight="chevron-down"
        variant="secondary"
        align="start"
        width="21rem"
        label={active.name}
        // The trigger's text is a view name, which says nothing about what it
        // is on its own. The accessible name says both — and when the filters
        // belong to more than one saved view it says THAT, instead of picking
        // a name the organizer never chose.
        aria-label={
          active.kind === 'ambiguous'
            ? `Saved views. These filters match ${active.ids.length} saved views — pick one from this menu to work on it.`
            : `Saved views. Current view: ${active.name}.`
        }
        items={items}
      />
      {dialog === null ? null : (
        <Dialog
          open
          width={480}
          title={dialog === 'rename' ? 'Rename this view' : 'Save this view'}
          description={
            dialog === 'rename'
              ? 'Only the name changes. The filters stay as they are.'
              : 'The search, filters and sort in the address bar, kept under a name only you see.'
          }
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={pending || name.trim() === ''}
                onClick={submit}
              >
                {dialog === 'rename' ? 'Rename' : 'Save view'}
              </Button>
            </>
          }
        >
          <Field
            label="View name"
            htmlFor="saved-view-name"
            error={error ?? undefined}
          >
            <Input
              id="saved-view-name"
              autoFocus
              value={name}
              placeholder="Wave 1 shortlist"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setName(e.target.value)
              }
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </Field>
        </Dialog>
      )}
    </>
  )
}
