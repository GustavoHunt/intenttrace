import { afterEach, describe, expect, it, vi } from "vitest";
import { investigationStream, chatFailure } from "../src/server/chat-stream";
import { HttpError } from "../src/server/security";

describe("conversation feedback stream", () => {
  afterEach(() => vi.useRealTimers());
  it("opens the stream before inference resolves and reports actual preparation stages", async () => {
    let finish!: (answer: { text: string; suggestion: string }) => void;
    const response = investigationStream(async (_signal, progress) => {
      progress("allowance");
      progress("generating");
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const reader = response.body!.getReader();
    let wire = new TextDecoder().decode((await reader.read()).value);
    expect(wire).toContain('"type":"start"');
    expect(wire).toContain('"stage":"reading"');
    expect(wire).not.toContain("Synthetic answer");
    finish({ text: "Synthetic answer", suggestion: "Inspect the scope?" });
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      wire += new TextDecoder().decode(next.value);
    }
    expect(wire).toContain('"stage":"allowance"');
    expect(wire).toContain('"stage":"generating"');
    expect(wire).toContain("Synthetic answer");
    expect(wire).toContain('"outcome":"complete"');
    expect(wire).toContain("[DONE]");
  });
  it("finishes a quota failure as a visible assistant message with a reset time", async () => {
    const response = investigationStream(async () => {
      throw new HttpError(429, "The demo AI allowance has been reached.");
    });
    const wire = await response.text();
    expect(wire).toContain('"type":"text-delta"');
    expect(wire).toContain("daily AI allowance");
    expect(wire).toContain('"outcome":"failed"');
    expect(wire).toContain('"code":"allowance"');
    expect(wire).toContain('"retryable":false');
    expect(wire).toContain('"retryAt":');
    expect(wire).not.toContain('"type":"error"');
    expect(wire).toContain("[DONE]");
  });
  it("settles a hung storage/provider operation and ignores late progress", async () => {
    vi.useFakeTimers();
    let late!: () => void;
    const response = investigationStream(async (_signal, progress) => {
      late = () => progress("generating");
      return new Promise(() => {});
    });
    const wire = response.text();
    await vi.advanceTimersByTimeAsync(65000);
    expect(await wire).toContain('"code":"timeout"');
    expect(() => late()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("finishes user cancellation without throwing into Agent recovery", async () => {
    const controller = new AbortController();
    const response = investigationStream(
      async () => new Promise(() => {}),
      controller.signal,
    );
    const wire = response.text();
    controller.abort();
    expect(await wire).toContain('"code":"cancelled"');
    expect(await wire).toContain("[DONE]");
  });
  it.each([
    [
      new HttpError(502, "Workers AI rate or quota limits prevented analysis."),
      "rate_limit",
    ],
    [
      new HttpError(502, "The model returned an invalid structured response."),
      "invalid_response",
    ],
    [new HttpError(404, "Case unavailable or expired"), "expired"],
    [
      new Error("private provider credential must never be echoed"),
      "unavailable",
    ],
  ])("classifies failures without exposing raw errors: %s", (error, code) => {
    const result = chatFailure(error);
    expect(result.failure.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("credential");
  });
});
