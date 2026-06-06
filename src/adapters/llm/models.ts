// Central model registry. One place to choose which Gemini model each job uses.
//
// Two tiers, by job type:
//   - fast: JSON-schema classification & extraction (intent, instruction/operator
//           classifiers, onboarding parsing) and the summary workers. These don't
//           need conversational fluency; Flash keeps them cheap and fast.
//   - pro:  conversational generation that the user actually reads — every reply
//           that has to sound human. Pro reasons by default, so call sites must NOT
//           pass `thinkingConfig: { thinkingBudget: 0 }` (invalid/counterproductive
//           on Pro). A Flash fallback protects reliability if a Pro call fails.

export const MODELS = {
  fast: 'gemini-2.5-flash',
  pro: 'gemini-2.5-pro',
} as const

export type ModelTier = keyof typeof MODELS
