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
