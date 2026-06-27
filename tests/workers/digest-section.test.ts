import { describe, it, expect } from 'vitest'
import { buildDigestSection } from '../../src/workers/digest-section.js'
import type { DigestRow } from '../../src/domain/initiations/digest-queue.js'

describe('buildDigestSection', () => {
  it('builds a digest section from rows and returns the ids to flush', () => {
    const rows: DigestRow[] = [
      { id: '1', event: 'cancellation', payload: { summary: 'Dana cancelled her 3pm.' } },
    ]
    const { section, ids } = buildDigestSection(rows, 'en')
    expect(section).toContain('Dana cancelled her 3pm.')
    expect(ids).toEqual(['1'])
  })

  it('returns empty section for no rows', () => {
    expect(buildDigestSection([], 'en')).toEqual({ section: '', ids: [] })
  })

  it('renders the Hebrew header when lang is he', () => {
    const rows: DigestRow[] = [
      { id: 'a', event: 'reschedule', payload: { summary: 'דנה העבירה את התור.' } },
    ]
    const { section, ids } = buildDigestSection(rows, 'he')
    expect(section).toContain('שינויים מאז העדכון האחרון')
    expect(ids).toEqual(['a'])
  })
})
