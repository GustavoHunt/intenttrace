import { describe, it, expect, vi, afterEach } from "vitest";
import { answerInvestigation, investigationContext } from "../src/server/chat";
import { newCase, event, type Artifact } from "../src/shared/domain";
import type { UIMessage } from "ai";

const message = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});
const document: Artifact = {
  id: "release_evidence",
  name: "release.txt",
  kind: "document",
  sha256: "a".repeat(64),
  content: "Synthetic delivery has the identifier QUARTZ-482.",
};
function fixture() {
  const c = newCase("correct");
  c.artifacts.push(document);
  event(
    c,
    "evidence",
    "Release record",
    "Synthetic timeline signal: staging only",
    { artifactIds: [document.id], provenance: "supplied" },
  );
  c.findings.push({
    id: "review",
    runId: "synthetic",
    evidenceRevision: c.revision,
    createdAt: new Date().toISOString(),
    summary: "Synthetic investigation",
    explanationMode: "live",
    superseded: false,
    findings: [
      {
        criterion: "Release scope",
        status: "insufficient_evidence",
        explanation: "Production evidence is missing",
        evidenceIds: [c.events.at(-1)!.id],
        gaps: ["Need production receipt"],
        nextSteps: ["Collect the receipt"],
      },
    ],
  });
  return c;
}
function provider() {
  const run = vi.fn().mockResolvedValue({
    response: {
      text: "The release identifier is QUARTZ-482.",
      evidenceIds: [document.id],
      suggestion: "What evidence would confirm production delivery?",
    },
  });
  const reserve = vi.fn().mockResolvedValue(true);
  return {
    run,
    reserve,
    env: {
      modelMode: "live",
      AI: { run },
      MODEL_ID: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      AI_GATEWAY_ID: "synthetic",
      BUDGET: { idFromName: () => "budget", get: () => ({ reserve }) },
    } as any,
  };
}
describe("investigation chat", () => {
  afterEach(() => vi.useRealTimers());
  it("releases a stalled provider turn at the deadline and permits a retry", async () => {
    vi.useFakeTimers();
    const { run, env } = provider();
    run.mockImplementationOnce(() => new Promise(() => {}));
    const pending = answerInvestigation(env, "session", fixture(), [message("Explain")]);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60000);
    await rejected;
    expect(run.mock.calls[0][2].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect((await answerInvestigation(env, "session", fixture(), [message("Explain")])).text).toContain("QUARTZ-482");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a stalled provider call when the user stops the response", async () => {
    const { run, env } = provider();
    const controller = new AbortController();
    run.mockImplementationOnce(() => new Promise(() => {}));
    const pending = answerInvestigation(env, "session", fixture(), [message("Explain")], controller.signal);
    const rejected = expect(pending).rejects.toThrow("Stopped");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort(new Error("Stopped"));
    await rejected;
    expect(run.mock.calls[0][2].signal.aborted).toBe(true);
  });
  it("does not start inference after a cancelled budget reservation completes", async () => {
    const { run, reserve, env } = provider();
    const controller = new AbortController();
    let release!: (value: boolean) => void;
    reserve.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = answerInvestigation(env, "session", fixture(), [message("Explain")], controller.signal);
    const rejected = expect(pending).rejects.toThrow("Stopped");
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(1));
    controller.abort(new Error("Stopped"));
    await rejected;
    release(true);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });
  it("returns a normalized follow-up generated in the same response", async () => {
    const { run, env } = provider();
    run.mockResolvedValue({
      response: {
        text: "Answer",
        evidenceIds: [],
        suggestion: "  Compare the scope\nwith the export.  ",
      },
    });
    const answer = await answerInvestigation(env, "session", fixture(), [
      message("Explain"),
    ]);
    expect(answer.suggestion).toBe("Compare the scope with the export.");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("validates the follow-up field and allows no suggestion", async () => {
    const { run, env } = provider();
    for (const suggestion of [null, "x".repeat(241)]) {
      run.mockResolvedValue({
        response: { text: "Answer", evidenceIds: [], suggestion },
      });
      await expect(
        answerInvestigation(env, "session", fixture(), [message("Explain")]),
      ).rejects.toThrow("invalid structured response");
    }
    run.mockResolvedValue({
      response: { text: "Answer", evidenceIds: [], suggestion: "" },
    });
    expect(
      (
        await answerInvestigation(env, "session", fixture(), [
          message("Explain"),
        ])
      ).suggestion,
    ).toBe("");
  });
  it("keeps the current approved scope even when all twelve requirements are long", () => {
    const c = fixture();
    c.scopes[0].requirements = Array.from({ length: 12 }, (_, i) => ({
      id: `req_${i}`,
      text: "范围".repeat(500),
    }));
    const { context } = investigationContext(c, "What is approved?");
    expect(context.scopes.records[0].id).toBe(c.scopes[0].id);
    expect(context.scopes.records[0].requirements).toHaveLength(12);
  });
  it("passes case, timeline, scope, findings and artifacts together in one Llama call", async () => {
    const { run, reserve, env } = provider();
    const c = fixture();
    const answer = await answerInvestigation(env, "session", c, [
      message("What did the investigation find?"),
    ]);
    expect(answer.text).toContain("[release_evidence]");
    expect(answer.suggestion).toBe(
      "What evidence would confirm production delivery?",
    );
    expect(answer.evidenceIds).toEqual([document.id]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    );
    const prompt = JSON.parse(run.mock.calls[0][1].messages[1].content);
    expect(prompt.investigation.case.id).toBe(c.id);
    expect(prompt.investigation.scopes.records[0].id).toBe(c.scopes.at(-1)!.id);
    expect(JSON.stringify(prompt)).toContain("staging only");
    expect(JSON.stringify(prompt)).toContain("Need production receipt");
    expect(JSON.stringify(prompt)).toContain("QUARTZ-482");
    expect(prompt.allowedEvidenceIds).toContain(c.events.at(-1)!.id);
  });
  it("reads changed evidence on follow-up and excludes stale assessments", async () => {
    const { run, env } = provider();
    const c = fixture();
    c.findings[0].superseded = true;
    c.revision++;
    c.artifacts[0].content = "New current evidence";
    await answerInvestigation(env, "session", c, [
      message("Explain release"),
      {
        id: "old",
        role: "assistant",
        parts: [{ type: "text", text: "Old answer" }],
      },
      message("What changed?"),
    ]);
    const prompt = JSON.parse(run.mock.calls[0][1].messages[1].content);
    expect(prompt.history.map((m: any) => m.text)).toEqual([
      "Explain release",
      "Old answer",
    ]);
    expect(prompt.investigation.assessment).toBeNull();
    expect(prompt.investigation.supersededAssessments).toBe(1);
    expect(prompt.investigation.case.revision).toBe(c.revision);
  });
  it("rejects fabricated or cross-case evidence references", async () => {
    const { run, env } = provider();
    run.mockResolvedValue({
      response: {
        text: "Claim",
        evidenceIds: ["another_case"],
        suggestion: "",
      },
    });
    await expect(
      answerInvestigation(env, "session", fixture(), [message("Explain")]),
    ).rejects.toThrow("unknown evidence");
  });
  it("retrieves older timeline records and text near the end of artifacts within a bounded context", () => {
    const c = fixture();
    c.events = Array.from({ length: 500 }, (_, i) => ({
      ...c.events[0],
      id: `event_${i}`,
      sequence: i + 1,
      detail: "普通证据".repeat(900),
      title: i === 0 ? "QUARTZ receipt" : "Another event",
    }));
    c.artifacts = [
      {
        ...document,
        content: "padding ".repeat(50000) + "QUARTZ-482 release receipt",
      },
    ];
    const { context } = investigationContext(c, "QUARTZ receipt");
    expect(context.timeline.records.some((e) => e.id === "event_0")).toBe(true);
    expect(context.timeline.omitted).toBeGreaterThan(0);
    expect(JSON.stringify(context.excerpts)).toContain(
      "QUARTZ-482 release receipt",
    );
    expect(
      new TextEncoder().encode(JSON.stringify(context)).length,
    ).toBeLessThan(57000);
  });
  it("does not call the provider in offline mode or when the budget is exhausted", async () => {
    const { run, reserve, env } = provider();
    await expect(
      answerInvestigation(
        { ...env, modelMode: "offline" },
        "session",
        fixture(),
        [message("Explain")],
      ),
    ).rejects.toThrow("not configured");
    reserve.mockResolvedValue(false);
    await expect(
      answerInvestigation(env, "session", fixture(), [message("Explain")]),
    ).rejects.toThrow("allowance");
    expect(run).not.toHaveBeenCalled();
  });
  it("reports actual provider stages and excludes failure notices from model history", async () => {
    const { run, env } = provider();
    const progress = vi.fn();
    await answerInvestigation(env, "session", fixture(), [
      message("Explain"),
      { id: "failure", role: "assistant", metadata: { suggestion: "", outcome: "failed", failure: { code: "allowance", title: "AI allowance reached", retryable: false } }, parts: [{ type: "text", text: "INTERNAL_FAILURE_NOTICE" }] },
      message("Try again"),
    ], undefined, progress);
    expect(progress.mock.calls.map(([stage]) => stage)).toEqual(["allowance", "generating", "validating"]);
    expect(run.mock.calls[0][1].messages[1].content).not.toContain("INTERNAL_FAILURE_NOTICE");
  });
});
