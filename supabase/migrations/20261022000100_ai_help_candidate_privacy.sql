-- Candidate identifiers must not be derived from private user questions.
drop index if exists public.ai_knowledge_candidates_pending_fingerprint_idx;
alter table public.ai_knowledge_candidates rename column question_fingerprint to candidate_fingerprint;
create unique index ai_knowledge_candidates_pending_fingerprint_idx
  on public.ai_knowledge_candidates (candidate_fingerprint, knowledge_version)
  where status = 'pending';
