import { useCallback, useRef, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { useAutosave } from './useAutosave'
import {
  speakersComplete,
  speakersFromDocs,
  speakersToInput,
} from './SpeakersEditor'
import type { AnswerValue } from '@convex/shared/formDef'
import type { Doc, Id } from '@convex/_generated/dataModel'
import type { Autosave } from './useAutosave'
import type { SpeakerDraft } from './SpeakersEditor'
import type { Answers, UploadedNames } from './model'

// Local drafts + write-behind for the two editable halves of a proposal.
// The submitter is the only writer, so the local copy wins for the lifetime of
// the editor and the reactive query is only used to seed it.

export type AnswersDraft = {
  answers: Answers
  setAnswer: (fieldId: string, value: AnswerValue) => void
  uploadedNames: UploadedNames
  noteUpload: (fieldId: string, filename: string) => void
  autosave: Autosave<Answers>
  saveNow: () => Promise<void>
}

export function useAnswersDraft(
  proposalId: Id<'proposals'>,
  initial: Answers,
): AnswersDraft {
  const saveAnswers = useMutation(api.cfp.saveAnswers)
  const [answers, setAnswers] = useState<Answers>(initial)
  const [uploadedNames, setUploadedNames] = useState<UploadedNames>({})
  const current = useRef<Answers>(initial)

  const autosave = useAutosave<Answers>(
    useCallback(
      async (value: Answers) => {
        await saveAnswers({ proposalId, answers: value })
      },
      [saveAnswers, proposalId],
    ),
  )

  const setAnswer = useCallback(
    (fieldId: string, value: AnswerValue) => {
      const next = { ...current.current, [fieldId]: value }
      current.current = next
      setAnswers(next)
      autosave.schedule(next)
    },
    [autosave],
  )

  const noteUpload = useCallback((fieldId: string, filename: string) => {
    setUploadedNames((prev) => ({ ...prev, [fieldId]: filename }))
  }, [])

  const saveNow = useCallback(
    () => autosave.saveNow(current.current),
    [autosave],
  )

  return { answers, setAnswer, uploadedNames, noteUpload, autosave, saveNow }
}

export type SpeakersDraft = {
  speakers: Array<SpeakerDraft>
  setSpeakers: (next: Array<SpeakerDraft>) => void
  /** True while a card is missing a name — nothing is written until it isn't. */
  incomplete: boolean
  autosave: Autosave<Array<SpeakerDraft>>
  saveNow: () => Promise<void>
}

export function useSpeakersDraft(
  proposalId: Id<'proposals'>,
  initial: Array<Doc<'proposalSpeakers'>>,
): SpeakersDraft {
  const setSpeakersMutation = useMutation(api.cfp.setSpeakers)
  const [speakers, setState] = useState<Array<SpeakerDraft>>(() =>
    speakersFromDocs(initial),
  )
  const current = useRef<Array<SpeakerDraft>>(speakers)

  const autosave = useAutosave<Array<SpeakerDraft>>(
    useCallback(
      async (value: Array<SpeakerDraft>) => {
        await setSpeakersMutation({
          proposalId,
          speakers: speakersToInput(value),
        })
      },
      [setSpeakersMutation, proposalId],
    ),
  )

  const setSpeakers = useCallback(
    (next: Array<SpeakerDraft>) => {
      current.current = next
      setState(next)
      // A nameless card is rejected by the backend, so it is never sent.
      if (speakersComplete(next)) autosave.schedule(next)
    },
    [autosave],
  )

  const saveNow = useCallback(async () => {
    if (speakersComplete(current.current)) await autosave.saveNow(current.current)
  }, [autosave])

  return {
    speakers,
    setSpeakers,
    incomplete: !speakersComplete(speakers),
    autosave,
    saveNow,
  }
}
