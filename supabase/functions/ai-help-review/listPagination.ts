export type ReviewListPaginationInput = {
  status: string
  limit: number
  offset: number
  candidateOffset?: unknown
  verifiedOffset?: unknown
}

/** Resolve the independent source cursors used by the combined knowledge list. */
export function resolveReviewListPagination(input: ReviewListPaginationInput) {
  const combinedStatus = input.status === 'stale' || input.status === 'all'
  const cursorProvided = typeof input.candidateOffset === 'number' || typeof input.verifiedOffset === 'number'
  const legacyCombinedPage = combinedStatus && !cursorProvided
  const candidateOffset = typeof input.candidateOffset === 'number'
    ? Math.max(0, Math.min(10000, Math.floor(input.candidateOffset)))
    : combinedStatus ? Math.floor(input.offset / 2) : input.offset
  const verifiedOffset = typeof input.verifiedOffset === 'number'
    ? Math.max(0, Math.min(10000, Math.floor(input.verifiedOffset)))
    : combinedStatus ? Math.floor(input.offset / 2) : input.offset
  const legacyTableLimit = Math.ceil(input.limit / 2)
  const fetchLimit = legacyCombinedPage ? legacyTableLimit : Math.min(101, input.limit + 1)

  return {
    legacyCombinedPage,
    candidateOffset,
    verifiedOffset,
    legacyTableLimit,
    fetchLimit,
    candidateQueryOffset: legacyCombinedPage ? Math.floor(input.offset / 2) : candidateOffset,
    verifiedQueryOffset: legacyCombinedPage ? Math.floor(input.offset / 2) : verifiedOffset,
  }
}
