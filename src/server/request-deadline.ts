import { HttpError } from "./security";

// Race as well as abort: a stalled remote binding may ignore cancellation.
// Always settle the caller so the Agent can release its conversation turn.
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  let rejectAborted!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
  });
  controller.signal.addEventListener("abort", rejectAborted, { once: true });
  parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new HttpError(
    504,
    "The AI response timed out. Your question is preserved; retry the answer.",
  )), milliseconds);
  try {
    if (parent?.aborted) cancel();
    return await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAborted);
  }
}
