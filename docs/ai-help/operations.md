# AI Help Assistant operations

## What is sent to the assistant

The browser sends the typed question, up to six bounded messages from the current session, and a fixed page feature identifier. It never reads or sends tracker definitions, check-ins, goal values, or workspace settings. The Edge Function retrieves only the checked-in documentation and the source files named by `scripts/build-ai-help-bundle.mjs`. The generated bundle is versioned from the app version and contents of those files.

The model is instructed to treat the question, prior conversation, documentation, and code excerpts as untrusted reference text. The endpoint cannot execute code, call tools, change tracker data, or write to the repository.

## Local and hosted setup

1. Configure the existing Supabase browser URL and publishable key in the app as usual. The help endpoint requires a signed-in user for AI answers. Common answers are available locally when signed out or offline.
2. Add the `GROQ_API_KEY_PRIMARY` Supabase Function secret. A separately provisioned `GROQ_API_KEY_SECONDARY` is optional. The browser bundle must never contain either secret.
3. Optionally set `GROQ_MODEL`; the default is `openai/gpt-oss-120b`. Check current Groq availability and account limits before selecting a model.
4. Set `AI_HELP_ALLOWED_ORIGINS` to a comma-separated list of exact application origins, such as local development and the deployed app origin. The endpoint rejects requests with missing or unlisted origins.
5. Check `supabase migration list` and review all four assistant migrations (`20261019000100` through `20261022000100`). Apply only missing, reviewed migrations through the normal deployment workflow; do not repair migration history manually or apply them automatically to the hosted project.
6. Before deploying a release, run `npm run build:ai-help-bundle`; deploy the Edge Function with the resulting `supabase/functions/ai-help/_generated/` files from the same release.
7. Deploy the `ai-help` Function. Supabase platform credentials (`SUPABASE_URL`, `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`) are used only in the Edge Function environment. Keep the service role key server-side.

The database RPC allows at most 8 requests per user per minute and 24 requests across the project per minute. The project cap stays below Groq’s currently documented 30 requests per minute for GPT-OSS 120B, while the provider remains the final rate-limit authority. The RPC and assistant tables are inaccessible to `anon` and `authenticated`; only the Edge Function's service role can access them. Provider 429 responses do not fall back to the second credential and pause both credentials for the provider's `Retry-After` period. Network failures, 401/403 responses, and 5xx failures may try a healthy secondary credential once. There are no repeated retries. This is redundancy between credentials, not a mechanism to evade account limits.

## Knowledge memory review

When an answer is supported by retrieved source references and the conversation appears general, the Function stores a pending candidate containing the generated answer, exact source references, and a SHA-256 fingerprint derived from those references and the answer. It does not store the question, a question-derived hash, user ID, or a private tracker record. Candidate rows are never automatically promoted.

A reviewer should inspect the referenced files at the exact `knowledge_version`, confirm that the answer matches actual behavior, and update or add the detailed feature documentation when appropriate. Only then may a trusted maintainer insert the verified explanation into `ai_question_memory` with the current generated `knowledge_version` and source references. Rows with older versions are not used. The candidate table is service-role-only; no public review UI is included in this release.

The generated documentation bundle is also upserted into `ai_feature_knowledge` when a request reaches a warm or cold Function instance. Generated sources stay in the deployed Function bundle and are selected server-side on demand.

## Known limits

- AI requests require a signed-in user and connectivity. Offline and signed-out users get a small built-in FAQ only.
- Source retrieval is a deliberately bounded keyword search across a fixed, reviewed file list. It is not arbitrary repository search and does not include tests unless they are explicitly added to the source allowlist.
- No browser-based mobile keyboard or visual theme verification is available in the current test environment; component and CSS checks do not replace real-device review.
- The chat is session-scoped in `sessionStorage`; it is not synchronized across devices and the browser session can contain text the user entered.
- Groq model access, account quotas, and credential setup are operational requirements outside this repository.
