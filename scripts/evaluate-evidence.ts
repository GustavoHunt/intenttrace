import { mkdir, writeFile } from "node:fs/promises";
import {
  evaluationCases,
  evaluationCase,
  evaluationScore,
} from "../src/server/evaluation-cases";
import { acceptanceResults, enforceAcceptance } from "../src/server/acceptance";
import type { Finding } from "../src/shared/domain";

const live = process.argv.includes("--live"),
  base = process.env.EVIDENCE_EVAL_URL || "http://127.0.0.1:5173";
let cookie = "";
async function request(path: string, body: unknown) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  cookie ||= response.headers.get("set-cookie")?.split(";")[0] || "";
  const result = (await response.json()) as any;
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
if (live) {
  await request("/api/session", {});
  await request("/api/settings", { clefEnabled: true });
}
const rows = [];
for (const fixture of evaluationCases) {
  let finding: Finding;
  if (live)
    finding = (await request(`/api/evaluations/${fixture.id}`, {})).findings[0];
  else {
    const c = await evaluationCase(fixture.id);
    // A deliberately optimistic classifier exercises deterministic vetoes.
    // Partial requirements use a synthetic analyst verdict; this is not model evaluation.
    const partial = ["partial-delivery", "passing-subcheck"].includes(
      fixture.id,
    );
    finding = enforceAcceptance(
      {
        criterion: "req_1",
        status: partial ? "insufficient_evidence" : "supported",
        explanation: "Synthetic gate input",
        evidenceIds: [],
      },
      acceptanceResults(c),
    );
  }
  rows.push({
    id: fixture.id,
    description: fixture.description,
    expected: fixture.expected,
    actual: finding.status,
    explanation: finding.explanation,
    gaps: finding.gaps,
  });
  console.log(
    `${fixture.id}: ${finding.status} (${finding.status === fixture.expected ? "pass" : "FAIL"})`,
  );
}
const report = {
  generatedAt: new Date().toISOString(),
  mode: live
    ? "live Llama 3.3 + CLEF on synthetic observations; no browser collection"
    : "deterministic gates with synthetic classifier inputs; no model inference",
  ...evaluationScore(rows),
  rows,
};
await mkdir(".local/evaluations", { recursive: true });
await writeFile(
  `.local/evaluations/${live ? "live" : "deterministic"}.json`,
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    accuracy: report.accuracy,
    falseSupport: report.falseSupport,
    passed: report.passed,
  }),
);
if (!report.passed) process.exitCode = 1;
