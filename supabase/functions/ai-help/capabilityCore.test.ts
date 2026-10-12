import { describe, expect, it } from 'vitest'
import { capabilities, capabilityRoutes, capabilityVersion } from './_generated/capabilityBundle'
import { knowledgeVersion } from './_generated/knowledgeBundle'
import { sourceIndexVersion } from './_generated/sourceIndex'
import { sourceVersion } from './_generated/sourceBundle'
import { capabilityVersion as frontendCapabilityVersion } from '../../../src/features/ai-help/capabilityVersion'
import { canReturnHighRiskAnswer, capabilityEvidence, claimEvidenceOverlap, hasUnqualifiedHumanRpcAuthorizationClaim, renderPartiallySupportedClaims, retrieveCapabilities, shouldEnforceCoveredClaims, unverifiedResponse, unsupportedTechnicalIdentifiers, validateStructuredClaims, versionMatchedAvailability, type CapabilityIndex } from './capabilityCore'

const index: CapabilityIndex = { version: 'test-v1', routes: capabilityRoutes, capabilities: capabilities as unknown as CapabilityIndex['capabilities'] }
const source = 'src/features/trackers/TrackerBinPage.tsx'
const sourceText = 'The Bin shows a Restore control. Permanent deletion is locked until hosted database migration and scheduled cleanup have been verified.'

describe('AI Help capability index and factual claim validation', () => {
  it('contains router-derived routes and version-matched capability evidence', () => {
    expect(index.routes.history).toBe('/history')
    expect(index.routes['trackers.new']).toBe('/trackers/new')
    expect(new Set([capabilityVersion, knowledgeVersion, sourceIndexVersion, sourceVersion]).size).toBe(1)
    expect(frontendCapabilityVersion).toBe(capabilityVersion)
    expect(capabilities.every((item) => item.evidenceRefs.length > 0)).toBe(true)
    expect(capabilities.find((item) => item.id === 'bin.permanent_delete')?.availability).toBe('unknown')
    expect(capabilities.map((item) => item.featureId)).toEqual(expect.arrayContaining(['trackers.bin','trackers','goals','today','history','analytics','settings','account']))
  })

  it('retrieves matching feature records using the latest question and follow-up context', () => {
    const result = retrieveCapabilities('Why is permanent deletion locked?', [], index)
    expect(result.some((item) => item.id === 'bin.permanent_delete')).toBe(true)
    expect(capabilityEvidence(result)).toContain('availability=unknown')
    expect(retrieveCapabilities('How do I review saved entries?', [{ role: 'user', content: 'I am checking History' }], index).some((item) => item.id === 'route.history')).toBe(true)
  })

  it('rejects fabricated routes, unrelated citations, missing workflow prerequisites, and unknown availability', () => {
    const base = { index, allowedEvidence: new Set([source]), evidenceByRef: { [source]: sourceText }, enforcement: true }
    const invalid = validateStructuredClaims({ ...base, claims: [
      { text: 'Go to Settings → Secret Admin at /secret-admin.', kind: 'route', evidenceRefs: [source], capabilityIds: ['route.settings'] },
      { text: 'Click Permanently delete.', kind: 'control', evidenceRefs: [source], capabilityIds: ['bin.restore'] },
      { text: 'Permanently delete the account now.', kind: 'workflow', evidenceRefs: [source], capabilityIds: ['account.delete'], prerequisites: [] },
      { text: 'Permanent deletion is enabled.', kind: 'availability', evidenceRefs: [source], capabilityIds: ['bin.permanent_delete'] },
    ] })
    expect(invalid.valid).toBe(false)
    expect(invalid.issues).toEqual(expect.arrayContaining(['invented_route_path','capability_label_mismatch','workflow_prerequisite_missing','availability_unknown']))
  })

  it('accepts a router-defined parameterized edit route but rejects an invented path', () => {
    const edited = validateStructuredClaims({
      claims: [{ text: 'Edit the tracker at /trackers/abc123/edit.', kind: 'route', evidenceRefs: ['src/routes/router.tsx'], capabilityIds: ['route.trackers.:trackerId.edit'] }],
      index, allowedEvidence: new Set(['src/routes/router.tsx']), evidenceByRef: { 'src/routes/router.tsx': "{ path: 'trackers/:trackerId/edit' }" }, enforcement: true,
    })
    expect(edited.valid).toBe(true)
    expect(edited.issues).not.toContain('invented_route_path')
  })

  it('requires current source evidence and rendered controls across tracker creation, goals, check-ins, History, notifications, and account actions', () => {
    const supported = validateStructuredClaims({
      claims: [{ text: 'Create a tracker from this form.', kind: 'workflow', evidenceRefs: ['src/features/trackers/TrackerSetupPage.tsx'], capabilityIds: ['trackers.create'] }],
      index, allowedEvidence: new Set(['src/features/trackers/TrackerSetupPage.tsx']),
      evidenceByRef: { 'src/features/trackers/TrackerSetupPage.tsx': 'Create a tracker from the tracker setup form.' },
      runtimeAvailability: { 'trackers.create': 'available' }, enforcement: true,
    })
    expect(supported.valid).toBe(true)

    const staleDocOnly = validateStructuredClaims({
      claims: [{ text: 'Create a tracker from this form.', kind: 'workflow', evidenceRefs: ['docs/ai-help/core-application.md'], capabilityIds: ['trackers.create'] }],
      index, allowedEvidence: new Set(['docs/ai-help/core-application.md']), evidenceByRef: { 'docs/ai-help/core-application.md': 'Create a tracker from the tracker setup form.' },
      runtimeAvailability: { 'trackers.create': 'available' }, enforcement: true,
    })
    expect(staleDocOnly.issues).toContain('missing_capability_source')

    const disabledNotification = validateStructuredClaims({
      claims: [{ text: 'Notification preferences are available.', kind: 'control', evidenceRefs: ['src/features/notifications/NotificationsSettings.tsx'], capabilityIds: ['notifications.preferences'] }],
      index, allowedEvidence: new Set(['src/features/notifications/NotificationsSettings.tsx']), evidenceByRef: { 'src/features/notifications/NotificationsSettings.tsx': 'Notification preferences settings are rendered.' },
      runtimeAvailability: { 'notifications.preferences': 'disabled' }, enforcement: true,
    })
    expect(disabledNotification.issues).toContain('control_disabled')

    const account = validateStructuredClaims({
      claims: [{ text: 'Delete account after recent authentication and current password.', kind: 'workflow', evidenceRefs: ['src/features/settings/AccountDeletion.tsx'], capabilityIds: ['account.delete'], prerequisites: ['recent authentication','current password'] }],
      index, allowedEvidence: new Set(['src/features/settings/AccountDeletion.tsx']), evidenceByRef: { 'src/features/settings/AccountDeletion.tsx': 'Delete account requires recent authentication and current password before confirmation.' }, enforcement: true,
    })
    expect(account.issues).toContain('workflow_availability_unknown')
  })

  it('uses current UI state to distinguish an enabled control from a hidden or disabled one', () => {
    const text = 'The Permanently delete control is rendered in The Bin. Hosted cleanup setup and the production feature flag must be verified.'
    const claim = { text: 'Permanently delete is available.', kind: 'availability' as const, evidenceRefs: [source], capabilityIds: ['bin.permanent_delete'], prerequisites: ['hosted cleanup setup verified', 'production feature flag enabled'] }
    const base = { claims: [claim], index, allowedEvidence: new Set([source]), evidenceByRef: { [source]: text }, enforcement: true }
    expect(validateStructuredClaims(base).issues).toContain('availability_unknown')
    expect(validateStructuredClaims({ ...base, runtimeAvailability: { 'bin.permanent_delete': 'disabled' } }).issues).toContain('availability_conflict')
    expect(validateStructuredClaims({ ...base, runtimeAvailability: { 'bin.permanent_delete': 'available' } }).issues).not.toContain('availability_unknown')
    const disabledClaim = { ...claim, text: 'Permanently delete is disabled.' }
    expect(validateStructuredClaims({ ...base, claims: [disabledClaim], evidenceByRef: { [source]: 'Permanently delete is disabled until hosted cleanup setup is verified and the production feature flag is enabled.' }, runtimeAvailability: { 'bin.permanent_delete': 'disabled' } }).valid).toBe(true)
  })

  it('uses runtime observations only when frontend and Edge capability versions match', () => {
    const observed = { 'account.delete': 'available' as const }
    expect(versionMatchedAvailability(capabilityVersion, capabilityVersion, observed)).toEqual(observed)
    expect(versionMatchedAvailability(undefined, capabilityVersion, observed)).toEqual({})
    expect(versionMatchedAvailability('older-version', capabilityVersion, observed)).toEqual({})
  })

  it('enforces structured claims only when feature and current source evidence are both covered', () => {
    expect(shouldEnforceCoveredClaims(true, true, false)).toBe(true)
    expect(shouldEnforceCoveredClaims(true, false, false)).toBe(false)
    expect(shouldEnforceCoveredClaims(false, true, false)).toBe(false)
    expect(shouldEnforceCoveredClaims(false, false, true)).toBe(true)
  })

  it('returns only accepted claim text for partial evidence and offers escalation when none is supported', () => {
    const accepted = { text: 'History is available from the app navigation.', kind: 'route' as const, evidenceRefs: [source], capabilityIds: ['history.review'] }
    const partial = renderPartiallySupportedClaims([accepted], 'Where is History and can I delete entries there?')
    expect(partial).toContain(accepted.text)
    expect(partial).toContain('can’t confirm the rest')
    expect(partial).not.toContain('delete entries')
    expect(renderPartiallySupportedClaims([], 'How do I delete my account?')).toContain('Settings → Account Actions')
  })

  it('gives account deletion users the verified Settings location when availability is unknown or conflicts', () => {
    const fallback = unverifiedResponse('How do I delete my account?')
    expect(fallback).toContain('Settings → Account Actions')
    expect(fallback).toContain('can’t confirm whether account deletion is currently available')
    expect(fallback).not.toContain('control is enabled')
    const accountClaim = { text: 'Delete account after recent authentication and current password.', kind: 'workflow' as const, evidenceRefs: ['src/features/settings/AccountDeletion.tsx'], capabilityIds: ['account.delete'], prerequisites: ['recent authentication', 'current password'] }
    const base = { claims: [accountClaim], index, allowedEvidence: new Set(['src/features/settings/AccountDeletion.tsx']), evidenceByRef: { 'src/features/settings/AccountDeletion.tsx': 'Delete account requires recent authentication and current password before confirmation.' }, enforcement: false }
    const missing = validateStructuredClaims(base)
    const conflict = validateStructuredClaims({ ...base, runtimeAvailability: { 'account.delete': 'disabled' } })
    expect(canReturnHighRiskAnswer('Delete your account.', 1, missing, 1)).toBe(false)
    expect(canReturnHighRiskAnswer('Delete your account.', 1, conflict, 1)).toBe(false)
    expect(unverifiedResponse('Delete my account.')).toContain('Settings → Account Actions')
  })

  it('rejects misleading citations and unsupported numeric constraints', () => {
    const wrong = validateStructuredClaims({
      claims: [{ text: 'Analytics combines all measure totals into one score of 90 days.', kind: 'numeric', evidenceRefs: [source], capabilityIds: ['history.review'] }],
      index, allowedEvidence: new Set([source]), evidenceByRef: { [source]: sourceText }, enforcement: true,
    })
    expect(claimEvidenceOverlap('Analytics combines totals into one score', sourceText)).toBeLessThan(0.2)
    expect(wrong.valid).toBe(false)
    expect(wrong.issues).toEqual(expect.arrayContaining(['unsupported_numeric_value','weak_lexical_overlap']))
  })

  it('rejects technical identifiers that do not occur in the evidence cited by that claim', () => {
    const claims = [{ text: 'Ratings are stored in `public.ai_help_feedback`.', kind: 'fact' as const, evidenceRefs: ['migration.sql'], capabilityIds: [] }]
    const evidence = { 'migration.sql': 'Ratings are stored in public.ai_help_answer_feedback.' }
    expect(unsupportedTechnicalIdentifiers(claims, evidence)).toEqual(['public.ai_help_feedback'])
    const result = validateStructuredClaims({ claims, index, allowedEvidence: new Set(['migration.sql']), evidenceByRef: evidence, enforcement: false })
    expect(result.issues).toContain('unsupported_technical_identifier')
    expect(unsupportedTechnicalIdentifiers([{ ...claims[0]!, text: 'Ratings use `public.ai_help_answer_feedback`.' }], evidence)).toEqual([])
    expect(unsupportedTechnicalIdentifiers([{ ...claims[0]!, text: 'Support email requests use `public.support_feedback`.' }], { 'migration.sql': 'Provider sends reserve public.support_feedback_send_attempts before calling the mail service.' })).toEqual(['public.support_feedback'])
  })

  it('requires RPC authorization claims to identify the database or Edge layer', () => {
    expect(hasUnqualifiedHumanRpcAuthorizationClaim({ text: 'Only a maintainer may invoke the `support_maintainer_reply` function.', kind: 'fact', evidenceRefs: ['migration.sql'], capabilityIds: [] })).toBe(true)
    expect(hasUnqualifiedHumanRpcAuthorizationClaim({ text: 'The Edge Function authorizes a maintainer before calling the RPC with the service_role database role.', kind: 'fact', evidenceRefs: ['index.ts'], capabilityIds: [] })).toBe(false)
    const result = validateStructuredClaims({
      claims: [{ text: 'Only a maintainer may invoke the `support_maintainer_reply` function.', kind: 'fact', evidenceRefs: ['migration.sql'], capabilityIds: [] }],
      index, allowedEvidence: new Set(['migration.sql']), evidenceByRef: { 'migration.sql': 'create function support_maintainer_reply as security definer.' }, enforcement: false,
    })
    expect(result.issues).toContain('authorization_layer_ambiguous')
  })

  it('lets shadow mode measure without blocking low-risk answers and fails closed for unknown high-risk actions', () => {
    const lowRisk = validateStructuredClaims({ claims: [], index, allowedEvidence: new Set(), evidenceByRef: {}, enforcement: false })
    expect(lowRisk.valid).toBe(true)
    const highRisk = validateStructuredClaims({
      claims: [{ text: 'Permanently delete this tracker.', kind: 'control', evidenceRefs: [source], capabilityIds: ['bin.permanent_delete'] }],
      index, allowedEvidence: new Set([source]), evidenceByRef: { [source]: sourceText }, enforcement: false,
    })
    expect(highRisk.valid).toBe(true) // shadow result; caller applies high-risk fail-closed policy from issues
    expect(highRisk.issues).toEqual(expect.arrayContaining(['high_risk_not_verified','high_risk_prerequisite_missing']))
    expect(canReturnHighRiskAnswer('Permanently delete the account.', 1, highRisk, 0.9)).toBe(false)
    expect(canReturnHighRiskAnswer('History shows previous check-ins.', 0, lowRisk, 0)).toBe(true)
    expect(unverifiedResponse()).toContain('raise a support query')
  })
})
