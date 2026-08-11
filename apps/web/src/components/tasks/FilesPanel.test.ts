import { describe, expect, it } from 'vitest'
import { folderFor, planZipPaths, safeZipFilename } from './FilesPanel'
import type { BundleFile } from './FilesPanel'

const files: Array<BundleFile> = [
  {
    filename: 'slides.pdf',
    url: 'https://files.test/latest-a',
    sessionTitle: 'Opening Keynote',
    speakerName: 'Ada Lovelace',
    requirementTitle: 'Slides',
  },
  {
    filename: 'slides.pdf',
    url: 'https://files.test/latest-b',
    sessionTitle: 'Opening Keynote',
    speakerName: 'Grace Hopper',
    requirementTitle: 'Slides',
  },
]

describe('deliverables ZIP planning', () => {
  it('groups by session, speaker, or no folder', () => {
    expect(folderFor(files[0], 'session')).toBe('opening-keynote')
    expect(folderFor(files[0], 'speaker')).toBe('ada-lovelace')
    expect(folderFor(files[0], 'flat')).toBe('')
  })

  it('plans deterministic collision-free paths for exactly the selected bundle', () => {
    expect(planZipPaths(files, 'session').map((row) => row.path)).toEqual([
      'opening-keynote/slides.pdf',
      'opening-keynote/slides-2.pdf',
    ])
    expect(planZipPaths([files[1]], 'flat').map((row) => row.path)).toEqual([
      'slides.pdf',
    ])
  })

  it('collapses untrusted upload paths to safe collision-free basenames', () => {
    expect(safeZipFilename('../../slides.pdf')).toBe('slides.pdf')
    expect(safeZipFilename('..\\slides.pdf')).toBe('slides.pdf')
    expect(safeZipFilename('../')).toBe('file')
    const unsafe = [
      { ...files[0], filename: '../../slides.pdf' },
      { ...files[1], filename: 'nested/slides.pdf' },
    ]
    expect(planZipPaths(unsafe, 'session').map((row) => row.path)).toEqual([
      'opening-keynote/slides.pdf',
      'opening-keynote/slides-2.pdf',
    ])
  })

  it('avoids case-insensitive filename collisions on common extractors', () => {
    const mixedCase = [
      { ...files[0], filename: 'Slides.pdf' },
      { ...files[1], filename: 'slides.pdf' },
    ]
    expect(planZipPaths(mixedCase, 'session').map((row) => row.path)).toEqual([
      'opening-keynote/Slides.pdf',
      'opening-keynote/slides-2.pdf',
    ])
  })
})
