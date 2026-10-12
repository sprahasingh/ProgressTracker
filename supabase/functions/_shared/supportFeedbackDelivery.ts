import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { deliverFeedbackEmail, type FeedbackIdentity, type DeliveryConfig } from '../send-feedback/feedbackCore.ts'

type OutboxRow = { id: string; feedback_id: string; message_id: string | null; status: string }

/** Sends one durable outbox item. A timed-out/uncertain item is never retried. */
export async function deliverPendingSupportEmail(
  admin: SupabaseClient,
  feedbackId: string,
  identity: FeedbackIdentity,
  config: DeliveryConfig,
): Promise<'accepted' | 'pending' | 'failed' | 'uncertain' | 'not_required'> {
  const { data: record, error: recordError } = await admin.from('support_feedback')
    .select('id,category,source,subject,original_message,created_at,email_status')
    .eq('id', feedbackId).maybeSingle()
  if (recordError || !record) throw new Error('feedback_record_unavailable')
  if (record.email_status === 'not_required') return 'not_required'
  const { data: jobs, error: jobError } = await admin.from('support_feedback_email_outbox')
    .select('id,feedback_id,message_id,status').eq('feedback_id', feedbackId)
    .in('status', ['pending', 'failed']).order('created_at', { ascending: true }).limit(1)
  if (jobError) throw new Error('feedback_delivery_unavailable')
  const job = jobs?.[0] as OutboxRow | undefined
  if (!job) return record.email_status as 'accepted' | 'pending' | 'failed' | 'uncertain'
  const { data: claimed, error: claimError } = await admin.from('support_feedback_email_outbox')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', job.id).in('status', ['pending', 'failed']).select('id').maybeSingle()
  if (claimError) throw new Error('feedback_delivery_unavailable')
  if (!claimed) {
    const { data: current } = await admin.from('support_feedback_email_outbox').select('status').eq('id', job.id).maybeSingle()
    return current?.status === 'accepted' ? 'accepted' : current?.status === 'uncertain' ? 'uncertain' : current?.status === 'failed' ? 'failed' : 'pending'
  }
  let message = record.original_message as string
  if (job.message_id) {
    const { data: reply, error } = await admin.from('support_feedback_messages').select('body').eq('id', job.message_id).maybeSingle()
    if (error || !reply) throw new Error('feedback_message_unavailable')
    message = reply.body as string
  }
  const category = record.category === 'bug_report' ? 'bug_report'
    : record.category === 'feature_request' ? 'feature_request'
      : record.category === 'general_feedback' ? 'general_feedback' : 'help_support'
  const result = await deliverFeedbackEmail({
    category,
    message,
    requestId: job.id,
    feedbackId: record.id,
    subject: record.subject,
    source: record.source,
    submittedAt: record.created_at,
  }, identity, config)
  const outcome = result.outcome === 'rejected' ? 'failed' : result.outcome
  const { error: outcomeError } = await admin.rpc('set_support_email_outcome', {
    p_outbox_id: job.id,
    p_status: outcome,
    p_provider_message_id: null,
    p_error_code: result.accepted ? null : `brevo_${result.status}`,
  })
  if (outcomeError) throw new Error('feedback_delivery_status_unavailable')
  return outcome
}
