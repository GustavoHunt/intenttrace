import { z } from "zod";
import {
  artifact,
  event,
  newCase,
  hash,
  type CaseData,
} from "../shared/domain";
import {
  RequirementSchema,
  type Intake,
  type ImportedDocument,
} from "../shared/intake";
import { modelJson } from "./ai";
import type { ModelEnv } from "./settings";

export async function draftRequirements(
  env: ModelEnv,
  sessionId: string,
  input: Omit<Intake, "documents">,
) {
  const messages = input.messages
    .filter((m) => m.role === "user")
    .slice(0, 16)
    .map((m) => ({ ...m, text: m.text.slice(0, 12000) }));
  // Preserve long implementation plans rather than only their opening sentence.
  // A large conversation must be narrowed explicitly, never silently summarized as complete.
  const proposed = await modelJson(
    env,
    sessionId,
    'Extract 1 to 12 concrete, independently testable delivery requirements from the original user request and related user clarifications. Preserve explicit environment and release gates in the requirement text: staging versus production, local versus deployed, draft versus published, pending authorization, advice versus implementation, and features versus measured outcomes. Do not turn staging acceptance into a production-delivery requirement when production promotion is separately authorized. User approval of a quoted implementation plan can supply requirements; assistant claims alone cannot. Split broad compound requests only where the user supplies detail. Ignore unrelated later projects. Return drafts for human review. JSON: {"requirements":[{"id":"req_1","text":"..."}]}.',
    JSON.stringify({ originalPrompt: input.originalPrompt, messages }),
    z.object({ requirements: z.array(RequirementSchema).min(1).max(12) }),
    { maxInputBytes: 150000, maxTokens: 2800 },
  );
  return proposed.requirements.map((r, i) => ({ ...r, id: `req_${i + 1}` }));
}

export async function addDocuments(c: CaseData, documents: ImportedDocument[]) {
  for (const doc of documents) {
    const a = await artifact(doc.name, "document", doc.content);
    a.content = doc.content;
    a.sha256 = await hash(a.content);
    a.mediaType = doc.mediaType;
    a.originalSha256 = doc.originalSha256;
    a.sourceUrl = doc.sourceUrl;
    c.artifacts.push(a);
    event(
      c,
      "evidence",
      `Artifact received: ${doc.name}`,
      "Supplied artifact text. Its hash establishes integrity after receipt, not authenticity or execution.",
      { artifactIds: [a.id], provenance: "supplied" },
    );
  }
}
export async function intakeCase(
  env: ModelEnv,
  sessionId: string,
  input: Intake,
): Promise<CaseData> {
  const { documents, ...intake } = input;
  const c = newCase("correct");
  c.title = input.title;
  c.events = [];
  c.intake = intake;
  const scope = c.scopes[0];
  scope.text = input.originalPrompt.slice(0, 4000);
  scope.provenance = "supplied";
  // Draft only: a person must review and confirm before assessment.
  let requirements = [
    { id: "req_1", text: input.originalPrompt.slice(0, 1000) },
  ];
  if (env.modelMode === "live") {
    try {
      requirements = await draftRequirements(env, sessionId, input);
    } catch {
      intake.warnings = [
        ...intake.warnings.slice(0, 7),
        "AI requirement extraction was unavailable. Edit the original request into testable requirements before confirming.",
      ];
    }
  }
  scope.requirements = requirements;
  event(c, "request", "Original prompt received", scope.text, {
    scopeId: scope.id,
    provenance: "supplied",
  });
  if (input.messages.length) {
    const a = await artifact(
      "conversation.json",
      "document",
      JSON.stringify(
        {
          sourceUrl: input.sourceUrl,
          provider: input.provider,
          messages: input.messages,
        },
        null,
        2,
      ),
    );
    a.content = JSON.stringify(
      {
        sourceUrl: input.sourceUrl,
        provider: input.provider,
        messages: input.messages,
      },
      null,
      2,
    );
    a.sha256 = await hash(a.content);
    a.mediaType = "application/json";
    c.artifacts.push(a);
    event(
      c,
      "evidence",
      "Conversation received",
      `${input.messages.length} supplied messages. Import time is recorded; conversation claims are not verified execution evidence.`,
      { artifactIds: [a.id], provenance: "supplied" },
    );
  }
  await addDocuments(c, documents);
  return c;
}
