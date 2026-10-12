export type EvaluationQuestion = { id: string; question: string; expected: string }
export function redact<T>(value: T): T
export function isLoopbackAssistantEndpoint(value: string): boolean
export function initialState(questionIds: string[], maxGroqCalls?: number): { schemaVersion: number; maxGroqCalls: number; reservedCalls: number; questionIds: string[]; results: Record<string, any> }
export function recoverInterruptedState<T extends { results: Record<string, any> }>(state: T): T
export function persistQuestionResult<T extends { results: Record<string, any> }>(outputDir: string, result: Record<string, any>, state: T): Promise<T>
export function runBenchmark(input: { benchmark: EvaluationQuestion[]; outputDir: string; endpoint: string; anonKey: string; accessToken: string; model?: string | null; maxGroqCalls?: number; intervalMs?: number; fetcher?: typeof fetch }): Promise<{ maxGroqCalls: number; reservedCalls: number; questionIds: string[]; results: Record<string, any> }>
