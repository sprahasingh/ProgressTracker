# Maintaining verified AI Help answers

The Markdown files in `docs/ai-help/knowledge/` are the canonical catalog. Add one `### ID:` block for each distinct user intent. Include a stable kebab-case ID, an allowed category, one canonical question, aliases, keywords, `Suggestible`, source paths, and a concise answer. Every source path must exist. Keep unsupported or personal-data-dependent topics out of the suggestible catalog. To remove an answer, delete its full entry block and rebuild; do not leave a generated copy behind.

Run `npm run build:ai-help-bundle` to validate and regenerate the Edge Function bundle, frontend catalog, source index, fingerprints, capability bundle, and shared support contact. The generated catalog includes the same entry IDs, answers, and source references for server retrieval and frontend suggestions.

The generator records a SHA-256 fingerprint of every supporting source file in `knowledge-review.json`. If a supporting file changes, generation stops and names affected entries. Re-check those answers against the implementation and tests, update the Markdown if needed, then run `node scripts/build-ai-help-bundle.mjs --refresh-knowledge-review` to record that review. This manifest is a review reminder; it is not proof that an answer is factually correct.

The generated bundle version changes whenever catalog, source, capability, or product documentation content changes. The Edge Function rejects inconsistent generated bundle versions. Clicked suggestions resolve to public product-help text bundled in the frontend; the user supplied question and its answer are never trusted as an answer payload.
