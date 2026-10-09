import { z } from "zod";

export const ChatStage = z.enum([
  "reading",
  "allowance",
  "generating",
  "validating",
]);
export type ChatStage = z.infer<typeof ChatStage>;
export const ChatFailure = z.object({
  code: z.enum([
    "allowance",
    "rate_limit",
    "timeout",
    "unavailable",
    "invalid_response",
    "expired",
    "cancelled",
    "limit",
  ]),
  title: z.string(),
  retryable: z.boolean(),
  retryAt: z.string().optional(),
});
export type ChatFailure = z.infer<typeof ChatFailure>;

// Stored with the assistant message so reloads restore its own follow-up.
export const ChatMetadata = z.object({
  suggestion: z.string().max(240),
  stage: ChatStage.optional(),
  outcome: z.enum(["pending", "complete", "failed"]).optional(),
  failure: ChatFailure.optional(),
});
