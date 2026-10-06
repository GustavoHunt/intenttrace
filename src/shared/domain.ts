import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const date = z.iso.datetime();
export const Scenario = z.enum(["correct", "divergence", "missing"]);
export type Scenario = z.infer<typeof Scenario>;
export const ScopeSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    text: z.string().min(1).max(4000),
    selection: z.enum(["filtered", "project"]),
    excludeNotes: z.boolean(),
    preserveTasks: z.boolean(),
    confirmedAt: date.nullable(),
    provenance: z.enum(["observed", "supplied"]),
  })
  .strict();
export const EventSchema = z
  .object({
    id,
    type: z.enum([
      "request",
      "scope",
      "configuration",
      "execution",
      "evidence",
      "finding",
    ]),
    title: z.string().max(200),
    detail: z.string().max(4000),
    occurredAt: date,
    receivedAt: date,
    sequence: z.number().int().positive(),
    runId: id.optional(),
    scopeId: id.optional(),
    artifactIds: z.array(id).max(10),
    provenance: z.enum(["observed", "supplied"]),
  })
  .strict();
export const TaskSchema = z
  .object({
    id,
    title: z.string().max(200),
    project: z.literal("Atlas"),
    status: z.enum(["open", "closed"]),
    internalNotes: z.string().max(300),
  })
  .strict();
export const ConfigSchema = z
  .object({
    selection: z.enum(["filtered", "project"]),
    includeNotes: z.boolean(),
  })
  .strict();
export const RunSchema = z
  .object({
    id,
    scopeId: id,
    startedAt: date,
    completedAt: date,
    config: ConfigSchema,
    artifactId: id,
    scenario: Scenario,
    modelMode: z.enum(["live", "offline"]),
    operationId: id,
  })
  .strict();
export const ArtifactSchema = z
  .object({
    id,
    name: z.string().max(150),
    kind: z.enum(["snapshot", "export", "configuration"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().max(900000),
  })
  .strict();
export const FindingSchema = z.object({
  criterion: z.enum(["selection", "notes", "unchanged"]),
  status: z.enum(["supported", "contradicted", "insufficient_evidence"]),
  explanation: z.string(),
  evidenceIds: z.array(z.string()),
});
export type Scope = z.infer<typeof ScopeSchema>;
export type EvidenceEvent = z.infer<typeof EventSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Task = z.infer<typeof TaskSchema>;
export const BundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(150),
    scopes: z.array(ScopeSchema).min(1).max(30),
    events: z.array(EventSchema).max(500),
    runs: z.array(RunSchema).max(30),
    artifacts: z.array(ArtifactSchema).max(100),
  })
  .strict();
export type Bundle = z.infer<typeof BundleSchema>;
export type Revision = {
  id: string;
  runId: string;
  evidenceRevision: number;
  createdAt: string;
  findings: Finding[];
  summary: string;
  explanationMode: "live" | "offline" | "unavailable";
  superseded: boolean;
};
export type CaseData = Bundle & {
  id: string;
  scenario: Scenario;
  createdAt: string;
  expiresAt: number;
  revision: number;
  findings: Revision[];
  status: "ready" | "running" | "analysing" | "complete" | "failed";
  error?: string;
  activeWorkflow?: string;
  operations: Record<string, string>;
};
export type CaseView = Omit<CaseData, "artifacts" | "operations"> & {
  artifacts: Omit<Artifact, "content">[];
};
export const viewCase = (c: CaseData): CaseView => {
  const { operations: _, artifacts, ...rest } = c;
  return { ...rest, artifacts: artifacts.map(({ content: __, ...a }) => a) };
};
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const tasks = (): Task[] =>
  Array.from({ length: 24 }, (_, i) => ({
    id: `T-${String(i + 1).padStart(3, "0")}`,
    title:
      [
        "Review export requirements",
        "Implement project filter",
        "Verify CSV encoding",
        "Check accessibility",
        "Review delivery evidence",
        "Update project documentation",
      ][i % 6] + ` ${i + 1}`,
    project: "Atlas",
    status: i < 18 ? "open" : "closed",
    internalNotes: `Synthetic internal note ${i + 1}`,
  }));
export function event(
  c: CaseData,
  type: EvidenceEvent["type"],
  title: string,
  detail: string,
  extra: Partial<EvidenceEvent> = {},
) {
  const e: EvidenceEvent = {
    id: uid(),
    type,
    title,
    detail,
    occurredAt: now(),
    receivedAt: now(),
    sequence: Math.max(0, ...c.events.map((e) => e.sequence)) + 1,
    artifactIds: [],
    provenance: "observed",
    ...extra,
  };
  c.events.push(e);
  return e;
}
export function newCase(scenario: Scenario): CaseData {
  const scope: Scope = {
    id: uid(),
    version: 1,
    text: "Add CSV export for the currently filtered tasks in this project. Exclude internal notes and leave task data unchanged.",
    selection: "filtered",
    excludeNotes: true,
    preserveTasks: true,
    confirmedAt: null,
    provenance: "observed",
  };
  const c: CaseData = {
    schemaVersion: 1,
    id: uid(),
    title: "CSV export / Project Atlas",
    scenario,
    scopes: [scope],
    runs: [],
    events: [],
    artifacts: [],
    findings: [],
    createdAt: now(),
    expiresAt: Date.now() + 86400000,
    revision: 1,
    status: "ready",
    operations: {},
  };
  event(c, "request", "Change request received", scope.text, {
    scopeId: scope.id,
  });
  return c;
}
export async function hash(content: string) {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(d), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function artifact(
  name: string,
  kind: Artifact["kind"],
  value: unknown,
): Promise<Artifact> {
  const content = JSON.stringify(value);
  return { id: uid(), name, kind, content, sha256: await hash(content) };
}
export function validateBundle(b: Bundle) {
  for (const collection of [b.events, b.scopes, b.runs, b.artifacts]) {
    const ids = new Set<string>();
    for (const item of collection) {
      if (ids.has(item.id)) throw new Error("Duplicate record ID");
      ids.add(item.id);
    }
  }
  const scopeIds = new Set(b.scopes.map((s) => s.id)),
    runIds = new Set(b.runs.map((r) => r.id)),
    artIds = new Set(b.artifacts.map((a) => a.id));
  if (new Set(b.scopes.map((s) => s.version)).size !== b.scopes.length)
    throw new Error("Duplicate scope version");
  if (new Set(b.events.map((e) => e.sequence)).size !== b.events.length)
    throw new Error("Duplicate event sequence");
  for (const r of b.runs) {
    if (!scopeIds.has(r.scopeId))
      throw new Error("Run refers to unknown scope");
    if (r.completedAt < r.startedAt)
      throw new Error("Run completion precedes start");
  }
  for (const e of b.events) {
    if (e.scopeId && !scopeIds.has(e.scopeId))
      throw new Error("Event refers to unknown scope");
    if (e.runId && !runIds.has(e.runId))
      throw new Error("Event refers to unknown run");
    if (e.artifactIds.some((a) => !artIds.has(a)))
      throw new Error("Event refers to unknown artifact");
  }
}
export function verify(c: Bundle, runId: string): Finding[] {
  const run = c.runs.find((r) => r.id === runId);
  if (!run) throw new Error("Unknown run");
  const scope = c.scopes.find((s) => s.id === run.scopeId);
  const result = c.artifacts.find((a) => a.id === run.artifactId);
  const events = c.events.filter((e) => e.runId === runId);
  const read = (kind: Artifact["kind"]) => {
    const a = c.artifacts.find(
      (a) =>
        a.kind === kind && events.some((e) => e.artifactIds.includes(a.id)),
    );
    if (!a) return null;
    try {
      return { artifact: a, value: JSON.parse(a.content) };
    } catch {
      return null;
    }
  };
  const snapshot = read("snapshot");
  const evidence = events.filter((e) => e.artifactIds.length).map((e) => e.id);
  const unknown = (criterion: Finding["criterion"], why: string): Finding => ({
    criterion,
    status: "insufficient_evidence",
    explanation: why,
    evidenceIds: evidence,
  });
  const criteria: Finding["criterion"][] = ["selection", "notes", "unchanged"];
  if (!scope?.confirmedAt || scope.confirmedAt > run.startedAt)
    return criteria.map((k) =>
      unknown(k, "No approval linked to this scope version before execution."),
    );
  if (!result || !snapshot)
    return criteria.map((k) =>
      unknown(
        k,
        "The result or before/after snapshot is missing. Execution success alone does not establish scope fulfilment.",
      ),
    );
  let output: unknown;
  try {
    output = JSON.parse(result.content);
  } catch {
    return criteria.map((k) =>
      unknown(k, "The export evidence is not valid JSON."),
    );
  }
  const snap = z
    .object({ before: z.array(TaskSchema), after: z.array(TaskSchema) })
    .safeParse(snapshot.value);
  const rows = z
    .array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          status: z.enum(["open", "closed"]),
          internalNotes: z.string().optional(),
        })
        .strict(),
    )
    .safeParse(output);
  if (!snap.success || !rows.success)
    return criteria.map((k) =>
      unknown(k, "Evidence does not match the supported task-export format."),
    );
  const expected = snap.data.before.filter(
    (t) => scope.selection === "project" || t.status === "open",
  );
  const expectedRows = expected.map(({ id, title, status, internalNotes }) => ({
    id,
    title,
    status,
    ...(!scope.excludeNotes ? { internalNotes } : {}),
  }));
  const sameIds =
    expected.length === rows.data.length &&
    new Set(rows.data.map((t) => t.id)).size === rows.data.length &&
    expected.every((t) =>
      rows.data.some(
        (r) => r.id === t.id && r.title === t.title && r.status === t.status,
      ),
    );
  const noNotes = rows.data.every((r) => !Object.hasOwn(r, "internalNotes"));
  const unchanged =
    JSON.stringify(snap.data.before) === JSON.stringify(snap.data.after);
  const finding = (
    criterion: Finding["criterion"],
    ok: boolean,
    explanation: string,
  ): Finding => ({
    criterion,
    status: ok ? "supported" : "contradicted",
    explanation,
    evidenceIds: evidence,
  });
  return [
    finding(
      "selection",
      sameIds,
      `Approved scope v${scope.version} expects ${expectedRows.length} tasks; observed export contains ${rows.data.length}. ${sameIds ? "Task identities and values match." : "The result differs from the approved selection."}`,
    ),
    finding(
      "notes",
      !scope.excludeNotes || noNotes,
      noNotes
        ? "No internal notes are present in the export."
        : "The export includes internal notes.",
    ),
    finding(
      "unchanged",
      !scope.preserveTasks || unchanged,
      unchanged
        ? "Before and after task snapshots match."
        : "Task data changed during execution.",
    ),
  ];
}
export async function execute(
  c: CaseData,
  scopeId: string,
  config: z.infer<typeof ConfigSchema>,
  mode: "live" | "offline",
  operationId: string,
) {
  const scope = c.scopes.find((s) => s.id === scopeId);
  if (!scope?.confirmedAt) throw new Error("Confirm the scope before running");
  const startedAt = now(),
    runId = uid(),
    before = tasks();
  const actual =
    c.scenario === "divergence"
      ? { ...config, selection: "project" as const }
      : config;
  const selected = before.filter(
    (t) => actual.selection === "project" || t.status === "open",
  );
  const rows = selected.map(({ id, title, status, internalNotes }) => ({
    id,
    title,
    status,
    ...(actual.includeNotes ? { internalNotes } : {}),
  }));
  const cfg = await artifact(
    "export-configuration.json",
    "configuration",
    actual,
  );
  const snapshot = await artifact("task-state.json", "snapshot", {
    before,
    after: before,
  });
  const output = await artifact("atlas-export.json", "export", rows);
  c.artifacts.push(cfg, snapshot);
  if (c.scenario !== "missing") c.artifacts.push(output);
  const run: Run = {
    id: runId,
    scopeId,
    startedAt,
    completedAt: now(),
    config: actual,
    artifactId: output.id,
    scenario: c.scenario,
    modelMode: mode,
    operationId,
  };
  c.runs.push(run);
  event(
    c,
    "configuration",
    "Export configured",
    c.scenario === "divergence"
      ? "Injected demonstration fault: the adapter broadened selection to all project tasks."
      : "Allowlisted configuration applied to the live demo dashboard.",
    { runId, scopeId, artifactIds: [cfg.id] },
  );
  event(
    c,
    "execution",
    `Export completed — ${rows.length} rows`,
    c.scenario === "missing"
      ? "Result evidence intentionally withheld for this demonstration."
      : "Export generated by the working dashboard.",
    {
      runId,
      scopeId,
      artifactIds:
        c.scenario === "missing" ? [snapshot.id] : [snapshot.id, output.id],
    },
  );
  c.revision++;
  return run;
}
export function csv(content: string) {
  const rows = JSON.parse(content) as Record<string, unknown>[];
  const keys = Array.from(new Set(rows.flatMap(Object.keys)));
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return (
      '"' + (/^[=+@\-\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""') + '"'
    );
  };
  return [keys, ...rows.map((r) => keys.map((k) => r[k]))]
    .map((row) => row.map(cell).join(","))
    .join("\r\n");
}
