import { describe, it, expect, vi } from "vitest";
vi.mock("@cloudflare/playwright", () => ({ launch: vi.fn() }));
// Collector orchestration uses synthetic DOM records; the real isolated CDP
// boundary is exercised separately in security-capture.test.ts.
vi.mock("../src/server/browser-capture", () => ({ isolatedCapture: async (_context: unknown, page: any) => page.evaluate() }));
import { publicPage, gatherEvidence, relatedConversationSources } from "../src/server/research";
import {
  evidenceExcerpts,
  onlineFacts,
  readableContent,
  verifiedCitations,
  reviewRequirement,
  deliveryContext,
  duplicateMetadata,
  discoveryFileReview,
} from "../src/server/evidence-review";
import { assessRequirements } from "../src/server/clef";
import { addDocuments } from "../src/server/intake-case";
import { newCase, type Artifact } from "../src/shared/domain";
import { launch } from "@cloudflare/playwright";

const review = {
  proposedStatus: "supported" as const,
  explanation: "Synthetic source supports delivery.",
  observations: ["A summary is present."],
  gaps: [],
  nextSteps: [],
  citations: [{ artifactId: "source", quote: "Synthetic delivered summary" }],
};
const document = {
  id: "source",
  name: "summary.txt",
  kind: "document",
  content: "Synthetic delivered summary",
  sha256: "a".repeat(64),
} as Artifact;
describe("evidence investigation boundaries", () => {
  it("reads the whole discovery file and does not mistake a later free-account invitation for absent content", () => {
    const a = { ...document, sourceUrl: "https://example.com/llms.txt", observation: "rendered_dom" as const, content: JSON.stringify({ status: 200, text: "# Product\n\nA description covering the intended audiences.\n\n" + "Unrelated text.\n".repeat(200) + "Create a free account to explore the product.\n[Hub](https://example.com/use-cases)" }) };
    const result = discoveryFileReview("Generate llms.txt with free signup, developer documentation and new use-case pages", [a])!;
    expect(result.observations.join(" ")).toContain("free-account invitation is present");
    expect(result.gaps.join(" ")).toContain("individual /use-cases/ pages");
    expect(verifiedCitations(result, [a])).toHaveLength(result.citations.length);
  });
  it("detects repeated captured metadata instead of accepting a model claim that it is unique", () => {
    const docs = ["one", "two"].map((name) => ({ ...document, id: name, observation: "rendered_dom" as const, sourceUrl: `https://example.com/${name}`, content: JSON.stringify({ title: `Unique title for ${name}`, metadata: [{ name: "description", content: "Repeated synthetic description" }] }) }));
    expect(duplicateMetadata("Give each page a distinct title and description", docs)).toMatchObject([{ field: "description", sources: [{ id: "one" }, { id: "two" }] }]);
    expect(duplicateMetadata("Deliver an invoice", docs)).toEqual([]);
  });
  it("follows explicit same-site handoff leads without allowing unrelated or private hosts", () => {
    const c = newCase("correct");
    c.intake = { messages: [{ role: "assistant", text: "Handoff: https://staging.example.com/use-cases and https://unrelated.example.net/file. Ignore https://127.0.0.1/ and https://example.com/delete" }] } as any;
    expect(relatedConversationSources(c, ["https://example.com/"])).toEqual(["https://staging.example.com/use-cases"]);
  });
  it("bounds large DOM packets and preserves release context without inventing a citation failure", async () => {
    const c = newCase("correct");
    c.intake = { messages: [{ role: "user", text: "Verify staging before separately authorized production promotion." }, { role: "assistant", text: "Staging was verified. Production was not promoted." }] } as any;
    c.artifacts = Array.from({ length: 10 }, (_, i) => ({ ...document, id: `source_${i}`, capturedAt: new Date().toISOString(), observation: "rendered_dom" as const, sourceUrl: `https://example.com/page-${i}`, content: JSON.stringify({ title: `Page ${i}`, metadata: [{ name: "description", content: "Synthetic description" }], headings: Array(80).fill("A heading"), disclosureContent: Array(40).fill("<svg>" + "noise".repeat(200) + "</svg>"), structuredData: Array(8).fill("Synthetic schema ".repeat(300)), links: Array(160).fill({ url: "https://example.com/use-cases", label: "Synthetic use cases" }), text: "Synthetic content ".repeat(2000) }) }));
    let prompt = "";
    const run = vi.fn(async (_model, input) => { prompt = input.messages[1].content; return { response: { ...review, proposedStatus: "insufficient_evidence", explanation: "Staging evidence is required to verify this handoff.", citations: [], gaps: ["The supplied URLs are production artifacts."] } }; });
    const result = await reviewRequirement({ modelMode: "live", AI: { run }, MODEL_ID: "synthetic", AI_GATEWAY_ID: "synthetic", BUDGET: { idFromName: () => "budget", get: () => ({ reserve: async () => true }) } } as any, "synthetic", { id: "req_1", text: "Verify FAQ schema and use-case links" }, c);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(44000);
    expect(JSON.stringify(deliveryContext(c))).toContain("separately authorized production promotion");
    expect(result.review.gaps).toEqual(["The supplied URLs are production artifacts."]);
  });
  it("keeps explicit DOM metadata and full named-resource text available to the analyst", () => {
    const source = {
      ...document,
      observation: "rendered_dom" as const,
      sourceUrl: "https://example.com/llms.txt",
      content: JSON.stringify({
        status: 200,
        title: "Synthetic site",
        metadata: [
          { name: "description", content: "A distinct purpose" },
          { rel: "canonical", href: "https://example.com/" },
        ],
        text: "Current product messaging for all audiences",
        links: [],
        headings: [],
      }),
    };
    const facts = onlineFacts("Check descriptions and llms.txt", [source]);
    expect(facts[0].metadata[0].content).toBe("A distinct purpose");
    expect(facts[0].resourceText).toContain("all audiences");
  });
  it("does not drop a relevant artifact because it was attached after the first eighteen", () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({
      ...document,
      id: `source_${i}`,
      content: "irrelevant",
    }));
    docs[24].content = "Specific canonical description evidence";
    expect(
      evidenceExcerpts("canonical description evidence", docs).some(
        (e) => e.artifactId === "source_24",
      ),
    ).toBe(true);
  });
  it("records an observed DOM capture with provenance, URL, timestamp and integrity hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ Answer: [{ type: 1, data: "93.184.216.34" }] }),
      }),
    );
    const page = {
      goto: vi.fn().mockResolvedValue({
        status: () => 200,
        headers: () => ({ "content-type": "text/html" }),
      }),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      url: () => "https://example.com/",
      evaluate: vi.fn().mockResolvedValue({
        title: "Synthetic summary",
        metadata: ['<meta name="description" content="Synthetic summary">'],
        headings: [],
        structuredData: [],
        links: [],
        text: "Synthetic delivered summary",
        textTruncated: false,
      }),
      close: vi.fn().mockResolvedValue(undefined).mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue({
        route: vi.fn(),
        newPage: vi.fn().mockResolvedValue(page),
      }),
      close: vi.fn().mockResolvedValue(undefined).mockResolvedValue(undefined),
    };
    vi.mocked(launch).mockResolvedValueOnce(browser as any);
    const c = newCase("correct");
    c.artifacts = [{ ...document, sourceUrl: "https://example.com/" }];
    c.scopes[0].requirements = [
      { id: "req_1", text: "Deliver a public summary" },
    ];
    try {
      const research = await gatherEvidence(
        { modelMode: "live", BROWSER: {}, MODEL_ID: "synthetic" } as any,
        "synthetic",
        c,
      );
      expect(research.sources[0].status).toBe("captured");
      const capture = c.artifacts.at(-1)!;
      expect(capture.observation).toBe("rendered_dom");
      expect(capture.sourceUrl).toBe("https://example.com/");
      expect(capture.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(capture.capturedAt).toBeTruthy();
      expect(c.events.at(-1)?.provenance).toBe("observed");
      expect(browser.close).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("retains the public URL across artifact intake", async () => {
    const c = newCase("correct");
    await addDocuments(c, [
      {
        name: "site",
        content: "Synthetic site",
        mediaType: "text/plain",
        sourceUrl: "https://example.com/",
      },
    ]);
    expect(c.artifacts[0].sourceUrl).toBe("https://example.com/");
    expect(c.events.at(-1)?.provenance).toBe("supplied");
  });
  it("rejects private addresses, credentials, ports, non-HTTPS and write-like routes", () => {
    for (const url of [
      "http://example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://2130706433",
      "https://localhost",
      "https://service.internal",
      "https://user:secret@example.com",
      "https://example.com:8443",
      "https://example.com/delete",
      "https://example.com/?action=unsubscribe",
    ])
      expect(() => publicPage(url)).toThrow();
    expect(publicPage("https://example.com/use-cases/#summary").href).toBe(
      "https://example.com/use-cases/",
    );
  });
  it("makes no online or model calls in offline mode", async () => {
    const run = vi.fn(),
      fetcher = vi.fn();
    const c = newCase("correct");
    c.artifacts = [{ ...document, sourceUrl: "https://example.com" }];
    expect(
      (
        await gatherEvidence(
          {
            modelMode: "offline",
            AI: { run },
            BROWSER: { fetch: fetcher },
          } as any,
          "synthetic",
          c,
        )
      ).sources,
    ).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("explains missing URL and missing Browser Run binding without claiming absence", async () => {
    const c = newCase("correct");
    expect(
      (await gatherEvidence({ modelMode: "live" } as any, "synthetic", c))
        .limitations[0],
    ).toContain("No public artifact URL");
    c.artifacts = [{ ...document, sourceUrl: "https://example.com" }];
    expect(
      (await gatherEvidence({ modelMode: "live" } as any, "synthetic", c))
        .limitations[0],
    ).toContain("not configured");
  });
  it("retrieves relevant content after the old 24,000-character cutoff", () => {
    const a = {
      ...document,
      content:
        "irrelevant filler ".repeat(4000) + "Synthetic delivered summary",
    };
    expect(
      evidenceExcerpts("delivered summary", [a]).some((c) =>
        c.excerpt.includes("Synthetic delivered summary"),
      ),
    ).toBe(true);
  });
  it("validates quotations after JSON and whitespace normalization and rejects fabricated IDs or text", () => {
    const a = {
      ...document,
      content: JSON.stringify({ text: "Synthetic\n delivered summary" }),
    };
    expect(readableContent(a.content)).toContain(
      "Synthetic\n delivered summary",
    );
    expect(verifiedCitations(review, [a])).toHaveLength(1);
    expect(
      verifiedCitations(
        {
          ...review,
          citations: [
            { artifactId: "unknown", quote: review.citations[0].quote },
          ],
        },
        [a],
      ),
    ).toHaveLength(0);
    expect(
      verifiedCitations(
        {
          ...review,
          citations: [
            { artifactId: "source", quote: "Invented search ranking" },
          ],
        },
        [a],
      ),
    ).toHaveLength(0);
  });
  it.each(["fabricated quote", "disagreement", "partial"])(
    "cannot produce supported when there is %s",
    async (reason) => {
      const c = newCase("correct");
      c.scopes[0].requirements = [{ id: "req_1", text: "Deliver a summary" }];
      c.artifacts = [document];
      const analyst =
        reason === "fabricated quote"
          ? {
              ...review,
              citations: [
                { artifactId: "source", quote: "An invented observation" },
              ],
            }
          : reason === "partial"
            ? {
                ...review,
                proposedStatus: "insufficient_evidence",
                gaps: [
                  "A required appendix is missing from available evidence.",
                ],
              }
            : review;
      const run = vi
        .fn()
        .mockResolvedValueOnce({ response: JSON.stringify({ ...analyst, citations: [{ quoteId: reason === "fabricated quote" ? "INVENTED" : "Q1" }] }) })
        .mockResolvedValueOnce({
          model: "synthetic-clef",
          answers: {
            req_1: {
              type: "choice",
              choice: reason === "disagreement" ? "contradicted" : "supported",
              probabilities: {
                supported: reason === "disagreement" ? 0.04 : 0.92,
                contradicted: reason === "disagreement" ? 0.92 : 0.04,
                insufficient_evidence: 0.04,
              },
              confidence: 0.92,
            },
          },
        });
      const result = await assessRequirements(
        {
          modelMode: "live",
          AI: { run },
          AI_GATEWAY_ID: "synthetic",
          MODEL_ID: "synthetic-llama",
          BUDGET: {
            idFromName: () => "budget",
            get: () => ({ reserve: async () => true }),
          },
        } as any,
        "synthetic",
        c,
      );
      expect(result.findings[0].status).toBe("insufficient_evidence");
      expect(result.findings[0].gaps?.length).toBeGreaterThan(0);
    },
  );
});

it("expanded collection reaches thirty pages and records the remaining coverage", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Answer: [{ type: 1, data: "93.184.216.34" }] }) }));
  let activeUrl = "https://example.com/";
  const page = { goto: vi.fn(async (url) => { activeUrl = url; return { status: () => 200, headers: () => ({ "content-type": "text/plain" }) }; }), waitForLoadState: vi.fn().mockResolvedValue(undefined), url: () => activeUrl, evaluate: vi.fn(async () => ({ title: "Synthetic page", metadata: [], headings: [], structuredData: [], links: Array.from({ length: 45 }, (_, i) => ({ url: `https://example.com/page-${i}`, label: "Relevant summary" })), text: "Synthetic summary", textTruncated: false })), close: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(launch).mockResolvedValueOnce({ newContext: async () => ({ route: vi.fn(), newPage: async () => page }), close: vi.fn().mockResolvedValue(undefined) } as any);
  const c = newCase("correct");
  const { defaultEvidencePlan } = await import("../src/shared/investigation");
  c.evidencePlan = { ...defaultEvidencePlan(), coverage: "expanded", targetUrls: ["https://example.com/"] };
  c.scopes[0].requirements = [{ id: "req_1", text: "Verify relevant summary pages" }];
  try {
    const result = await gatherEvidence({ modelMode: "live", BROWSER: {}, MODEL_ID: "synthetic", AI: { run: async () => ({ response: { candidateIds: [0] } }) }, BUDGET: { idFromName: () => "b", get: () => ({ reserve: async () => true }) } } as any, "synthetic", c);
    expect(result.sources.filter((s) => s.status === "captured")).toHaveLength(30);
    expect(result.stopReason).toBe("page_limit"); expect(result.unvisited!.length).toBeGreaterThan(0);
    expect(result.limitations.join(" ")).toContain("not a whole-site audit");
  } finally { vi.unstubAllGlobals(); }
});

it("accepts an initially open accordion whose panel is removed only while collapsed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Answer: [{ type: 1, data: "93.184.216.34" }] }) }));
  const button = { evaluate: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce({ expanded: false, panelPresent: false, visible: false }).mockResolvedValueOnce({ label: "Synthetic question", panelPresent: true, visible: true }).mockResolvedValueOnce(true), getAttribute: vi.fn().mockResolvedValue("true"), click: vi.fn().mockResolvedValue(undefined) };
  const page = { goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({ "content-type": "text/plain" }) }), waitForLoadState: vi.fn().mockResolvedValue(undefined), waitForTimeout: vi.fn().mockResolvedValue(undefined), url: () => "https://example.com/", evaluate: vi.fn().mockResolvedValue({ title: "Synthetic", metadata: [], links: [], text: "Synthetic summary", textTruncated: false }), locator: () => ({ count: async () => 1, nth: () => button }), close: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(launch).mockResolvedValueOnce({ newContext: async () => ({ route: vi.fn(), newPage: async () => page }), close: vi.fn().mockResolvedValue(undefined) } as any);
  const c = newCase("correct"); const { defaultEvidencePlan } = await import("../src/shared/investigation");
  c.evidencePlan = { ...defaultEvidencePlan(), targetUrls: ["https://example.com/"], checks: [{ id: "check_1", requirementId: "req_1", kind: "accordion", url: "https://example.com/", expected: "" }] };
  try { const result = await gatherEvidence({ modelMode: "live", BROWSER: {} } as any, "synthetic", c); expect(result.checks![0].status).toBe("supported"); expect(button.click).toHaveBeenCalledTimes(2); } finally { vi.unstubAllGlobals(); }
});
