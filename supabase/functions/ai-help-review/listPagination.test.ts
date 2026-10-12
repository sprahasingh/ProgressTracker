import { describe, expect, it } from 'vitest'
import { resolveReviewListPagination } from './listPagination'

describe('resolveReviewListPagination', () => {
  it('builds the independent cursors for a normal candidate list', () => {
    expect(resolveReviewListPagination({ status: 'pending', limit: 50, offset: 12 })).toEqual({
      legacyCombinedPage: false,
      candidateOffset: 12,
      verifiedOffset: 12,
      legacyTableLimit: 25,
      fetchLimit: 51,
      candidateQueryOffset: 12,
      verifiedQueryOffset: 12,
    })
  })

  it('preserves legacy combined pagination for all statuses', () => {
    expect(resolveReviewListPagination({ status: 'all', limit: 51, offset: 20 })).toEqual({
      legacyCombinedPage: true,
      candidateOffset: 10,
      verifiedOffset: 10,
      legacyTableLimit: 26,
      fetchLimit: 26,
      candidateQueryOffset: 10,
      verifiedQueryOffset: 10,
    })
  })

  it('uses supplied cursors and clamps malformed numeric values', () => {
    expect(resolveReviewListPagination({ status: 'stale', limit: 10, offset: 8, candidateOffset: -4.5, verifiedOffset: 20000 })).toMatchObject({
      legacyCombinedPage: false,
      candidateOffset: 0,
      verifiedOffset: 10000,
      candidateQueryOffset: 0,
      verifiedQueryOffset: 10000,
    })
  })
})
