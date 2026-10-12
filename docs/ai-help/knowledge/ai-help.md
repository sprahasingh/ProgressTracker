# AI Help

### ID: ai-help-private-data
**Category:** ai-help
**Question:** Can AI Help see my tracker entries?
**Aliases:**
- Does Groq receive my personal progress?
- What data is sent when I ask a question?
- Can AI Help read my check-in values?
**Keywords:** privacy, tracker entries, personal data, Groq, AI Help
**Suggestible:** true
**Sources:**
- src/features/ai-help/aiHelpService.ts
- supabase/functions/ai-help/index.ts
- supabase/functions/ai-help/assistantCore.ts
**Answer:**
AI Help answers questions about how the product works; its request includes your question and limited conversation context, not your tracker entries. Do not include private tracker details in a question or support message.

### ID: ai-help-suggested-offline
**Category:** ai-help
**Question:** Can I use suggested AI Help questions while offline?
**Aliases:**
- Do the suggested questions work without internet?
- Can AI Help show a saved answer if I am disconnected?
**Keywords:** AI Help, suggestions, offline, verified answer, internet
**Suggestible:** true
**Sources:**
- src/features/ai-help/aiHelpService.ts
- src/features/ai-help/AIHelpAssistant.tsx
**Answer:**
Yes, a displayed verified suggestion opens its bundled answer without a network request. Manually typed questions need a connection for the full retrieval service; only questions matched by the smaller local help catalog can receive a local answer offline.

### ID: ai-help-typed-retrieval
**Category:** ai-help
**Question:** How does AI Help handle a question I type myself?
**Aliases:**
- Does free-form Ask ProgressTracker use the verified answers?
- What happens when I ask a question that is not a suggestion?
**Keywords:** AI Help, typed question, free-form, knowledge retrieval, source evidence
**Suggestible:** true
**Sources:**
- src/features/ai-help/aiHelpService.ts
- supabase/functions/ai-help/index.ts
- supabase/functions/ai-help/assistantCore.ts
**Answer:**
When online, a typed question is checked against verified Q&A first. If no clear catalog answer applies, the service can use relevant product documentation and reviewed source evidence to form a grounded answer. AI Help does not receive your tracker entries.
