import { parseHTML } from "linkedom";
import type { Artifact, CaseData, Finding } from "../shared/domain";
import { defaultEvidencePlan, type CheckResult } from "../shared/investigation";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const sameUrl = (a: string, b: string) => {
  try {
    const x = new URL(a),
      y = new URL(b);
    x.hash = y.hash = "";
    return x.href === y.href;
  } catch {
    return false;
  }
};
export function serverHtmlEvidence(html: string) {
  const truncated = html.length > 200000;
  const { document } = parseHTML(html.slice(0, 200000));
  document
    .querySelectorAll("script,style,noscript,svg")
    .forEach((e) => e.remove());
  const raw = norm(
    document.body?.textContent || document.documentElement?.textContent || "",
  );
  return {
    text: raw.slice(0, 22000),
    headings: [...document.querySelectorAll("h1,h2,h3")]
      .map((h) => norm(h.textContent || ""))
      .slice(0, 80),
    truncated: truncated || raw.length > 22000,
  };
}
function pageOf(a: Artifact) {
  try {
    return JSON.parse(a.content);
  } catch {
    return null;
  }
}
export function acceptanceResults(c: CaseData, at = Date.now()): CheckResult[] {
  const plan = c.evidencePlan || defaultEvidencePlan();
  return plan.checks.map((check) => {
    const result: CheckResult = {
      id: check.id,
      requirementId: check.requirementId,
      label: `${check.kind}: ${check.url || check.expected || plan.expectedCommit}`,
      status: "insufficient_evidence",
      explanation:
        "The required source was not captured. Missing or blocked evidence does not establish failed delivery.",
      artifactIds: [],
    };
    if (
      check.url &&
      plan.targetUrls.length &&
      !plan.targetUrls.some(
        (url) => new URL(url).origin === new URL(check.url!).origin,
      )
    )
      return {
        ...result,
        explanation:
          "The check URL belongs to a different origin from the selected environment.",
      };
    const docs = c.artifacts.filter(
      (a) =>
        a.observation && (!check.url || sameUrl(a.sourceUrl || "", check.url)),
    );
    const available = docs.filter(
      (a) =>
        a.capturedAt &&
        at - Date.parse(a.capturedAt) <= plan.maxAgeHours * 3600000 &&
        at >= Date.parse(a.capturedAt) - 60000,
    );
    if (docs.length && !available.length) {
      result.explanation =
        "The available source is stale or has an invalid capture date. Collect current evidence.";
      return result;
    }
    const pairs = available
      .map((a) => ({ a, p: pageOf(a) }))
      .filter(({ p }) => p);
    const finish = (
      ok: boolean,
      explanation: string,
      sources = pairs.map(({ a }) => a.id),
    ) => ({
      ...result,
      status: ok ? ("supported" as const) : ("contradicted" as const),
      explanation,
      artifactIds: sources,
    });
    if (check.kind === "ci") {
      const runs = pairs.filter(({ p }) => p.provider === "github");
      const run =
        runs.find(
          ({ p }) =>
            p.headSha?.toLowerCase() === plan.expectedCommit.toLowerCase(),
        ) || runs[0];
      if (!run) return result;
      if (run.p.headSha?.toLowerCase() !== plan.expectedCommit.toLowerCase())
        return {
          ...result,
          explanation:
            "The observed CI run belongs to a different commit. It cannot verify the requested revision.",
          artifactIds: [run.a.id],
        };
      if (run.p.status !== "completed")
        return {
          ...result,
          explanation: "The matching CI run has not completed.",
          artifactIds: [run.a.id],
        };
      return finish(
        run.p.conclusion === "success",
        `The matching commit's workflow completed with conclusion: ${run.p.conclusion}. This check does not establish deployment or human acceptance.`,
        [run.a.id],
      );
    }
    if (check.kind === "analytics") {
      const reports = pairs.filter(
        ({ p }) =>
          ["posthog", "ga4"].includes(p.provider) &&
          p.startDate === plan.startDate &&
          p.endDate === plan.endDate,
      );
      const matching = reports.flatMap(({ a, p }) =>
        (p.rows || [])
          .filter(
            (r: any) =>
              r.event === check.expected &&
              Number.isFinite(r.count) &&
              r.count > 0,
          )
          .map((r: any) => ({ a, r })),
      );
      if (matching.length)
        return finish(
          true,
          `The selected report records ${matching[0].r.count} occurrences of ${check.expected} in the requested date range. This verifies an aggregate event count, not tracking accuracy, attribution or a conversion funnel.`,
          matching.map(({ a }) => a.id),
        );
      return {
        ...result,
        explanation:
          "The selected report does not establish a positive count for this event and date range. Empty, sampled, thresholded or truncated reports are not proof of no activity.",
        artifactIds: reports.map(({ a }) => a.id),
      };
    }
    const observed = pairs.at(-1);
    if (!observed) return result;
    const { a, p } = observed;
    if ([401, 403, 429].includes(p.status))
      return {
        ...result,
        explanation: `The source returned HTTP ${p.status}; authentication or collection needs attention.`,
        artifactIds: [a.id],
      };
    if (check.kind === "http")
      return finish(
        p.status === Number(check.expected || 200),
        `Observed HTTP ${p.status}; expected ${check.expected || 200}.`,
        [a.id],
      );
    if (p.status !== 200)
      return {
        ...result,
        explanation: `HTTP ${p.status} cannot establish the requested page behavior.`,
        artifactIds: [a.id],
      };
    if (check.kind === "text") {
      const has = norm(p.text || "").includes(norm(check.expected));
      if (!has && p.textTruncated)
        return {
          ...result,
          explanation:
            "Text capture was truncated before the expected content could be established.",
          artifactIds: [a.id],
        };
      return finish(
        has,
        has
          ? `The captured rendered text contains “${check.expected}”.`
          : `The complete rendered text capture does not contain “${check.expected}”.`,
        [a.id],
      );
    }
    if (check.kind === "no_js") {
      if (!p.serverHtml || (p.serverHtml.status !== undefined && p.serverHtml.status !== 200))
        return {
          ...result,
          explanation:
            "The independent server HTML was not captured; rendered DOM cannot prove server-rendered content.",
          artifactIds: [a.id],
        };
      const has = norm(p.serverHtml.text || "").includes(norm(check.expected));
      if (!has && p.serverHtml.truncated)
        return {
          ...result,
          explanation:
            "The independent server HTML was truncated. The expected text is not established.",
          artifactIds: [a.id],
        };
      return finish(
        has,
        has
          ? `The independent HTTP HTML contains “${check.expected}” in a separate read without executing its scripts.`
          : `The complete independent server HTML does not contain “${check.expected}”; rendered DOM alone cannot satisfy this check.`,
        [a.id],
      );
    }
    if (check.kind === "canonical") {
      if (p.metadataTruncated)
        return {
          ...result,
          explanation: "Canonical metadata was truncated.",
          artifactIds: [a.id],
        };
      const canonical =
        p.metadata?.filter((m: any) => m.rel === "canonical") || [];
      return finish(
        canonical.length === 1 &&
          sameUrl(canonical[0].href || "", check.expected || check.url!),
        `Observed canonical: ${canonical.map((m: any) => m.href).join(", ") || "none"}; expected ${check.expected || check.url}.`,
        [a.id],
      );
    }
    if (check.kind === "accordion") {
      if (p.blockedInteractionRequests > 0)
        return {
          ...result,
          explanation:
            "Network requests were blocked during the interaction probe. A control may need those reads, so failure under this constraint cannot establish failed delivery.",
          artifactIds: [a.id],
        };
      const probes = p.accordionChecks;
      if (!probes?.length)
        return {
          ...result,
          explanation:
            "No bounded accordion interaction was captured. This does not establish full accessibility conformance.",
          artifactIds: [a.id],
        };
      const failed = probes.filter(
        (x: any) => !x.toggled || !x.panelPresent || !x.visibleWhenExpanded,
      );
      return finish(
        !failed.length,
        `Checked ${probes.length} accordion controls for state change, a real controlled panel and visible expanded content.${failed.length ? " Failed: " + failed.map((x: any) => `${x.label || "Unnamed control"} (${!x.toggled ? "state did not change" : !x.panelPresent ? "expanded panel absent" : "expanded content not visible"})`).join("; ") + "." : " All inspected controls passed."} Keyboard and full accessibility conformance remain outside this check.`,
        [a.id],
      );
    }
    if (check.kind === "faq") {
      const answers: string[] = [];
      const walk = (v: any) => {
        if (!v || typeof v !== "object") return;
        if (v.acceptedAnswer?.text)
          answers.push(
            norm(
              parseHTML(`<body>${v.acceptedAnswer.text}</body>`).document.body
                .textContent || v.acceptedAnswer.text,
            ),
          );
        for (const val of Object.values(v))
          if (typeof val === "object")
            Array.isArray(val) ? val.forEach(walk) : walk(val);
      };
      for (const raw of p.structuredData || []) {
        try {
          walk(JSON.parse(raw));
        } catch {}
      }
      if (
        !answers.length ||
        !p.serverHtml ||
        (p.serverHtml.status !== undefined && p.serverHtml.status !== 200) ||
        p.serverHtml.truncated ||
        p.structuredDataTruncated
      )
        return {
          ...result,
          explanation:
            "Complete FAQ structured data and independent server HTML are required for this comparison.",
          artifactIds: [a.id],
        };
      const missing = answers.filter(
        (answer) => !norm(p.serverHtml.text).includes(answer),
      );
      return finish(
        !missing.length,
        missing.length
          ? `${missing.length} of ${answers.length} structured FAQ answers do not match text in the independent server HTML.`
          : `All ${answers.length} structured FAQ answers match text in the independent server HTML. This does not verify a shared pricing formatter.`,
        [a.id],
      );
    }
    if (check.kind === "hreflang") {
      const alternates = (p.metadata || []).filter(
        (m: any) => m.hreflang && m.hreflang !== "x-default" && m.href,
      );
      if (p.metadataTruncated)
        return {
          ...result,
          explanation: "Language metadata was truncated.",
          artifactIds: [a.id],
        };
      if (alternates.length < 2)
        return finish(
          false,
          "Fewer than two language alternatives were present in the captured metadata.",
          [a.id],
        );
      const all = c.artifacts
        .filter(
          (a) =>
            a.observation &&
            a.capturedAt &&
            at - Date.parse(a.capturedAt) <= plan.maxAgeHours * 3600000,
        )
        .map((a) => ({ a, p: pageOf(a) }));
      const targets = alternates.map((link: any) =>
        all.find(({ a }) => sameUrl(a.sourceUrl || "", link.href)),
      );
      if (
        targets.some(
          (t: any) => !t || t.p?.status !== 200 || t.p?.metadataTruncated,
        )
      )
        return {
          ...result,
          explanation:
            "Not every language alternative was captured successfully with complete metadata; reciprocity is unverified.",
          artifactIds: [a.id],
        };
      const reciprocal = targets.every((t: any) =>
        t.p.metadata?.some(
          (m: any) => m.hreflang && sameUrl(m.href || "", check.url!),
        ),
      );
      return finish(
        reciprocal,
        reciprocal
          ? "Captured language alternatives link back to the checked page."
          : "A captured language alternative does not link back to the checked page.",
        [a.id, ...targets.map((t: any) => t.a.id)],
      );
    }
    return result;
  });
}
export function enforceAcceptance(
  finding: Finding,
  checks: CheckResult[],
): Finding {
  const relevant = checks.filter((c) => c.requirementId === finding.criterion);
  if (!relevant.length) return finding;
  const failed = relevant.filter((c) => c.status === "contradicted"),
    unknown = relevant.filter((c) => c.status === "insufficient_evidence");
  return {
    ...finding,
    status: failed.length
      ? "contradicted"
      : unknown.length
        ? "insufficient_evidence"
        : finding.status,
    explanation:
      (failed.length
        ? "An explicit acceptance check failed. "
        : unknown.length
          ? "An explicit acceptance check remains unverified. "
          : "") + finding.explanation,
    observations: [
      ...relevant
        .filter((c) => c.status === "supported")
        .map((c) => c.explanation),
      ...(finding.observations || []),
    ],
    gaps: [
      ...failed.concat(unknown).map((c) => c.explanation),
      ...(finding.gaps || []),
    ],
  };
}
