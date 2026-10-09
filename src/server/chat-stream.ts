import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { ChatFailure, ChatStage } from "../shared/chat";
import { HttpError } from "./security";
import { withDeadline } from "./request-deadline";

export function chatFailure(error: unknown): {
  text: string;
  failure: ChatFailure;
} {
  const message = error instanceof HttpError ? error.publicMessage : "";
  if (/demo AI allowance/i.test(message)) {
    const reset = new Date();
    reset.setUTCHours(24, 0, 0, 0);
    return {
      text: "I couldn’t generate an answer because this app’s daily AI allowance has been reached. Your question and evidence are saved. You can still review the timeline, findings and linked evidence. Try again after the allowance resets.",
      failure: {
        code: "allowance",
        title: "AI allowance reached",
        retryable: false,
        retryAt: reset.toISOString(),
      },
    };
  }
  if (/rate or quota/i.test(message))
    return {
      text: "The AI provider’s rate or credit limit prevented this answer. Your question and evidence are saved. Check the provider allowance before trying again, or review the existing evidence now.",
      failure: {
        code: "rate_limit",
        title: "AI provider limit reached",
        retryable: false,
      },
    };
  if (error instanceof HttpError && error.status === 504)
    return {
      text: "The answer took too long to prepare. Your question and evidence are saved. Retry the answer, or ask a narrower question.",
      failure: {
        code: "timeout",
        title: "The response timed out",
        retryable: true,
      },
    };
  if (error instanceof Error && error.name === "AbortError")
    return {
      text: "The response was stopped. You can retry this question when you’re ready.",
      failure: {
        code: "cancelled",
        title: "Response stopped",
        retryable: true,
      },
    };
  if (error instanceof HttpError && [401, 404].includes(error.status))
    return {
      text: "This case or session is no longer available. Refresh the page to check your current session before sending another question.",
      failure: { code: "expired", title: "Case unavailable", retryable: false },
    };
  if (/structured|unknown evidence/i.test(message))
    return {
      text: "The AI response could not be verified, so it has not been shown as an answer. Your question and evidence are saved. Please retry.",
      failure: {
        code: "invalid_response",
        title: "The answer could not be verified",
        retryable: true,
      },
    };
  if (error instanceof HttpError && [413, 429].includes(error.status))
    return {
      text: message + " Your existing evidence remains available.",
      failure: {
        code: "limit",
        title: "Conversation limit reached",
        retryable: false,
      },
    };
  return {
    text: "The AI service could not complete this answer. Your question and evidence are saved. Retry when the service is available, or review the timeline now.",
    failure: {
      code: "unavailable",
      title: "AI response unavailable",
      retryable: true,
    },
  };
}

// Start before reading storage, checking budget, or contacting the provider.
// Operational progress is streamed; private model reasoning is never requested.
export function investigationStream(
  answer: (
    signal: AbortSignal,
    progress: (stage: ChatStage) => void,
  ) => Promise<{ text: string; suggestion: string }>,
  signal?: AbortSignal,
) {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({
        type: "start",
        messageId: crypto.randomUUID(),
        messageMetadata: {
          suggestion: "",
          outcome: "pending",
          stage: "reading",
        },
      });
      let active = true;
      const progress = (stage: ChatStage) => {
        if (active)
          writer.write({
            type: "message-metadata",
            messageMetadata: { stage },
          });
      };
      let result: { text: string; suggestion: string; failure?: ChatFailure };
      try {
        result = await withDeadline(
          (boundedSignal) => answer(boundedSignal, progress),
          65000,
          signal,
        );
      } catch (error) {
        result = { ...chatFailure(error), suggestion: "" };
      } finally {
        active = false;
      }
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: result.text });
      writer.write({ type: "text-end", id });
      writer.write({
        type: "finish",
        messageMetadata: {
          suggestion: result.suggestion,
          outcome: result.failure ? "failed" : "complete",
          ...(result.failure ? { failure: result.failure } : {}),
        },
      });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
