import type { Artifact, CaseData } from "../shared/domain";
import { defaultEvidencePlan } from "../shared/investigation";

export function evidenceBoundary(c: CaseData, at = Date.now()) {
  const plan = c.evidencePlan || defaultEvidencePlan();
  const origins = new Set(plan.targetUrls.map((url) => new URL(url).origin));
  const excluded: { artifactId: string; reason: string }[] = [];
  const documents = c.artifacts.filter((a) => {
    if (a.kind !== "document" || a.name === "conversation.json") return false;
    if (!a.observation) return true;
    if (
      !a.capturedAt ||
      !Number.isFinite(Date.parse(a.capturedAt)) ||
      at - Date.parse(a.capturedAt) > plan.maxAgeHours * 3600000 ||
      Date.parse(a.capturedAt) > at + 60000
    ) {
      excluded.push({
        artifactId: a.id,
        reason: "Stale or invalid capture date",
      });
      return false;
    }
    if (
      origins.size &&
      a.observation === "rendered_dom" &&
      (!a.sourceUrl || !origins.has(new URL(a.sourceUrl).origin))
    ) {
      excluded.push({
        artifactId: a.id,
        reason: "Different origin from the explicitly selected environment",
      });
      return false;
    }
    return true;
  });
  const missingTarget =
    origins.size > 0 &&
    !documents.some(
      (a) =>
        a.observation === "rendered_dom" &&
        a.sourceUrl &&
        origins.has(new URL(a.sourceUrl).origin),
    );
  return {
    documents,
    excluded,
    missingTarget,
    context: {
      environment: plan.environment,
      targetUrls: plan.targetUrls,
      maxAgeHours: plan.maxAgeHours,
      expectedCommit: plan.expectedCommit,
      startDate: plan.startDate,
      endDate: plan.endDate,
      excluded,
      warning:
        "The environment is user-declared; host matching does not prove release identity. CI is tied to the selected commit; analytics is tied to the explicit property and date range.",
    },
  };
}
