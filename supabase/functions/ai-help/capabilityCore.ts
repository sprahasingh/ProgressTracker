import { tokenize, type AssistantHistoryItem } from './validation.ts'

export type Availability = 'available' | 'disabled' | 'conditional' | 'unknown'
export type Capability = {
  id: string
  featureId: string
  kind: 'route' | 'control' | 'workflow' | 'limitation'
  label: string
  routeId?: string
  risk: 'low' | 'medium' | 'high'
  availability: Availability
  availabilityConditions?: string[]
  prerequisites: string[]
  limitations?: string[]
  evidenceRefs: string[]
}
export type CapabilityIndex = { version: string; routes: Record<string, string>; capabilities: Capability[] }
export type StructuredClaim = {
  text: string
  kind: 'fact' | 'route' | 'control' | 'availability' | 'numeric' | 'workflow'
  evidenceRefs: string[]
  capabilityIds: string[]
  prerequisites?: string[]
}
export type ClaimValidation = { valid: boolean; highRisk: boolean; issues: string[]; acceptedClaims: StructuredClaim[] }

export function versionMatchedAvailability(clientVersion: string | undefined, activeVersion: string, observations: Record<string, Availability>): Record<string, Availability> {
  if (!clientVersion || clientVersion !== activeVersion) return {}
  return observations
}

/** Roll out strict claim checks only for a feature with both a matching capability and current source excerpts. */
export function shouldEnforceCoveredClaims(capabilityMatched: boolean, currentSourceAvailable: boolean, globalEnforcement: boolean): boolean {
  return globalEnforcement || (capabilityMatched && currentSourceAvailable)
}

const stop = new Set(['about','after','also','are','can','does','for','from','how','into','is','it','may','not','the','this','that','with','you','your'])
const writtenNumbers: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', thirty: '30' }
const terms = (value: string) => new Set(tokenize(value).filter((word) => !stop.has(word)))
const numberValues = (value: string) => new Set([
  ...(value.match(/\b\d+(?:\.\d+)?\b/g) ?? []),
  ...Object.entries(writtenNumbers).flatMap(([word, number]) => new RegExp(`\\b${word}\\b`, 'i').test(value) ? [number] : []),
])
function routeIsDeclared(path: string, routes: Record<string, string>): boolean {
  return Object.values(routes).some((route) => {
    const pattern = route.split('/').map((part) => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')
    return new RegExp(`^${pattern}/?$`).test(path)
  })
}

/** Fast lexical overlap is a warning signal, not semantic entailment. */
export function claimEvidenceOverlap(claim: string, evidence: string): number {
  const claimTerms = terms(claim)
  if (!claimTerms.size) return 0
  const evidenceTerms = terms(evidence)
  return [...claimTerms].filter((term) => evidenceTerms.has(term)).length / claimTerms.size
}

export function retrieveCapabilities(question: string, history: AssistantHistoryItem[], index: CapabilityIndex, limit = 8): Capability[] {
  const context = history.filter((item) => item.role === 'user').slice(-2).map((item) => item.content).join(' ')
  const queryTerms = terms(`${question} ${context}`)
  return index.capabilities.map((capability, order) => {
    const score = [...terms(`${capability.id} ${capability.featureId} ${capability.label} ${capability.prerequisites.join(' ')}`)]
      .filter((term) => queryTerms.has(term)).length
    return { capability, score, order }
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(1, Math.min(limit, 12))).map(({ capability }) => capability)
}

export function capabilityEvidence(capabilities: Capability[]): string {
  return capabilities.map((item) => `CAPABILITY ${item.id} · ${item.kind} · ${item.label} · availability=${item.availability} · conditions=${item.availabilityConditions?.join(',') || 'unknown'} · risk=${item.risk} · prerequisites=${item.prerequisites.join(',') || 'none'} · limitations=${item.limitations?.join(',') || 'none'} · evidence=${item.evidenceRefs.join(',')}`).join('\n')
}

/** Structural checks are deterministic. Text/evidence overlap cannot prove semantic support. */
export function validateStructuredClaims(input: {
  claims: StructuredClaim[]
  index: CapabilityIndex
  allowedEvidence: Set<string>
  evidenceByRef: Record<string, string>
  runtimeAvailability?: Record<string, Availability>
  enforcement: boolean
}): ClaimValidation {
  const ids = new Map(input.index.capabilities.map((item) => [item.id, item]))
  const issues: string[] = []
  const acceptedClaims: StructuredClaim[] = []
  let highRisk = false
  for (const claim of input.claims) {
    const refsValid = claim.evidenceRefs.length > 0 && claim.evidenceRefs.every((ref) => input.allowedEvidence.has(ref))
    const capabilities = claim.capabilityIds.map((id) => ids.get(id))
    const capabilityIdsValid = claim.capabilityIds.every((id) => ids.has(id))
    const risk = capabilities.some((capability) => capability?.risk === 'high')
    highRisk ||= risk
    let valid = Boolean(claim.text.trim() && refsValid && capabilityIdsValid)
    if (!refsValid) issues.push('missing_or_unretrieved_evidence')
    if (!capabilityIdsValid) issues.push('unknown_capability')
    for (const capability of capabilities) {
      if (!capability) continue
      const availability = input.runtimeAvailability?.[capability.id] ?? capability.availability
      const capabilityMatch = claimEvidenceOverlap(claim.text, capability.label)
      if ((claim.kind === 'control' || claim.kind === 'workflow' || claim.kind === 'route') && capabilityMatch < 0.25) {
        valid = false; issues.push('capability_label_mismatch')
      }
      if (!claim.evidenceRefs.some((ref) => capability.evidenceRefs.includes(ref))) {
        valid = false; issues.push('missing_capability_source')
      }
      if (claim.kind === 'route' && (!capability.routeId || input.index.routes[capability.routeId] === undefined)) {
        valid = false; issues.push('unknown_route')
      }
      if (claim.kind === 'route') {
        const mentionedRoutes = claim.text.match(/\/(?:[a-z0-9:_-]+(?:\/[a-z0-9:_-]+)*)/gi) ?? []
        if (mentionedRoutes.some((path) => !routeIsDeclared(path, input.index.routes))) {
          valid = false; issues.push('invented_route_path')
        }
      }
      if (claim.kind === 'control' && capability.kind !== 'control') {
        valid = false; issues.push('not_a_control')
      }
      if (claim.kind === 'control' && availability !== 'available') {
        valid = false; issues.push(availability === 'disabled' ? 'control_disabled' : 'control_availability_unknown')
      }
      if (claim.kind === 'availability' && availability !== 'available' && availability !== 'disabled') {
        valid = false; issues.push('availability_unknown')
      }
      if (claim.kind === 'availability' && ((availability === 'disabled' && /\b(?:available|enabled|can use|turned on)\b/i.test(claim.text))
        || (availability === 'available' && /\b(?:disabled|unavailable|locked|cannot use|not available)\b/i.test(claim.text)))) {
        valid = false; issues.push('availability_conflict')
      }
      if (claim.kind === 'workflow' && (capability.kind !== 'workflow' || capability.prerequisites.some((item) => !(claim.prerequisites ?? []).includes(item)))) {
        valid = false; issues.push('workflow_prerequisite_missing')
      }
      if (claim.kind === 'workflow' && availability !== 'available') {
        valid = false; issues.push(availability === 'disabled' ? 'workflow_disabled' : 'workflow_availability_unknown')
      }
      if (capability.risk === 'high' && capability.prerequisites.some((item) => !(claim.prerequisites ?? []).includes(item))) {
        valid = false; issues.push('high_risk_prerequisite_missing')
      }
    }
    if (claim.kind === 'numeric') {
      const numbers = numberValues(claim.text)
      const citedText = claim.evidenceRefs.map((ref) => input.evidenceByRef[ref] ?? '').join(' ')
      const evidenceNumbers = numberValues(citedText)
      if ([...numbers].some((number) => !evidenceNumbers.has(number))) { valid = false; issues.push('unsupported_numeric_value') }
      const currentCapabilityEvidence = capabilities.flatMap((capability) => capability?.evidenceRefs ?? []).filter((ref) => claim.evidenceRefs.includes(ref)).map((ref) => input.evidenceByRef[ref] ?? '').join(' ')
      const currentNumbers = numberValues(currentCapabilityEvidence)
      if (currentCapabilityEvidence && [...numbers].some((number) => !currentNumbers.has(number))) { valid = false; issues.push('unsupported_current_numeric_value') }
    }
    const overlap = Math.max(0, ...claim.evidenceRefs.map((ref) => claimEvidenceOverlap(claim.text, input.evidenceByRef[ref] ?? '')))
    if (overlap < 0.2) { valid = false; issues.push('weak_lexical_overlap') }
    const confirmedUnavailable = claim.kind === 'availability'
      && /\b(?:disabled|unavailable|locked|not available)\b/i.test(claim.text)
      && capabilities.every((item) => item && (input.runtimeAvailability?.[item.id] ?? item.availability) === 'disabled')
    if (risk && (!refsValid || !capabilityIdsValid || overlap < 0.2 || capabilities.some((item) => item && (input.runtimeAvailability?.[item.id] ?? item.availability) !== 'available') && !confirmedUnavailable)) {
      valid = false; issues.push('high_risk_not_verified')
    }
    if (valid) acceptedClaims.push(claim)
  }
  const allClaimsValid = input.claims.length > 0 && acceptedClaims.length === input.claims.length
  return { valid: input.enforcement ? allClaimsValid : true, highRisk, issues: [...new Set(issues)], acceptedClaims }
}

export function unverifiedResponse(question = ''): string {
  if (/\b(?:account|profile)\b/i.test(question) && /\b(?:delete|deletion|remove|permanently)\b/i.test(question)) {
    return 'I can’t confirm whether account deletion is currently available or verify the prerequisites for your session. Open Settings → Account Actions to review the current controls and instructions; the page will show whether you can continue.'
  }
  return 'I can’t confirm that from the current ProgressTracker information. Would you like to raise a support query?'
}

export function renderPartiallySupportedClaims(claims: StructuredClaim[], question: string): string {
  const supported = [...new Set(claims.map((claim) => claim.text.trim()).filter(Boolean))]
  if (!supported.length) return unverifiedResponse(question)
  return `${supported.join(' ')}\n\nI can’t confirm the rest from current evidence. Would you like to raise a support query?`
}

export function canReturnHighRiskAnswer(answer: string, claimCount: number, validation: ClaimValidation, answerClaimCoverage: number): boolean {
  const highRisk = /\b(?:delete your account|account deletion|permanently delete|permanent deletion|erase your account|remove your account)\b/i.test(answer)
  if (!highRisk) return true
  return claimCount > 0 && validation.highRisk && validation.valid && validation.issues.length === 0 && answerClaimCoverage >= 0.65
}
