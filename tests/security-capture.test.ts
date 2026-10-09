import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_BYTES,
  CAPTURE_BYTES,
  CASE_BODY_BYTES,
  assertArtifactBody,
  assertCaseBodies,
  boundedStoredText,
  deleteCaseEvidence,
} from "../src/server/evidence-limits";
import { artifact, hash, newCase, type Artifact } from "../src/shared/domain";
import { reviewRequirement } from "../src/server/evidence-review";

const source = (
  content: string,
  observation?: Artifact["observation"],
): Artifact => ({
  id: "source",
  name: "synthetic",
  kind: "document",
  content,
  sha256: "a".repeat(64),
  observation,
});
describe("evidence byte boundary", () => {
  it("bounds observed bytes independently of a stripped manifest, including multibyte text", () => {
    expect(() =>
      assertArtifactBody(
        source("界".repeat(CAPTURE_BYTES / 3 + 1), "rendered_dom"),
      ),
    ).toThrow("size limit");
    expect(() =>
      assertArtifactBody(source("ok", "rendered_dom")),
    ).not.toThrow();
    expect(() => assertArtifactBody(source("界".repeat(900000)))).not.toThrow();
    expect(() =>
      assertArtifactBody(source("x".repeat(ARTIFACT_BYTES + 1))),
    ).toThrow("size limit");
    expect(() =>
      assertCaseBodies(
        Array.from(
          { length: Math.ceil(CASE_BODY_BYTES / CAPTURE_BYTES) + 1 },
          () => source("x".repeat(CAPTURE_BYTES), "rendered_dom"),
        ),
      ),
    ).toThrow("Case evidence bodies");
  });
  it("validates server-created artifacts before hashing oversized JSON", async () => {
    await expect(
      artifact("synthetic", "document", "x".repeat(900001)),
    ).rejects.toThrow();
    expect(
      (await artifact("synthetic", "document", { text: "safe" })).sha256,
    ).toHaveLength(64);
  });
  it("rejects declared and streamed oversized stored bodies before decoding, cancelling either path", async () => {
    for (const size of [CAPTURE_BYTES + 1, 0]) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(CAPTURE_BYTES + 1));
        },
        cancel,
      });
      await expect(
        boundedStoredText({ size, body }, CAPTURE_BYTES),
      ).rejects.toThrow("Stored evidence exceeds");
      expect(cancel).toHaveBeenCalled();
    }
    const bytes = new TextEncoder().encode("正常 evidence");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.subarray(0, 2));
        c.enqueue(bytes.subarray(2));
        c.close();
      },
    });
    expect(
      await boundedStoredText({ size: bytes.length, body }, CAPTURE_BYTES),
    ).toBe("正常 evidence");
  });
  it("deletes snapshots and orphan bodies across batches without touching another case", async () => {
    const keys = new Set([
      ...Array.from({ length: 1005 }, (_, i) => `owner_case/orphan-${i}`),
      "owner_case/analysis-run",
      "other_case/keep",
    ]);
    const bucket = {
      list: vi.fn(async ({ prefix, limit }) => ({
        objects: [...keys]
          .filter((key) => key.startsWith(prefix))
          .slice(0, limit)
          .map((key) => ({ key })),
      })),
      delete: vi.fn(async (batch: string[]) => {
        batch.forEach((key) => keys.delete(key));
      }),
    };
    await deleteCaseEvidence(bucket as any, "owner_case");
    expect([...keys]).toEqual(["other_case/keep"]);
    expect(bucket.delete).toHaveBeenCalledTimes(2);
  });
  it("does not let a last oversized title reject the model request", async () => {
    const c = newCase("correct");
    const content = JSON.stringify({
      title: "界".repeat(50000),
      text: "A normal synthetic summary",
      status: 200,
    });
    c.artifacts = [
      {
        ...source(content, "rendered_dom"),
        sha256: await hash(content),
        capturedAt: new Date().toISOString(),
        sourceUrl: "https://example.com/",
      },
    ];
    let prompt = "";
    const run = vi.fn(async (_model, input) => {
      prompt = input.messages[1].content;
      return {
        response: {
          proposedStatus: "insufficient_evidence",
          explanation: "Synthetic evidence needs human review.",
          observations: [],
          gaps: [],
          nextSteps: [],
          citations: [],
        },
      };
    });
    await reviewRequirement(
      {
        modelMode: "live",
        AI: { run },
        MODEL_ID: "synthetic",
        BUDGET: {
          idFromName: () => "b",
          get: () => ({ reserve: async () => true }),
        },
      } as any,
      "synthetic",
      { id: "req_1", text: "Verify the summary" },
      c,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(48000);
    expect(prompt).toContain("Oversized online fields were omitted");
  });
});

it("does not mistake an independent HTTP error page for valid no-JS or FAQ evidence", async () => {
  const { evaluationCase } = await import("../src/server/evaluation-cases");
  const { acceptanceResults } = await import("../src/server/acceptance");
  for (const kind of ["no_js", "faq"] as const) {
    const c = await evaluationCase("visible-delivery");
    c.evidencePlan!.checks[0].kind = kind;
    c.evidencePlan!.checks[0].expected = "Project summary delivered";
    const page = {
      status: 200,
      serverHtml: {
        status: 503,
        text: "Project summary delivered",
        truncated: false,
      },
      structuredData: [
        JSON.stringify({
          "@type": "FAQPage",
          mainEntity: [
            { acceptedAnswer: { text: "Project summary delivered" } },
          ],
        }),
      ],
    };
    c.artifacts[0].content = JSON.stringify(page);
    expect(acceptanceResults(c)[0].status).toBe("insufficient_evidence");
    page.serverHtml.status = 200;
    c.artifacts[0].content = JSON.stringify(page);
    expect(acceptanceResults(c)[0].status).toBe("supported");
  }
});
