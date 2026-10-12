# AI Help Assistant operations

This guide covers the AI Help knowledge build, local verification, and release requirements. The runtime uses one Groq request per question, a fixed Supabase Edge Function, versioned documentation, and an allowlisted source index. It does not have general filesystem or repository access.

## Knowledge and source build

The authoritative inputs are the five feature guides in `docs/ai-help/` and the reviewed source paths in `scripts/build-ai-help-bundle.mjs`. The builder:

1. Splits product guides into heading-level sections so runtime retrieval can send only relevant passages.
2. Reads approved implementation and behavioral test files into build-time 14-line, overlapping excerpts. Each excerpt stores its source path, nearest function or test label, line range, searchable terms, and whether it is implementation or test evidence.
3. Generates `knowledgeBundle.ts`, `sourceBundle.ts`, and `sourceIndex.ts` under `supabase/functions/ai-help/_generated/`.
4. Computes a shared version from the app version and the contents of all included guides and source files.
5. Emits SHA-256 fingerprints for each guide and indexed source file. These per-file fingerprints let the server identify which reviewed topics changed without invalidating knowledge that cites unrelated files.

Run the generator after editing any included guide or source file:

```sh
npm run build:ai-help-bundle
```

Do not manually edit generated files. Check that all three generated versions match and that the source paths in `sourceBundle.ts` correspond to indexed entries. The build reads only its explicit allowlist; the Edge Function cannot inspect the developer filesystem. Source import declaration lines are omitted from generated evidence, while the surrounding implementation and test excerpts remain indexed. This also prevents the local Edge bundler from interpreting browser-only imports found inside generated evidence as Edge modules.

### Bundle versions are not approval records

The displayed AI Help version is a content fingerprint over the app version, product guides, verified question catalog, included implementation and test sources, capabilities, routes, source relationships, and source-index format. Any included content change can produce a new version, including documentation or implementation edits that have nothing to do with a feedback report. A changed version does not mean a Knowledge Candidate was approved or that a reported issue was fixed.

AI-generated Knowledge Candidates are stored as `pending`. Only an authorized maintainer action through `ai-help-review` can call `review_ai_knowledge_candidate` with the `approve` action and move that content into `ai_verified_knowledge`. Reconciliation can update bundle versions and mark evidence stale; it does not approve candidates. AI Help retrieves database topics only when their status is `verified`, and separately uses the maintained source bundle and reviewed documentation as evidence.

## Runtime evidence selection

The request handler selects up to four relevant documentation sections. It automatically selects a bounded set of source-index excerpts when the docs have weak query coverage or the question asks for implementation-sensitive behavior, such as why a restriction exists, what happens after an edit, or how a conflict is handled. Source matches are ranked by query terms, term rarity, feature context, and implementation/test type. At most four snippets and 5,200 characters are sent to Groq. The prompt prefers implementation behavior over conflicting prose, while the final answer remains user-facing and does not expose code or paths.

The endpoint allows citations only from the documentation sections, current verified topics, and source paths actually supplied for that request. If no supplied evidence supports the answer, the assistant must acknowledge uncertainty. A knowledge-version mismatch blocks generation rather than serving mismatched bundles. Verified topics are ranked as evidence and never returned as canned answers; current implementation evidence takes priority. Legacy exact-question memory is not used or written by the current runtime.

## Candidate discovery and privacy

During the same Groq response used to answer the question, the model may return one optional, standalone topic candidate. This makes no additional provider request. Candidate collection is considered only when current source-code excerpts were supplied, the answer passed grounding validation, the user interaction appears general rather than personal, and the candidate names one to four source files that were actually supplied and cited.

The server then checks the candidate's dotted topic identifier, category, length, source allowlist, source fingerprints, basic personal-data patterns, and lexical overlap with the supplied source excerpts. These checks are deterministic screening, not proof that the explanation is semantically correct. Every accepted candidate remains pending until an authorized maintainer reviews it. The system never fine-tunes a model and never promotes a model-written candidate automatically.

Candidate rows contain a stable topic, title, standalone explanation, optional detail, feature category, source references and fingerprints, and the bundle version. They do not contain the user's question, conversation, question hash, tracker values, or account data. A content fingerprint is derived only from the candidate topic, normalized explanation, and source paths. Topic and fingerprint uniqueness checks, plus a transaction lock, prevent duplicate queue entries during concurrent requests. Related topics such as type immutability and retirement keep separate identifiers. The queue has a 5,000-row hard capacity; after that, discovery is skipped and aggregated as a metric. Existing unstructured legacy candidates are marked stale and retained for audit, but are not exposed in the review queue.

The old `ai_question_memory` table is retained for compatibility and audit, but the new runtime does not read from it or insert questions into it. Existing rows are not deleted.

## Maintainer review workflow

The review API is the separate `ai-help-review` Edge Function. It checks the access token with Supabase Auth, requires a confirmed email, and compares that email against the server-side `AI_HELP_MAINTAINER_EMAILS` comma-separated allowlist. Authenticated status alone does not grant review access. Candidate and verified-knowledge tables have RLS enabled and no browser-role table access; service-role credentials stay inside the Edge Function. There is no client-side admin switch.

In the signed-in app, an allowlisted maintainer opens **More → AI Knowledge** (also in the mobile More menu), or navigates directly to `#/ai-knowledge`. The page calls the review function's authenticated `whoami` action before revealing navigation or knowledge data. Signed-out users follow the app's sign-in route; other authenticated users see an access-denied state. Every review operation is independently authorized by the Edge Function, so a hidden link is not the security boundary. The page keeps its response data in component memory only.

Configure the allowlist as a Function secret. Use the maintainer's confirmed Supabase Auth email address:

```sh
supabase secrets set AI_HELP_MAINTAINER_EMAILS="maintainer@example.com"
```

The review function also enforces its own browser-origin allowlist. Configure the exact origins that will open the maintainer dashboard; the function reads `AI_HELP_REVIEW_ALLOWED_ORIGINS` first and falls back to `AI_HELP_ALLOWED_ORIGINS` only when the review-specific secret is unset. An explicitly empty review-specific value takes precedence and rejects every browser origin. Origins contain only scheme, host, and port, with no path. For the documented GitHub Pages site and local Vite development server:

```sh
supabase secrets set AI_HELP_REVIEW_ALLOWED_ORIGINS="https://sprahasingh.github.io,http://localhost:5173"
```

Add `http://localhost:4173` only if you use Vite's local preview server. When updating this secret, include every origin that should retain access; setting it replaces the existing list. A rejected browser origin fails CORS before maintainer authentication or database queries run. A 403 preflight response without `Access-Control-Allow-Origin` appears in the browser as a network/fetch failure, so check the exact page origin against this setting.

The review endpoint accepts authenticated JSON POST requests. A CLI workflow can use a maintainer's normal Supabase user access token and the public publishable key; never use a service-role key in a browser or review client. The responses do not include user questions or conversations.

The separate `support-inbox` function uses `SUPPORT_FEEDBACK_ALLOWED_ORIGINS` for its browser CORS allowlist. If that secret is unset, it falls back to `AI_HELP_ALLOWED_ORIGINS`; an explicitly empty value overrides the fallback. To allow the production site and local Vite server, include both origins when setting the secret because setting it replaces the whole list:

```sh
supabase secrets set SUPPORT_FEEDBACK_ALLOWED_ORIGINS="https://sprahasingh.github.io,http://localhost:5173"
```

Add `http://localhost:4173` if you use the Vite preview server. This allowlist is independent of `AI_HELP_REVIEW_ALLOWED_ORIGINS`, which controls the `ai-help-review` function.

```sh
curl "$SUPABASE_URL/functions/v1/ai-help-review" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $MAINTAINER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"action":"list","status":"pending","limit":50}'
```

Supported actions:

- `whoami`: after the existing confirmed-email allowlist check, return only `{ "authorized": true }`; never returns the allowlist.
- `list`: list pending, stale, verified, rejected, or all structured candidates; show related verified topics and aggregated metrics. Supports bounded `limit`, `offset`, `search`, and `sort` values and returns summary counts for pending, approved, stale, and rejected records.
- `get`: retrieve one candidate or verified topic with current indexed excerpts for its source references and up to 30 audit events. Use the returned candidate `updated_at` as the optimistic concurrency token.
- `edit`: submit revised topic fields, explanation, category, and source paths. The server revalidates the text against current indexed excerpts and returns the candidate to pending.
- `approve`: atomically writes the reviewed topic to `ai_verified_knowledge`, marks the candidate verified, and records review history. Supply the latest `expected_updated_at` plus the fields reviewed.
- `reject`: permanently marks that candidate rejected and records the action.
- `defer`: leaves the candidate pending or stale and records that it was deferred.
- `revalidate`: for a stale verified topic, submit updated fields and current source paths to create a new pending candidate. It still requires a separate `approve`.

The app requires an explicit second confirmation click for approval. Approval and editing are checked against current indexed source excerpts and fingerprints by the server; the page never marks an item approved until the operation succeeds. Stale verified topics are excluded from AI Help retrieval. **Queue for re-review** uses `revalidate` to create a pending candidate while preserving its stable topic ID; a maintainer must review and approve it separately. A rejected reason is not currently collected by the existing API, so the dashboard shows the available status and audit event without inventing a reason.

For `edit` and `approve`, include `candidate_id`, `expected_updated_at`, `topic_id`, `title`, `explanation`, optional `detailed_explanation`, `feature_category`, and `source_refs`. The server loads the current excerpts and fingerprints itself; client-supplied evidence is ignored. For `reject` and `defer`, include the candidate ID and expected timestamp. A concurrent edit/review returns HTTP 409, after which reload with `get`. Related verified entries are shown for comparison but are never silently merged or overwritten. Approval of an existing stale topic is an explicit maintainer action and is preserved in review history.

The dashboard searches topic ID, title, and explanation server-side, and pages through the existing tables. Audit entries show the action, old/new status, time, and the reviewer's short auth ID where stored. Audit metadata snapshots and private assistant questions are not sent to the browser.

## Verified retrieval and freshness

After request authentication and rate limiting, the runtime reconciles topic evidence against the generated per-file fingerprint manifest. It marks a verified topic stale only when one of its referenced guide/source fingerprints changed or disappeared. Unaffected entries advance to the new bundle version and remain eligible. Stale topics are excluded from retrieval and shown to maintainers with current excerpts. A maintainer uses `revalidate`, reviews the new candidate, and approves it to restore the topic.

Reconciliation runs on the first normal AI Help request in a new function instance after a bundle version change, and before every maintainer review operation. The local bundle build never writes to Supabase. After deploying a new bundle, the first app request or a `list` review call performs the hosted reconciliation. If reconciliation fails, the request returns a recoverable service error instead of using potentially stale verified content. No destructive knowledge deletion occurs.

## Operational metrics and failure recovery

The database stores daily aggregate counts by event and feature category only: requests, source fallbacks, verified-topic use, candidates created/skipped/rejected, duplicate skips, approvals, rejections, stale entries, grounding failures, missing retrieval, provider failures, conflicting knowledge, and feedback failures. A missing model-proposed candidate is not counted as a skip; a personal conversation excluded by the privacy rule is counted as `candidate_skipped`, while a proposed candidate that fails validation is counted as `candidate_rejected`. No prompt, question, conversation, tracker value, or question fingerprint enters metrics. Maintainers can inspect the latest 300 daily counters through the authenticated `list` response. These counters are operational signals, not model-quality proof; use `docs/ai-help/quality-evaluation.md` for manual answer evaluation.

Users can mark a remote answer helpful or report it as incorrect. Reports store the authenticated user ID, response UUID, selected category, optional sanitized note (up to 400 characters), topic, bundle version, status, and timestamps. They do not store the answer text or conversation. Notes containing email addresses, password-like values, bearer credentials, or JWT-like tokens are rejected. A user may submit at most 10 reports per 15 minutes; duplicate reports for the same response are idempotent. The legacy answer-feedback table expires reports after 180 days; the unified inbox copy follows the same retention and is lazily pruned when a maintainer opens either feedback list. Account deletion cascades through support feedback, messages, and associated email jobs. Only the `ai-help-feedback` server endpoint submits answer feedback; `ai-help-review` reviews answer quality and `support-inbox` manages support threads.

Maintainers can open **More → AI Knowledge → Answer Feedback**, filter by status/category, inspect the limited diagnostic context, and mark a report reviewed or resolved. Feedback is a signal for investigation, not an authority source. It never creates or approves knowledge. If an approved explanation conflicts with current application behavior, a maintainer can mark that verified topic stale with a recorded reason; it is then excluded from retrieval and remains in audit history.

General feedback, support queries, bug reports, feature requests, and AI answer feedback are also represented in `support_feedback`. The `support-inbox` Edge Function applies the confirmed-email `AI_HELP_MAINTAINER_EMAILS` allowlist before exposing maintainer records. Users read only their own threads through authenticated support actions. Maintainer replies are committed with an `app_notifications` row in one database function call; clicking the notification opens `#/settings?support=<thread-id>`. User replies return the thread to Open and create a durable support email outbox item. In-app feedback messages remain stored until the account is deleted; account deletion cascades through the thread, messages, notifications, and pending email jobs. No entire AI conversation is copied into support records.

Feedback email delivery happens after the database commit. The outbox distinguishes pending, processing, accepted, failed, and uncertain outcomes; a Brevo accepted response does not prove inbox delivery. Confirmed failures and never-started pending jobs can be retried by an authorized maintainer. Uncertain outcomes, including stale processing attempts after two minutes, cannot be resent to avoid duplicates. External **Email Support** messages are outside the in-app inbox because there is no inbound mailbox integration.

Candidate submission is background best-effort work. If candidate storage is unavailable, a valid answer is still returned; the candidate is not retried automatically, so inspect aggregate counts and investigate database/function health. If freshness reconciliation fails, AI Help fails closed before calling Groq. A conflict during approval returns 409; reload the candidate and re-review. The review history stores only candidate/topic IDs, review actions, statuses, and approved knowledge snapshots, not chat data.

Set `AI_HELP_CANDIDATE_COLLECTION_ENABLED=false` in the AI Help Function environment to stop new candidate collection while leaving answer generation, verified retrieval, and maintainer review available. Remove or change the value to re-enable it. This flag does not delete queued or verified knowledge.

## Privacy, authentication, and provider behavior

The browser sends the user’s question, bounded recent conversation, and fixed route identifier. It does not send tracker definitions, check-ins, journals, goals, or workspace settings. Remote answers require an authenticated user. Local FAQ answers are limited and may be used offline or while signed out.

Configure the existing Supabase browser URL and publishable key in the app. Configure `GROQ_API_KEY_PRIMARY` as a Supabase Function secret; a separately provisioned `GROQ_API_KEY_SECONDARY` is optional. `GROQ_MODEL` is optional and defaults in code to `openai/gpt-oss-120b`. Never place provider secrets in browser code or print them to logs.

Set `AI_HELP_ALLOWED_ORIGINS` to the comma-separated exact origins that should call the endpoint. The Edge Function also requires its server-side Supabase URL, publishable/anon key, and service-role key. The service-role key stays in the Function environment. The database request limiter allows up to 8 requests per user per minute and 24 per project per minute; its server-side RPC is the enforcement boundary. A provider 429 does not rotate to another credential. Transient network, 401/403, and 5xx failures may try a healthy secondary once; there is no repeated retry loop.

The browser session stores the bounded conversation in `sessionStorage` for continuity. It is not synced across devices. The assistant does not claim long-term memory.

If the client shows “AI Help could not check its request limit,” the Edge Function received an error from `consume_ai_help_request`; this is distinct from a 429 quota response. The function logs the marker `AI_HELP_RATE_LIMIT_RPC_FAILED` with only the Postgres/PostgREST error code. In Supabase Dashboard, open **Edge Functions → ai-help → Logs** and filter for that marker, then compare the code and timestamp with **Logs → Postgres**. Codes such as `PGRST202` or `42883` indicate RPC discovery/signature problems; `42501` indicates permission denial; `42P01` or `42703` indicate missing schema objects. Do not copy request headers, tokens, SQL parameter values, or provider secrets into a support report.

The current migration explicitly reloads the PostgREST schema cache after installing the function and its service-role grant. If the marker continues after deploying migration `20261026000100`, inspect the exact logged error code and verify the function signature and role grant in the target database before changing any limit.

## Local verification

Run the focused and full checks from the repository root:

```sh
npm run build:ai-help-bundle
npm test -- supabase/functions/ai-help src/features/ai-help
npm test
npm run typecheck
npm run build
```

For local Edge compilation/startup, make sure the local Supabase stack is available, then run:

```sh
supabase functions serve ai-help --no-verify-jwt
```

The server should report the `ai-help` endpoint and a compatible Supabase Edge Runtime. Do not send a live Groq request as a compile check. A local unauthenticated handler check can be performed with a localhost-only origin and a request without a bearer token; it should be rejected before any model request. The local gateway may require its normal local API-key routing header before the request reaches the function.

No database schema changes are required to rebuild this bundle. For this topic-memory workflow, apply the new migrations after reviewing the target migration list, then run `supabase test db`. Do not reset the database.

## Release procedure

1. Run bundle generation and all local checks above.
2. Review the bundle version and ensure `knowledgeVersion`, `sourceVersion`, and `sourceIndexVersion` are identical.
3. Confirm migration versions through `20261022000100` are present, then review the pending `20261023000100`, `20261024000100`, `20261025000100`, and `20261026000100` migrations in the target project. Apply them using the configured project connection:

```sh
supabase migration list
supabase db push
supabase test db
```

   Never repair migration history or reset a database as part of deployment. Do not use `--include-all` to bypass version conflicts.
4. Configure `AI_HELP_MAINTAINER_EMAILS` and the existing required secrets and exact CORS origins in the target Function environment. Keep the Groq key and Supabase service-role key server-side. The candidate collection switch is optional and defaults to enabled.
5. After the application release containing the matching generated bundles is approved, deploy both Functions:

```sh
supabase functions deploy ai-help
supabase functions deploy ai-help-review
```

6. Verify both deployed Function statuses, call the maintainer review API with the allowlisted account, and make one authenticated product smoke test. Check a normal answer, candidate queueing when the model returns an eligible candidate, and recoverable unavailable/rate-limited responses. Do not use real tracker details as test prompts.

Deployment is an explicit release action; bundle generation and local serving do not deploy or modify hosted Supabase.

## Known limits

- Lexical source search is deterministic and cost-conscious, but it is not a full semantic embedding search. The explicit synonyms and indexed code/test terms improve phrasing coverage; an unusual term may still yield no source match.
- Retrieval is bounded and may not find every relevant code path in a very broad question. The assistant should state uncertainty rather than infer from absent evidence.
- Mocked provider tests verify request shape, response validation, retry behavior, evidence selection, and grounding rules. They do not prove live model factual accuracy, latency, or current provider quotas.
- Candidate screening checks reference validity and lexical overlap deterministically, but semantic correctness remains a human review responsibility.
- Source fingerprints are full-file hashes for the reviewed allowlist. An unrelated edit inside a file cited by a topic will mark it stale; changes to unrelated files will not.
- Candidate storage stops accepting new entries at 5,000 lifetime rows to keep the queue bounded. Rejected and stale records are retained for audit.
- A local runtime start proves compilation, not end-to-end authenticated behavior. Test that separately in the local Supabase stack without invoking Groq.
- Mobile viewport component tests do not replace hands-on keyboard and visual review on a real device.
