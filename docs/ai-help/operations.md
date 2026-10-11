# AI Help Assistant operations

This guide covers the AI Help knowledge build, local verification, and release requirements. The runtime uses one Groq request per question, a fixed Supabase Edge Function, versioned documentation, and an allowlisted source index. It does not have general filesystem or repository access.

## Knowledge and source build

The authoritative inputs are the five feature guides in `docs/ai-help/` and the reviewed source paths in `scripts/build-ai-help-bundle.mjs`. The builder:

1. Splits product guides into heading-level sections so runtime retrieval can send only relevant passages.
2. Reads approved implementation and behavioral test files into build-time 14-line, overlapping excerpts. Each excerpt stores its source path, nearest function or test label, line range, searchable terms, and whether it is implementation or test evidence.
3. Generates `knowledgeBundle.ts`, `sourceBundle.ts`, and `sourceIndex.ts` under `supabase/functions/ai-help/_generated/`.
4. Computes a shared version from the app version and the contents of all included guides and source files.

Run the generator after editing any included guide or source file:

```sh
npm run build:ai-help-bundle
```

Do not manually edit generated files. Check that all three generated versions match and that the source paths in `sourceBundle.ts` correspond to indexed entries. The build reads only its explicit allowlist; the Edge Function cannot inspect the developer filesystem. Source import declaration lines are omitted from generated evidence, while the surrounding implementation and test excerpts remain indexed. This also prevents the local Edge bundler from interpreting browser-only imports found inside generated evidence as Edge modules.

## Runtime evidence selection

The request handler selects up to four relevant documentation sections. It automatically selects a bounded set of source-index excerpts when the docs have weak query coverage or the question asks for implementation-sensitive behavior, such as why a restriction exists, what happens after an edit, or how a conflict is handled. Source matches are ranked by query terms, term rarity, feature context, and implementation/test type. At most four snippets and 5,200 characters are sent to Groq. The prompt prefers implementation behavior over conflicting prose, while the final answer remains user-facing and does not expose code or paths.

The endpoint allows citations only from the documentation sections and source paths actually supplied for that request. If no supplied evidence supports the answer, the assistant must acknowledge uncertainty. A knowledge-version mismatch blocks generation rather than serving stale bundles. Reviewed answers are exact-question matches only, must cite current allowlisted references, and are skipped for context-dependent follow-ups. Generated answer candidates remain pending; they are never automatically promoted.

## Privacy, authentication, and provider behavior

The browser sends the user’s question, bounded recent conversation, and fixed route identifier. It does not send tracker definitions, check-ins, journals, goals, or workspace settings. Remote answers require an authenticated user. Local FAQ answers are limited and may be used offline or while signed out.

Configure the existing Supabase browser URL and publishable key in the app. Configure `GROQ_API_KEY_PRIMARY` as a Supabase Function secret; a separately provisioned `GROQ_API_KEY_SECONDARY` is optional. `GROQ_MODEL` is optional and defaults in code to `openai/gpt-oss-120b`. Never place provider secrets in browser code or print them to logs.

Set `AI_HELP_ALLOWED_ORIGINS` to the comma-separated exact origins that should call the endpoint. The Edge Function also requires its server-side Supabase URL, publishable/anon key, and service-role key. The service-role key stays in the Function environment. The database request limiter allows up to 8 requests per user per minute and 24 per project per minute; its server-side RPC is the enforcement boundary. A provider 429 does not rotate to another credential. Transient network, 401/403, and 5xx failures may try a healthy secondary once; there is no repeated retry loop.

The browser session stores the bounded conversation in `sessionStorage` for continuity. It is not synced across devices. The assistant does not claim long-term memory.

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

No database schema changes are required to rebuild this bundle. Run `supabase test db` only when database code or migrations change; AI Help client/index changes do not call for a database reset or migration.

## Release procedure

1. Run bundle generation and all local checks above.
2. Review the bundle version and ensure `knowledgeVersion`, `sourceVersion`, and `sourceIndexVersion` are identical.
3. Confirm the target Supabase project has the reviewed AI Help migrations through `20261022000100`; inspect migration status before applying any missing migration. Never repair migration history or reset a database as part of the bundle release.
4. Configure the required secrets and exact CORS origins in the target Function environment. Keep the Groq key and Supabase service-role key server-side.
5. After the application release containing the matching generated bundles is approved, deploy the Function:

```sh
supabase functions deploy ai-help
```

6. Verify the deployed Function’s status and make one authenticated product smoke test using an approved account. Check that a normal answer works and that an unavailable/rate-limited response remains recoverable. Do not use real tracker details as test prompts.

Deployment is an explicit release action; bundle generation and local serving do not deploy or modify hosted Supabase.

## Known limits

- Lexical source search is deterministic and cost-conscious, but it is not a full semantic embedding search. The explicit synonyms and indexed code/test terms improve phrasing coverage; an unusual term may still yield no source match.
- Retrieval is bounded and may not find every relevant code path in a very broad question. The assistant should state uncertainty rather than infer from absent evidence.
- Mocked provider tests verify request shape, response validation, retry behavior, evidence selection, and grounding rules. They do not prove live model factual accuracy, latency, or current provider quotas.
- A local runtime start proves compilation, not end-to-end authenticated behavior. Test that separately in the local Supabase stack without invoking Groq.
- Mobile viewport component tests do not replace hands-on keyboard and visual review on a real device.
