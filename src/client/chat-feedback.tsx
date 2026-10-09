import React from "react";
import { AlertCircle, Check, Clock3, Square } from "lucide-react";
import type { ChatFailure, ChatStage } from "../shared/chat";

const stages: {
  id: ChatStage;
  label: string;
  title: string;
  detail: string;
}[] = [
  {
    id: "reading",
    label: "Read case evidence",
    title: "Reading your case",
    detail:
      "Gathering the current scope, timeline, findings and linked evidence.",
  },
  {
    id: "allowance",
    label: "Check AI allowance",
    title: "Checking AI allowance",
    detail: "Checking whether this session can request an AI answer.",
  },
  {
    id: "generating",
    label: "Prepare answer",
    title: "Preparing your answer",
    detail:
      "Waiting for Cloudflare AI to respond using the selected case evidence.",
  },
  {
    id: "validating",
    label: "Check evidence links",
    title: "Checking evidence links",
    detail:
      "Validating the response and its references before showing the answer.",
  },
];

export function ChatProgress({
  stage,
  elapsed,
  onStop,
}: {
  stage?: ChatStage;
  elapsed: number;
  onStop: () => void;
}) {
  const index = stages.findIndex((step) => step.id === stage);
  const current = stages[index];
  return (
    <div className="chat-progress" aria-label="Answer progress">
      <div className="chat-feedback-heading">
        <strong role="status">
          {current?.title || "Sending your question"}
        </strong>
        <span className="chat-elapsed" aria-hidden="true">
          <Clock3 size={14} /> {elapsed}s
        </span>
      </div>
      <p>
        {elapsed >= 45
          ? "This is taking longer than usual. You can stop and retry; your question will stay here."
          : current?.detail ||
            "Connecting to this case. Your question will stay here if the connection fails."}
      </p>
      <ol
        className="chat-progress-steps"
        aria-label="Response preparation stages"
      >
        {stages.map((step, i) => (
          <li
            key={step.id}
            className={i < index ? "complete" : i === index ? "current" : ""}
            aria-current={i === index ? "step" : undefined}
          >
            {i < index ? (
              <Check size={14} aria-label="Complete" />
            ) : (
              <span className="chat-step-dot" aria-hidden="true" />
            )}
            {step.label}
          </li>
        ))}
      </ol>
      <div className="chat-feedback-actions">
        <button className="secondary" onClick={onStop}>
          <Square size={13} /> Stop response
        </button>
      </div>
    </div>
  );
}

export function ChatFailureNotice({ failure }: { failure: ChatFailure }) {
  const reset = failure.retryAt ? new Date(failure.retryAt) : undefined;
  return (
    <>
      <div className="chat-failure-title">
        <AlertCircle size={17} aria-hidden="true" />
        <strong>{failure.title}</strong>
      </div>
      {reset && (
        <p className="chat-reset">
          Allowance resets{" "}
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(reset)}{" "}
          (your local time).
        </p>
      )}
    </>
  );
}
