import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultEvidencePlan,
  EvidencePlanSchema,
  ConnectionSchema,
  connectionView,
  coverageLimits,
} from "../src/shared/investigation";
import {
  credentialHeaders,
  collectProviderEvidence,
  validateConnection,
  redactCredentials,
} from "../src/server/provider-evidence";
import {
  sealConnections,
  openConnections,
} from "../src/server/connection-vault";
import {
  acceptanceResults,
  serverHtmlEvidence,
  enforceAcceptance,
} from "../src/server/acceptance";
import { evidenceBoundary } from "../src/server/evidence-boundary";
import {
  evaluationCase,
  evaluationCases,
} from "../src/server/evaluation-cases";
import { newCase, caseManifest, type Finding } from "../src/shared/domain";

const access = {
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  provider: "cloudflare_access" as const,
  label: "Synthetic staging",
  origin: "https://staging.example.com",
  clientId: "synthetic-client",
  secret: "synthetic-secret",
};
afterEach(() => vi.unstubAllGlobals());
describe("private evidence boundaries", () => {
  it("seals credentials and rejects another session key", async () => {
    const sealed = await sealConnections("session-a", [access]);
    expect(JSON.stringify(sealed)).not.toContain(access.secret);
    expect(await openConnections("session-a", sealed)).toEqual([access]);
    await expect(openConnections("session-b", sealed)).rejects.toThrow();
    expect(JSON.stringify(connectionView(access))).not.toContain(access.secret);
  });
  it("sends service tokens only to the exact configured origin and redacts reflected values", () => {
    const inherited = {
      Authorization: "inherited",
      "CF-Access-Client-Secret": "inherited",
      Accept: "text/html",
    };
    expect(
      credentialHeaders(access.origin + "/page", [access], inherited)[
        "CF-Access-Client-Secret"
      ],
    ).toBe(access.secret);
    for (const url of [
      "https://example.com",
      "https://staging.example.com.attacker.invalid",
      "https://sub.staging.example.com",
    ])
      expect(credentialHeaders(url, [access], inherited)).toEqual({
        Accept: "text/html",
      });
    expect(
      redactCredentials(`${access.secret} ${access.clientId}`, [access]),
    ).toBe("[credential redacted] [credential redacted]");
    expect(() =>
      validateConnection({ ...access, origin: access.origin + "/path" }),
    ).toThrow();
    expect(() =>
      validateConnection({ ...access, secret: "bad\r\nheader" }),
    ).toThrow();
  });
  it("reads exact GitHub run and bounded jobs without retaining credentials or user records", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: 123,
          repository: { full_name: "synthetic/example" },
          head_sha: "a".repeat(40),
          status: "completed",
          conclusion: "success",
          actor: { email: "private@example.com" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          jobs: [{ name: "build", status: "completed", conclusion: "success" }],
          total_count: 1,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const c = newCase("correct");
    c.artifacts = [];
    const sources = await collectProviderEvidence(c, [
      {
        ...access,
        provider: "github",
        repository: "synthetic/example",
        runId: "123",
      },
    ]);
    expect(sources[0].status).toBe("captured");
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/synthetic/example/actions/runs/123",
    );
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    expect(JSON.stringify(c)).not.toContain(access.secret);
    expect(JSON.stringify(c)).not.toContain("private@example.com");
    expect(JSON.parse(c.artifacts[0].content).headSha).toBe("a".repeat(40));
  });
  it.each(["posthog", "search_console", "ga4"] as const)(
    "uses a fixed, date-scoped aggregate query for %s",
    async (provider) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          Response.json(
            provider === "posthog"
              ? { results: [["signup", 2]] }
              : { rows: [] },
          ),
        );
      vi.stubGlobal("fetch", fetcher);
      const c = newCase("correct");
      c.evidencePlan = {
        ...defaultEvidencePlan(),
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      };
      const connection = {
        ...access,
        provider,
        region: "eu",
        projectId: "123",
        propertyId: "456",
        site: "https://example.com/",
      } as any;
      const result = await collectProviderEvidence(c, [connection]);
      expect(result[0].status).toBe("captured");
      const request = fetcher.mock.calls[0][1];
      expect(request.method).toBe("POST");
      expect(request.body).toContain("2026-01-01");
      expect(request.body).not.toContain(access.secret);
      expect(JSON.parse(c.artifacts.at(-1)!.content).boundary).toBeTruthy();
    },
  );
  it("explains access failure without leaking provider response content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(access.secret, { status: 403 })),
    );
    const c = newCase("correct");
    const result = await collectProviderEvidence(c, [
      {
        ...access,
        provider: "github",
        repository: "synthetic/example",
        runId: "123",
      },
    ]);
    expect(result[0].detail).toContain("Access denied");
    expect(JSON.stringify(result)).not.toContain(access.secret);
  });
  it("requires dates before calling an analytics provider", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await collectProviderEvidence(newCase("correct"), [
      { ...access, provider: "ga4", propertyId: "123" },
    ]);
    expect(result[0].detail).toContain("Choose an explicit");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("assessment quality gates", () => {
  it.each(evaluationCases)(
    "$id has the expected bounded verdict",
    async (fixture) => {
      const c = await evaluationCase(fixture.id);
      const partial = ["partial-delivery", "passing-subcheck"].includes(
        fixture.id,
      );
      const model: Finding = {
        criterion: "req_1",
        status: partial ? "insufficient_evidence" : "supported",
        explanation: "Synthetic model input",
        evidenceIds: [],
      };
      expect(enforceAcceptance(model, acceptanceResults(c)).status).toBe(
        fixture.expected,
      );
    },
  );
  it("excludes stale and wrong-environment observations from analyst context", async () => {
    for (const id of ["wrong-environment", "stale-source"]) {
      const c = await evaluationCase(id),
        result = evidenceBoundary(c);
      expect(result.documents).toHaveLength(0);
      expect(result.missingTarget).toBe(true);
      expect(result.excluded).toHaveLength(1);
    }
  });
  it("a check against another environment cannot contradict the target", async () => {
    const c = await evaluationCase("visible-delivery");
    c.evidencePlan!.checks[0].url = "https://production.example.com/";
    expect(acceptanceResults(c)[0]).toMatchObject({
      status: "insufficient_evidence",
      explanation: expect.stringContaining("different origin"),
    });
  });
  it("distinguishes server HTML from rendered text and applies source integrity storage manifests", async () => {
    const c = await evaluationCase("visible-delivery");
    c.evidencePlan!.checks[0].kind = "no_js";
    const html = serverHtmlEvidence(
      "<html><body><h1>Project summary delivered</h1><script>secret instructions</script></body></html>",
    );
    expect(html.text).toBe("Project summary delivered");
    c.artifacts[0].content = JSON.stringify({ status: 200, serverHtml: html });
    expect(acceptanceResults(c)[0].status).toBe("supported");
    const manifest = caseManifest(c);
    expect(manifest.artifacts[0].content).toBe("");
    expect(manifest.artifacts[0].sha256).toBe(c.artifacts[0].sha256);
    expect(c.artifacts[0].content).not.toBe("");
  });
  it("does not promote a whole finding when an explicit subcheck passes", async () => {
    const c = await evaluationCase("passing-subcheck");
    expect(acceptanceResults(c)[0].status).toBe("supported");
    expect(
      enforceAcceptance(
        {
          criterion: "req_1",
          status: "insufficient_evidence",
          explanation: "Missing analytics",
          evidenceIds: [],
        },
        acceptanceResults(c),
      ).status,
    ).toBe("insufficient_evidence");
  });
  it("rejects invalid plans and keeps expanded coverage bounded", () => {
    for (const value of [
      { startDate: "2026-02-30", endDate: "2026-03-01" },
      { checks: [{ id: "check_1", requirementId: "req_1", kind: "ci" }] },
      {
        checks: [
          {
            id: "check_1",
            requirementId: "req_1",
            kind: "text",
            expected: "hello",
          },
        ],
      },
      { maxAgeHours: 0 },
    ])
      expect(EvidencePlanSchema.safeParse(value).success).toBe(false);
    expect(coverageLimits("expanded")).toEqual({
      pages: 30,
      rounds: 6,
      milliseconds: 300000,
    });
    expect(
      ConnectionSchema.safeParse({
        ...access,
        provider: "github",
        repository: "../../bad",
        runId: "1",
      }).success,
    ).toBe(false);
  });
});

it("checks FAQ parity, canonical uniqueness and reciprocal language evidence conservatively", async () => {
  const c = await evaluationCase("visible-delivery");
  const page = {
    status: 200,
    metadata: [{ rel: "canonical", href: "https://staging.example.com/" }],
    serverHtml: { text: "A useful answer", truncated: false },
    structuredData: [
      JSON.stringify({
        "@type": "FAQPage",
        mainEntity: [{ acceptedAnswer: { text: "A useful answer" } }],
      }),
    ],
  };
  c.artifacts[0].content = JSON.stringify(page);
  c.evidencePlan!.checks[0].expected = "";
  c.evidencePlan!.checks[0].kind = "faq";
  expect(acceptanceResults(c)[0].status).toBe("supported");
  page.serverHtml.text = "Different content";
  c.artifacts[0].content = JSON.stringify(page);
  expect(acceptanceResults(c)[0].status).toBe("contradicted");
  c.evidencePlan!.checks[0].kind = "canonical";
  expect(acceptanceResults(c)[0].status).toBe("supported");
  page.metadata.push({
    rel: "canonical",
    href: "https://staging.example.com/",
  });
  c.artifacts[0].content = JSON.stringify(page);
  expect(acceptanceResults(c)[0].status).toBe("contradicted");
  c.evidencePlan!.checks[0].kind = "hreflang";
  c.artifacts[0].content = JSON.stringify({
    status: 200,
    metadata: [
      { hreflang: "en", href: "https://staging.example.com/" },
      { hreflang: "es", href: "https://staging.example.com/es/" },
    ],
  });
  expect(acceptanceResults(c)[0].status).toBe("insufficient_evidence");
  c.artifacts.push({
    ...c.artifacts[0],
    id: "spanish",
    sourceUrl: "https://staging.example.com/es/",
  });
  expect(acceptanceResults(c)[0].status).toBe("supported");
});
it("ties aggregate counts to explicit dates and keeps zero or missing data unknown", async () => {
  const c = await evaluationCase("wrong-commit");
  c.evidencePlan!.startDate = "2026-01-01";
  c.evidencePlan!.endDate = "2026-01-02";
  c.evidencePlan!.checks[0] = {
    id: "check_1",
    requirementId: "req_1",
    kind: "analytics",
    expected: "signup",
  };
  const report = {
    provider: "ga4",
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    rows: [{ event: "signup", count: 0 }],
  };
  c.artifacts[0].content = JSON.stringify(report);
  expect(acceptanceResults(c)[0].status).toBe("insufficient_evidence");
  report.rows[0].count = 7;
  c.artifacts[0].content = JSON.stringify(report);
  expect(acceptanceResults(c)[0].status).toBe("supported");
  report.endDate = "2026-01-03";
  c.artifacts[0].content = JSON.stringify(report);
  expect(acceptanceResults(c)[0].status).toBe("insufficient_evidence");
});

it("keeps a network-constrained interaction unknown and retains direct failures when a model is unavailable", async () => {
  const c = await evaluationCase("failed-behavior");
  const fallback: Finding = {
    criterion: "req_1",
    status: "insufficient_evidence",
    explanation: "Model allowance reached",
    evidenceIds: [],
  };
  expect(enforceAcceptance(fallback, acceptanceResults(c)).status).toBe(
    "contradicted",
  );
  c.artifacts[0].content = JSON.stringify({
    ...JSON.parse(c.artifacts[0].content),
    blockedInteractionRequests: 1,
  });
  expect(enforceAcceptance(fallback, acceptanceResults(c)).status).toBe(
    "insufficient_evidence",
  );
});
