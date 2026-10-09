import { ARTIFACT_BYTES, CAPTURE_BYTES, CASE_BODY_BYTES, SNAPSHOT_BYTES, byteLength, assertCaseBodies, assertSnapshot, boundedStoredText, deleteCaseEvidence } from "./evidence-limits";
import { enforceAcceptance } from "./acceptance";
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName, routeAgentRequest } from "agents";
import { parseProtocolMessage } from "agents/chat";
import { investigationStream } from "./chat-stream";
import { z } from "zod";
import {
  BundleSchema,
  ConfigSchema,
  Scenario,
  ScopeSchema,
  artifact,
  csv,
  event,
  execute,
  hash,
  newCase,
  now,
  tasks,
  uid,
  validateBundle,
  verify,
  viewCase,
  caseManifest,
  type Bundle,
  type CaseData,
  type CaseView,
  type Finding,
  type Revision,
} from "../shared/domain";
import {
  cookie,
  HttpError,
  json,
  readJson,
  sameOrigin,
  signSession,
  verifySession,
} from "./security";
import { Answer, grounded, modelJson } from "./ai";
import { answerInvestigation } from "./chat";
import { installationCheck } from "./install-check";
import {
  IntakeSchema,
  DocumentSchema,
  RequirementSchema,
  type Requirement,
  type ImportedDocument,
} from "../shared/intake";
import { intakeCase, addDocuments, draftRequirements } from "./intake-case";
import { assessRequirements } from "./clef";
import { gatherEvidence } from "./research";
import { ConnectionSchema, EvidencePlanSchema, connectionView, type EvidenceConnection, type EvidencePlan } from "../shared/investigation";
import { sealConnections, openConnections } from "./connection-vault";
import { validateConnection } from "./provider-evidence";
import { publicPage } from "./public-network";
import {
  SettingsSchema,
  defaultSettings,
  type AppSettings,
  type ModelMode,
} from "../shared/settings";
import { aiAvailable, settingsView, withSettings } from "./settings";

type InvestigationInput = {
  agentName: string;
  runId: string;
  revision: number;
  modelMode: ModelMode;
};

export interface Env {
  AI?: Ai;
  BROWSER?: Fetcher;
  INSTALL_RELEASE?: string;
  MODEL_ID: string;
  CLEF_MODEL_ID?: string;
  LOCAL_DEVELOPMENT?: string;
  AI_GATEWAY_ID: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  SESSION_SIGNING_SECRET?: string;
  SESSION_MODEL_LIMIT: string;
  DAILY_MODEL_LIMIT: string;
  ASSETS: Fetcher;
  EVIDENCE: R2Bucket;
  CaseAgent: DurableObjectNamespace<CaseAgent>;
  SESSIONS: DurableObjectNamespace<SessionRegistry>;
  BUDGET: DurableObjectNamespace<BudgetGuard>;
  INVESTIGATE: Workflow<InvestigationInput>;
  RATE_LIMITER?: RateLimit;
}
export class BudgetGuard extends DurableObject<Env> {
  async reserve(sessionId: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const day = new Date().toISOString().slice(0, 10);
      const data = (await this.ctx.storage.get<{
        day: string;
        total: number;
        sessions: Record<string, number>;
      }>("budget")) || { day, total: 0, sessions: {} };
      if (data.day !== day) {
        data.day = day;
        data.total = 0;
        data.sessions = {};
      }
      if (
        !Number.isSafeInteger(Number(this.env.DAILY_MODEL_LIMIT)) ||
        !Number.isSafeInteger(Number(this.env.SESSION_MODEL_LIMIT))
      )
        return false;
      if (
        data.total >= Number(this.env.DAILY_MODEL_LIMIT) ||
        (data.sessions[sessionId] || 0) >= Number(this.env.SESSION_MODEL_LIMIT)
      )
        return false;
      data.total++;
      data.sessions[sessionId] = (data.sessions[sessionId] || 0) + 1;
      await this.ctx.storage.put("budget", data);
      return true;
    });
  }
}
type SessionRecord = {
  id: string;
  expiresAt: number;
  cases: { id: string; title: string; createdAt: string }[];
  settings?: AppSettings;
};
export class SessionRegistry extends DurableObject<Env> {
  async localKey() {
    return this.ctx.blockConcurrencyWhile(async () => {
      let k = await this.ctx.storage.get<string>("key");
      if (!k) {
        k = uid() + uid();
        await this.ctx.storage.put("key", k);
      }
      return k;
    });
  }
  async init(id: string) {
    const record: SessionRecord = {
      id,
      expiresAt: Date.now() + 86400000,
      cases: [],
      settings: { ...defaultSettings },
    };
    await this.ctx.storage.put("session", record);
    await this.ctx.storage.setAlarm(record.expiresAt);
    return record;
  }
  async get() {
    const r = await this.ctx.storage.get<SessionRecord>("session");
    if (!r || r.expiresAt <= Date.now())
      throw new HttpError(401, "Session expired");
    return r;
  }
  async add(c: { id: string; title: string; createdAt: string }) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const r = await this.get();
      if (r.cases.length >= 5)
        throw new HttpError(
          429,
          "Five cases per session. Delete a case before creating another.",
        );
      r.cases.push(c);
      await this.ctx.storage.put("session", r);
    });
  }
  async settings() {
    return (await this.get()).settings || { ...defaultSettings };
  }
  async connections(): Promise<EvidenceConnection[]> {
    await this.get();
    return openConnections(await this.localKey(), await this.ctx.storage.get("connections"));
  }
  async listConnections() { return (await this.connections()).map(connectionView); }
  async addConnection(input: unknown) {
    const value = ConnectionSchema.parse(input);
    const record = { ...value, id: uid(), createdAt: now() };
    try { validateConnection(record); } catch (e) { throw new HttpError(400, (e as Error).message); }
    return this.ctx.blockConcurrencyWhile(async () => {
      const records = await this.connections();
      if (records.length >= 6) throw new HttpError(429, "Six connections per session; disconnect one before adding another.");
      records.push(record);
      await this.ctx.storage.put("connections", await sealConnections(await this.localKey(), records));
      return connectionView(record);
    });
  }
  async removeConnection(id: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const records = await this.connections();
      await this.ctx.storage.put("connections", await sealConnections(await this.localKey(), records.filter((c) => c.id !== id)));
      return { disconnected: true };
    });
  }
  async updateSettings(settings: AppSettings) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const r = await this.get();
      if (settings.clefEnabled && !aiAvailable(this.env))
        throw new HttpError(
          503,
          "Configure Workers AI and AI Gateway before enabling Clef. See the local setup instructions.",
        );
      r.settings = SettingsSchema.parse(settings);
      await this.ctx.storage.put("session", r);
      return r.settings;
    });
  }
  async remove(id: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const r = await this.get();
      r.cases = r.cases.filter((c) => c.id !== id);
      await this.ctx.storage.put("session", r);
    });
  }
  async alarm() {
    const r = await this.ctx.storage.get<SessionRecord>("session");
    if (r) {
      for (const c of r.cases) {
        const a = await getAgentByName(this.env.CaseAgent, `${r.id}_${c.id}`);
        await a.purge();
      }
    }
    await this.ctx.storage.deleteAll();
  }
}

export class CaseAgent extends AIChatAgent<
  Env,
  { revision: number; status: string; updatedAt: string }
> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const receive = this.onMessage.bind(this);
    let windowStart = Date.now();
    let messages = 0;
    this.onMessage = async (connection, message) => {
      if (
        typeof message !== "string" ||
        new TextEncoder().encode(message).length > 100000
      ) {
        connection.close(1009, "Message exceeds the demo limit");
        return;
      }
      if (Date.now() - windowStart > 60000) {
        windowStart = Date.now();
        messages = 0;
      }
      if (++messages > 120) {
        connection.close(1013, "Please wait before reconnecting");
        return;
      }
      try {
        const frame = parseProtocolMessage(message);
        const incoming =
          frame?.type === "chat-request"
            ? JSON.parse(frame.init.body || "{}").messages
            : frame?.type === "messages"
              ? frame.messages
              : undefined;
        if (incoming !== undefined) {
          z.array(
            z.object({
              id: z.string().max(100),
              role: z.enum(["user", "assistant"]),
              parts: z
                .array(
                  z.object({
                    type: z.literal("text"),
                    text: z.string().max(10000),
                  }),
                )
                .max(20),
            }),
          )
            .max(100)
            .parse(incoming);
          if (
            incoming.some(
              (m: { role: string; parts: { text: string }[] }) =>
                m.role === "user" &&
                m.parts.reduce((n, p) => n + p.text.length, 0) > 2000,
            )
          )
            throw new Error("Long message");
        }
      } catch {
        connection.close(1008, "Invalid or oversized chat history");
        return;
      }
      try {
        await this.data(false);
      } catch {
        connection.close(1008, "Case expired or deleted");
        return;
      }
      return receive(connection, message);
    };
  }
  initialState = { revision: 0, status: "ready", updatedAt: now() };
  private mutex: Promise<unknown> = Promise.resolve();
  private expiryScheduled = false;
  private async scheduleCaseExpiry(c: CaseData) {
    if (this.expiryScheduled) return;
    // Use the Agent scheduler: raw setAlarm competes with chat recovery jobs.
    await this.schedule(new Date(Math.ceil(c.expiresAt / 1000) * 1000), "caseExpiryWake", null, { idempotent: true });
    this.expiryScheduled = true;
  }
  async caseExpiryWake() {
    // alarm() checks expiry before dispatch, so cleanup cannot delete the
    // scheduler's tables while it is still processing a callback.
  }
  private storedCase(): CaseData | undefined {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS intenttrace_case (id INTEGER PRIMARY KEY, data TEXT NOT NULL)",
    );
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM intenttrace_case WHERE id=1")
      .toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(fn, fn);
    this.mutex = next.catch(() => {});
    return next;
  }
  async init(c: CaseData, sessionId: string) {
    return this.locked(async () => {
      if (await this.ctx.storage.get<boolean>("deleting")) throw new HttpError(404, "Case unavailable or expired");
      if (this.storedCase()) throw new HttpError(409, "Case already exists");
      await this.ctx.storage.put("sessionId", sessionId);
      await this.save(c);
      await this.scheduleCaseExpiry(c);
      return viewCase(c);
    });
  }
  async data(hydrate = true) {
    const c = this.storedCase();
    if (!c || c.expiresAt <= Date.now() || await this.ctx.storage.get<boolean>("deleting"))
      throw new HttpError(404, "Case unavailable or expired");
    await this.scheduleCaseExpiry(c);
    if (hydrate) {
      let remaining = CASE_BODY_BYTES;
      for (const a of c.artifacts) {
        if (a.contentStored) {
          const stored = await this.env.EVIDENCE.get(`${this.name}/${a.id}`);
          if (!stored) throw new HttpError(409, "A stored capture is unavailable. Existing findings are preserved.");
          a.content = await boundedStoredText(stored, Math.min(remaining, a.observation ? CAPTURE_BYTES : ARTIFACT_BYTES));
          if (await hash(a.content) !== a.sha256) throw new HttpError(409, "Stored capture integrity check failed.");
          delete a.contentStored;
        }
        remaining -= byteLength(a.content);
        if (remaining < 0) throw new HttpError(413, "Case evidence bodies exceed the size limit. Create a smaller case.");
      }
      assertCaseBodies(c.artifacts);
    }
    return c;
  }
  async details() {
    return viewCase(await this.data(false));
  }
  private async save(c: CaseData) {
    if (await this.ctx.storage.get<boolean>("deleting")) throw new HttpError(404, "Case unavailable or expired");
    assertCaseBodies(c.artifacts);
    const encoded = JSON.stringify(caseManifest(c));
    if (new TextEncoder().encode(encoded).length > 2097152)
      throw new HttpError(413, "Case storage limit reached");
    const previous = new Set(this.storedCase()?.artifacts.map((a) => a.id) || []);
    try {
      for (const a of c.artifacts) await this.env.EVIDENCE.put(`${this.name}/${a.id}`, a.content);
      this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO intenttrace_case(id,data) VALUES(1,?)",
      encoded,
      );
    } catch (error) {
      const uncommitted = c.artifacts.filter((a) => !previous.has(a.id)).map((a) => `${this.name}/${a.id}`);
      if (uncommitted.length) await this.env.EVIDENCE.delete(uncommitted);
      throw error;
    }
    this.setState({ revision: c.revision, status: c.status, updatedAt: now() });
  }
  async confirm(selection: "filtered" | "project") {
    return this.locked(async () => {
      const c = await this.data();
      if (c.intake)
        throw new HttpError(409, "Review this case's requirements instead.");
      if (c.status === "running" || c.status === "analysing")
        throw new HttpError(409, "Wait for the current operation");
      let scope = c.scopes.at(-1)!;
      if (scope.confirmedAt) {
        if (c.scopes.length >= 30)
          throw new HttpError(429, "Scope version limit reached");
        scope = {
          ...scope,
          id: uid(),
          version: scope.version + 1,
          selection,
          text:
            selection === "project"
              ? "Export all project tasks. Exclude internal notes and leave task data unchanged."
              : "Add CSV export for the currently filtered tasks in this project. Exclude internal notes and leave task data unchanged.",
          confirmedAt: now(),
          provenance: "observed",
        };
        c.scopes.push(scope);
      } else {
        scope.selection = selection;
        if (selection === "project")
          scope.text =
            "Export all project tasks. Exclude internal notes and leave task data unchanged.";
        scope.confirmedAt = now();
      }
      event(c, "scope", `Scope v${scope.version} confirmed`, scope.text, {
        scopeId: scope.id,
      });
      c.revision++;
      await this.save(c);
      return viewCase(c);
    });
  }
  async run(operationId: string) {
    const start = await this.locked(async () => {
      const c = await this.data();
      if (c.intake)
        throw new HttpError(
          409,
          "Assess the supplied artifacts instead of running the CSV example.",
        );
      if (c.operations[operationId]) return { duplicate: true, c };
      if (c.status === "running" || c.status === "analysing")
        throw new HttpError(409, "An operation is already active");
      const scope = c.scopes.at(-1)!;
      if (!scope.confirmedAt)
        throw new HttpError(409, "Confirm the scope before running");
      if (c.runs.length >= 30) throw new HttpError(429, "Run limit reached");
      c.status = "running";
      c.operations[operationId] = "pending";
      await this.save(c);
      return { duplicate: false, c };
    });
    if (start.duplicate) return viewCase(start.c);
    try {
      const scope = start.c.scopes.at(-1)!;
      const sessionId = (await this.ctx.storage.get<string>("sessionId"))!;
      const env = withSettings(
        this.env,
        await this.env.SESSIONS.get(
          this.env.SESSIONS.idFromName(sessionId),
        ).settings(),
      );
      const config =
        env.modelMode === "offline"
          ? { selection: scope.selection, includeNotes: !scope.excludeNotes }
          : await modelJson(
              env,
              sessionId,
              'Propose bounded export configuration. JSON: {"selection":"filtered"|"project","includeNotes":boolean}.',
              JSON.stringify({ approvedScope: scope }),
              ConfigSchema,
            );
      const result = await this.locked(async () => {
        const c = await this.data();
        const run = await execute(
          c,
          scope.id,
          config,
          env.modelMode,
          operationId,
        );
        c.operations[operationId] = run.id;
        c.status = "ready";
        await this.save(c);
        return { runId: run.id, c };
      });
      await this.investigate(result.runId, env.modelMode);
      return this.details();
    } catch (e) {
      await this.fail(e);
      throw e;
    }
  }
  async investigate(runId?: string, capturedMode?: ModelMode) {
    return this.locked(async () => {
      const c = await this.data();
      const sessionId = (await this.ctx.storage.get<string>("sessionId"))!;
      const modelMode =
        capturedMode ||
        settingsView(
          this.env,
          await this.env.SESSIONS.get(
            this.env.SESSIONS.idFromName(sessionId),
          ).settings(),
        ).mode;
      if (c.status === "running" || c.status === "analysing")
        throw new HttpError(409, "An operation is already active");
      const run = c.runs.find((r) => r.id === (runId || c.runs.at(-1)?.id));
      if (c.intake && !c.scopes.at(-1)?.confirmedAt)
        throw new HttpError(409, "Review and confirm the requirements first.");
      if (!run && !c.intake)
        throw new HttpError(
          409,
          "Run the demonstration or import run evidence first",
        );
      const workflowId = uid();
      c.status = "analysing";
      c.activeWorkflow = workflowId;
      delete c.error;
      await this.save(c);
      try {
        await this.env.INVESTIGATE.create({
          id: workflowId,
          params: {
            agentName: this.name,
            runId: c.intake ? c.id : run!.id,
            revision: c.revision,
            modelMode,
          },
        });
      } catch (e) {
        c.status = "failed";
        c.error = "Unable to start investigation";
        await this.save(c);
        throw e;
      }
      return viewCase(c);
    });
  }
  async snapshot(runId: string, revision: number) {
    const c = await this.data();
    if (c.revision !== revision)
      throw new HttpError(409, "Evidence revision changed");
    return {
      bundle: {
        schemaVersion: c.schemaVersion,
        title: c.title,
        scopes: c.scopes,
        events: c.events,
        runs: c.runs,
        artifacts: c.artifacts,
      } satisfies Bundle,
      sessionId: (await this.ctx.storage.get<string>("sessionId"))!,
      intake: c.intake,
      evidencePlan: c.evidencePlan,
    };
  }
  async publish(
    runId: string,
    evidenceRevision: number,
    findings: Finding[],
    summary: string,
    explanationMode: Revision["explanationMode"],
    workflowId: string,
    decision?: Revision["decision"],
    collected?: {
      artifacts: Bundle["artifacts"];
      events: Bundle["events"];
      research?: Revision["research"];
    },
  ) {
    return this.locked(async () => {
      const c = await this.data();
      if (c.findings.some((f) => f.id === workflowId)) return;
      const stale = c.revision !== evidenceRevision;
      if (collected) {
        for (const a of collected.artifacts)
          if (!c.artifacts.some((existing) => existing.id === a.id))
            c.artifacts.push(a);
        for (const e of collected.events)
          if (!c.events.some((existing) => existing.id === e.id))
            c.events.push({ ...e, sequence: c.events.length + 1 });
        if (
          new TextEncoder().encode(JSON.stringify(caseManifest(c))).length > 1800000 ||
          c.artifacts.length > 300
        )
          throw new HttpError(
            413,
            "Case evidence storage is full. Create a new case with fewer supplied documents before collecting more pages.",
          );
      }
      for (const f of c.findings) if (f.runId === runId) f.superseded = true;
      c.findings.push({
        id: workflowId,
        runId,
        evidenceRevision,
        scopeId: c.intake
          ? c.scopes.at(-1)?.id
          : c.runs.find((r) => r.id === runId)?.scopeId,
        findings,
        summary: summary.slice(0, 4000),
        explanationMode,
        method: c.intake
          ? decision?.mode === "live"
            ? "clef"
            : "offline"
          : "deterministic",
        decision,
        research: collected?.research,
        superseded: stale,
        createdAt: now(),
      });
      event(
        c,
        "finding",
        stale
          ? "Superseded investigation"
          : findings.some((f) => f.status === "contradicted")
            ? "Scope divergence found"
            : findings.some((f) => f.status === "insufficient_evidence")
              ? "Evidence incomplete"
              : c.intake
                ? "Requirements supported by model assessment"
                : "Scope verified",
        summary.slice(0, 4000),
        { runId },
      );
      if (c.activeWorkflow === workflowId) {
        c.status = "complete";
        delete c.activeWorkflow;
      }
      await this.save(c);
    });
  }
  async fail(error: unknown) {
    return this.locked(async () => {
      try {
        const c = await this.data();
        c.status = "failed";
        c.error =
          error instanceof HttpError
            ? error.publicMessage
            : "Operation failed. Evidence has been preserved; retry the investigation.";
        await this.save(c);
      } catch {
        /* Deleted cases stay deleted. */
      }
    });
  }
  async append(bundle: Bundle) {
    return this.locked(async () => {
      const c = await this.data();
      if (c.intake)
        throw new HttpError(
          409,
          "Add documents through artifact intake for this case.",
        );
      if (c.status === "running")
        throw new HttpError(409, "Wait for the demo run");
      const merged = structuredClone(c);
      for (const k of ["scopes", "events", "runs", "artifacts"] as const) {
        for (const item of bundle[k]) {
          const existing = (merged[k] as { id: string }[]).find(
            (x) => x.id === item.id,
          );
          if (existing && JSON.stringify(existing) !== JSON.stringify(item))
            throw new HttpError(409, "Conflicting record ID");
          if (!existing) (merged[k] as unknown[]).push(item);
        }
      }
      if (new TextEncoder().encode(JSON.stringify(merged)).length > 1800000)
        throw new HttpError(413, "Case evidence limit reached");
      if (merged.events.length > 500)
        throw new HttpError(413, "Case event limit reached");
      try {
        validateBundle(
          BundleSchema.parse({
            schemaVersion: merged.schemaVersion,
            title: merged.title,
            scopes: merged.scopes,
            events: merged.events,
            runs: merged.runs,
            artifacts: merged.artifacts,
          }),
        );
      } catch {
        throw new HttpError(400, "Invalid evidence references or limits");
      }
      merged.revision++;
      for (const f of merged.findings) f.superseded = true;
      await this.save(merged);
      return viewCase(merged);
    });
  }
  async confirmRequirements(requirements: Requirement[]) {
    return this.locked(async () => {
      const c = await this.data();
      if (!c.intake) throw new HttpError(409, "This is a CSV example.");
      if (["running", "analysing"].includes(c.status))
        throw new HttpError(409, "Wait for the assessment to finish.");
      if (c.scopes.length >= 30)
        throw new HttpError(429, "Scope version limit reached.");
      const previous = c.scopes.at(-1)!;
      const scope = {
        ...previous,
        id: uid(),
        version: previous.version + 1,
        requirements,
        confirmedAt: now(),
        provenance: "observed" as const,
      };
      if (c.evidencePlan?.checks.length && JSON.stringify(previous.requirements) !== JSON.stringify(requirements)) {
        c.evidencePlan.checks = [];
        event(c, "configuration", "Acceptance checks need review", "Requirements changed. Previous checks were cleared to prevent a check from being assigned to a different condition.", { scopeId: previous.id });
      }
      c.scopes.push(scope);
      c.revision++;
      c.status = "ready";
      c.findings.forEach((f) => (f.superseded = true));
      event(
        c,
        "scope",
        `Requirements v${scope.version} confirmed`,
        requirements
          .map((r) => r.text)
          .join("\n")
          .slice(0, 4000),
        { scopeId: scope.id },
      );
      await this.save(c);
      return viewCase(c);
    });
  }
  async draftRequirements() {
    const c = await this.data();
    if (!c.intake)
      throw new HttpError(
        409,
        "This case does not contain an imported conversation.",
      );
    const sessionId = (await this.ctx.storage.get<string>("sessionId"))!;
    const env = withSettings(
      this.env,
      await this.env.SESSIONS.get(
        this.env.SESSIONS.idFromName(sessionId),
      ).settings(),
    );
    return { requirements: await draftRequirements(env, sessionId, c.intake) };
  }
  async updateEvidencePlan(plan: EvidencePlan) {
    return this.locked(async () => {
      const c = await this.data();
      if (["running", "analysing"].includes(c.status)) throw new HttpError(409, "Wait for the assessment to finish.");
      for (const url of [...plan.targetUrls, ...plan.checks.flatMap((check) => check.url ? [check.url] : [])]) {
        try { publicPage(url); } catch { throw new HttpError(400, "Evidence targets must be public HTTPS URLs without credentials or action endpoints."); }
      }
      if (plan.checks.some((check) => !c.scopes.at(-1)?.requirements?.some((r) => r.id === check.requirementId))) throw new HttpError(400, "Each check must refer to a current requirement.");
      const sessionId = (await this.ctx.storage.get<string>("sessionId"))!;
      const connections = await this.env.SESSIONS.get(this.env.SESSIONS.idFromName(sessionId)).listConnections();
      if (plan.connectionIds.some((id) => !connections.some((connection) => connection.id === id))) throw new HttpError(400, "A selected connection is unavailable in this session.");
      // Re-saving the effective plan must not discard a completed assessment.
      if (JSON.stringify(EvidencePlanSchema.parse(c.evidencePlan || {})) === JSON.stringify(plan)) return viewCase(c);
      c.evidencePlan = plan; c.revision++; c.status = "ready";
      c.findings.forEach((f) => f.superseded = true);
      event(c, "configuration", "Evidence plan updated", `${plan.coverage} coverage; target environment: ${plan.environment}; ${plan.checks.length} explicit acceptance checks; ${plan.connectionIds.length} selected private connections.`, { scopeId: c.scopes.at(-1)?.id });
      await this.save(c); return viewCase(c);
    });
  }
  async attachDocuments(documents: ImportedDocument[]) {
    return this.locked(async () => {
      const c = await this.data();
      if (!c.intake)
        throw new HttpError(409, "Use an evidence bundle for the CSV example.");
      if (["running", "analysing"].includes(c.status))
        throw new HttpError(409, "Wait for the assessment to finish.");
      if (c.artifacts.length + documents.length > 300)
        throw new HttpError(413, "Artifact limit reached.");
      await addDocuments(c, documents);
      if (new TextEncoder().encode(JSON.stringify(caseManifest(c))).length > 1800000)
        throw new HttpError(413, "Case evidence limit reached.");
      c.revision++;
      c.status = "ready";
      c.findings.forEach((f) => (f.superseded = true));
      await this.save(c);
      return viewCase(c);
    });
  }
  async getArtifact(id: string) {
    const c = await this.data();
    const a = c.artifacts.find((a) => a.id === id);
    if (!a) throw new HttpError(404, "Artifact not found");
    const stored = await this.env.EVIDENCE.get(`${this.name}/${id}`);
    if (!stored) throw new HttpError(404, "Artifact unavailable");
    const content = await boundedStoredText(stored, a.observation ? CAPTURE_BYTES : ARTIFACT_BYTES);
    if ((await hash(content)) !== a.sha256)
      throw new HttpError(409, "Artifact integrity check failed");
    return { ...a, content };
  }
  async report() {
    return this.data();
  }
  async purge() {
    return this.locked(async () => {
      const c = this.storedCase();
      // Survives failed cleanup; queued writes fail closed even if termination fails.
      await this.ctx.storage.put("deleting", true);
      if (c?.activeWorkflow) {
        try { await (await this.env.INVESTIGATE.get(c.activeWorkflow)).terminate(); } catch {}
      }
      await deleteCaseEvidence(this.env.EVIDENCE, this.name);
      for (const connection of this.getConnections()) connection.close(1000, "Case deleted");
      await this.ctx.storage.deleteAll();
        // A tombstone also blocks an initialization RPC arriving after deletion.
        await this.ctx.storage.put("deleting", true);
    });
  }
  async writeSnapshot(workflowId: string, content: string) {
    return this.locked(async () => {
      const c = await this.data(false);
      if (c.activeWorkflow !== workflowId || c.status !== "analysing") throw new HttpError(409, "Assessment is no longer active");
      assertSnapshot(content);
      await this.env.EVIDENCE.put(`${this.name}/analysis-${workflowId}`, content);
    });
  }
  async alarm() {
    const c = this.storedCase();
    if (await this.ctx.storage.get<boolean>("deleting") || (c && c.expiresAt <= Date.now())) {
      await this.purge();
      return;
    }
    // Existing cases may still have a legacy raw expiry alarm. Register their
    // expiry without treating an SDK recovery/maintenance wake as deletion.
    if (c) await this.scheduleCaseExpiry(c);
    await super.alarm();
  }
  async onChatMessage(
    _onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: Parameters<AIChatAgent<Env>["onChatMessage"]>[1],
  ) {
    // Return the stream immediately, including for storage, quota and AI errors.
    return investigationStream(async (signal, progress) => {
      const c = await this.data();
      if (this.messages.length > 100)
        throw new HttpError(429, "Conversation limit reached");
      const question =
        this.messages
          .at(-1)
          ?.parts.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n") || "";
      if (question.length > 2000)
        throw new HttpError(413, "Keep questions below 2,000 characters");
      let text: string;
      let suggestion = "";
      const sessionId = (await this.ctx.storage.get<string>("sessionId"))!;
      const env = withSettings(
        this.env,
        await this.env.SESSIONS.get(
          this.env.SESSIONS.idFromName(sessionId),
        ).settings(),
      );
      if (env.modelMode === "offline") {
        const f = c.findings.at(-1);
        text =
          "Offline demonstration response. " +
          (f
            ? f.findings
                .map((x) => `${x.criterion}: ${x.explanation}`)
                .join("\n\n") +
              "\n\nEvidence: " +
              Array.from(new Set(f.findings.flatMap((x) => x.evidenceIds)))
                .map((id) => `[${id}]`)
                .join(", ")
            : "Confirm the scope and run the demonstration to collect evidence.");
      } else {
        const answer = await answerInvestigation(env, sessionId, c, this.messages, signal, progress);
        text = answer.text;
        suggestion = answer.suggestion;
      }
      return { text, suggestion };
    }, options?.abortSignal);
  }
}

export class InvestigationWorkflow extends WorkflowEntrypoint<
  Env,
  InvestigationInput
> {
  async run(e: WorkflowEvent<InvestigationInput>, step: WorkflowStep) {
    const agent = await getAgentByName(this.env.CaseAgent, e.payload.agentName);
    // Capture the choice at dispatch; a later toggle never relabels an in-flight run.
    const env = {
      ...this.env,
      modelMode: e.payload.modelMode || ("offline" as const),
    };
    const snapshotKey = `${e.payload.agentName}/analysis-${e.instanceId}`;
    try {
      const snapshot = await step.do("Snapshot evidence", async () => {
        const s = await agent.snapshot(e.payload.runId, e.payload.revision);
        await agent.writeSnapshot(e.instanceId, JSON.stringify(s));
        return { key: snapshotKey };
      });
      await step.do(
        "Collect online evidence",
        { retries: { limit: 0, delay: "1 second" }, timeout: "8 minutes" },
        async () => {
          const stored = await this.env.EVIDENCE.get(snapshot.key);
          if (!stored) throw new Error("Snapshot unavailable");
          const data = JSON.parse(await boundedStoredText(stored, SNAPSHOT_BYTES)) as {
            bundle: Bundle;
            sessionId: string;
            intake?: CaseData["intake"];
            evidencePlan?: EvidencePlan;
            research?: Revision["research"];
          };
          if (data.intake && env.modelMode === "live") {
            const c = {
              ...newCase("correct"),
              ...data.bundle,
              intake: data.intake,
              evidencePlan: data.evidencePlan,
            };
            c.artifacts = c.artifacts.filter((a) => !a.observation);
            c.events = c.events.filter((e) =>
              e.artifactIds.every((id) => c.artifacts.some((a) => a.id === id)),
            );
            const connected = await this.env.SESSIONS.get(this.env.SESSIONS.idFromName(data.sessionId)).connections();
            const selected = connected.filter((connection) => c.evidencePlan?.connectionIds.includes(connection.id));
            data.research = await gatherEvidence(env, data.sessionId, c, selected);
            if (c.evidencePlan?.connectionIds.some((id) => !selected.some((connection) => connection.id === id))) data.research.limitations.push("A selected private connection expired or was disconnected. Reconnect it before reassessment.");
            data.bundle.artifacts = c.artifacts;
            data.bundle.events = c.events;
            await agent.writeSnapshot(e.instanceId, JSON.stringify(data));
          }
        },
      );
      const checked = await step.do(
        "Verify scope",
        { retries: { limit: 0, delay: "1 second" }, timeout: "10 minutes" },
        async () => {
          const s = await this.env.EVIDENCE.get(snapshot.key);
          if (!s) throw new Error("Snapshot unavailable");
          const data = JSON.parse(await boundedStoredText(s, SNAPSHOT_BYTES)) as {
            bundle: Bundle;
            sessionId: string;
            intake?: CaseData["intake"];
            evidencePlan?: EvidencePlan;
            research?: Revision["research"];
          };
          if (data.intake) {
            if (
              data.research &&
              !data.research.sources.some((s) => s.status === "captured") &&
              data.research.limitations.some((s) =>
                s.includes("Browser Run could not"),
              )
            ) {
              return {
                findings: (data.bundle.scopes.at(-1)?.requirements || []).map(
                  (r) => ({
                    criterion: r.id,
                    status: "insufficient_evidence" as const,
                    explanation:
                      "Online collection failed before the website could be inspected. The delivery assessment was not run; retry after resolving the collection failure.",
                    gaps: data.research!.limitations,
                    nextSteps: [
                      "Check the collection diagnostics above and retry. Supplied artifacts are retained.",
                    ],
                    evidenceIds: [],
                  }),
                ),
                sessionId: data.sessionId,
                decision: {
                  model: "Online collection unavailable",
                  mode: "unavailable" as const,
                  durationMs: 0,
                  answers: {},
                },
              };
            }
            const assessed = await assessRequirements(
              env,
              data.sessionId,
              {
                ...newCase("correct"),
                ...data.bundle,
                intake: data.intake,
              evidencePlan: data.evidencePlan,
              },
              data.research,
            ).catch((error: unknown) => ({
              findings: (data.bundle.scopes.at(-1)?.requirements || []).map(
                (r) => enforceAcceptance({
                  criterion: r.id,
                  status: "insufficient_evidence" as const,
                  explanation:
                    "The assessment service did not complete. Collected online observations are retained; this does not establish missing delivery.",
                  gaps: [
                    error instanceof HttpError
                      ? error.publicMessage
                      : "CLEF returned an unavailable or invalid response.",
                  ],
                  nextSteps: [
                    "Check the Cloudflare AI allowance and service configuration, then assess again.",
                  ],
                  evidenceIds: data.bundle.events.filter((e) => e.artifactIds.some((id) => data.research?.checks?.some((check) => check.requirementId === r.id && check.artifactIds.includes(id)))).map((e) => e.id),
                }, data.research?.checks || []),
              ),
              decision: {
                model: "Assessment unavailable",
                mode: "unavailable" as const,
                durationMs: 0,
                answers: {},
              },
            }));
            return { ...assessed, sessionId: data.sessionId };
          }
          return {
            findings: verify(data.bundle, e.payload.runId),
            sessionId: data.sessionId,
            decision: undefined,
          };
        },
      );
      const explanation = await step.do(
        "Explain findings",
        { retries: { limit: 1, delay: "1 second", backoff: "constant" } },
        async () => {
          const fallback = checked.findings
            .map((f) => `${f.criterion}: ${f.explanation}`)
            .join("\n");
          if (
            env.modelMode === "offline" ||
            checked.decision?.mode === "unavailable"
          )
            return {
              summary: fallback.slice(0, 3900),
              mode:
                env.modelMode === "offline"
                  ? ("offline" as const)
                  : ("unavailable" as const),
            };
          try {
            const answer = await modelJson(
              env,
              checked.sessionId,
              'Explain the supplied findings without changing statuses. For CLEF results, call them model assessments, not proof; probabilities are not guarantees. JSON: {"text":string,"evidenceIds":string[]}.',
              JSON.stringify(checked.findings),
              Answer,
            );
            return {
              summary: grounded(
                answer,
                checked.findings.flatMap((f) => f.evidenceIds),
              ),
              mode: "live" as const,
            };
          } catch {
            return {
              summary:
                fallback +
                "\nAI explanation unavailable; recorded findings are retained.",
              mode: "unavailable" as const,
            };
          }
        },
      );
      await step.do("Publish revision", async () => {
        const stored = await this.env.EVIDENCE.get(snapshot.key);
        if (!stored) throw new Error("Snapshot unavailable");
        const data = JSON.parse(await boundedStoredText(stored, SNAPSHOT_BYTES)) as {
          bundle: Bundle;
          research?: Revision["research"];
        };
        const observed = data.bundle.artifacts.filter((a) => a.observation);
        await agent.publish(
          e.payload.runId,
          e.payload.revision,
          checked.findings,
          explanation.summary,
          explanation.mode,
          e.instanceId,
          checked.decision,
          {
            artifacts: observed,
            events: data.bundle.events.filter((e) =>
              e.artifactIds.some((id) => observed.some((a) => a.id === id)),
            ),
            research: data.research,
          },
        );
      });
    } catch (error) {
      await agent.fail(error);
      throw error;
    } finally {
      await this.env.EVIDENCE.delete(snapshotKey);
    }
  }
}

async function signingKey(env: Env) {
  if (env.SESSION_SIGNING_SECRET) return env.SESSION_SIGNING_SECRET;
  if (env.LOCAL_DEVELOPMENT === "true")
    return env.SESSIONS.get(env.SESSIONS.idFromName("local-key")).localKey();
  throw new HttpError(503, "Session signing secret is not configured");
}
async function session(req: Request, env: Env) {
  const s = await verifySession(cookie(req), await signingKey(env));
  if (!s) throw new HttpError(401, "Start a new demo session");
  const registry = env.SESSIONS.get(env.SESSIONS.idFromName(s.id));
  await registry.get();
  return { ...s, registry };
}
async function bundleFrom(req: Request) {
  const b = BundleSchema.parse(await readJson(req));
  try {
    validateBundle(b);
  } catch {
    throw new HttpError(400, "Invalid or duplicate evidence references");
  }
  for (const a of b.artifacts) {
    delete a.contentStored;
    delete a.observation;
    if ((await hash(a.content)) !== a.sha256)
      throw new HttpError(400, "Artifact hash mismatch");
  }
  for (const s of b.scopes) s.provenance = "supplied";
  for (const e of b.events) {
    e.provenance = "supplied";
    e.receivedAt = now();
  }
  return b;
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url),
        path = url.pathname;
      const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        url.hostname,
      );
      if (env.LOCAL_DEVELOPMENT === "true" && !local)
        throw new HttpError(
          503,
          "Local development is restricted to localhost.",
        );
      if (path === "/api/install-check" && req.method === "POST")
        return await installationCheck(req, env);
      if (path === "/api/config")
        return json({
          mode: "offline",
          aiAvailable: aiAvailable(env),
          siteKey: env.TURNSTILE_SITE_KEY,
          model: env.MODEL_ID,
          local,
        });
      if (path === "/api/session" && req.method === "POST") {
        sameOrigin(req);
        const body = z
          .object({ token: z.string().max(2048).optional() })
          .parse(await readJson(req, 5000));
        if (!(local && env.LOCAL_DEVELOPMENT === "true")) {
          if (
            !env.TURNSTILE_SECRET_KEY ||
            !env.SESSION_SIGNING_SECRET ||
            !env.AI ||
            !env.AI_GATEWAY_ID
          )
            throw new HttpError(503, "Deployment setup is incomplete");
          const verified = (await fetch(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            {
              method: "POST",
              body: new URLSearchParams({
                secret: env.TURNSTILE_SECRET_KEY,
                response: body.token || "",
              }),
            },
          ).then((r) => r.json())) as {
            success: boolean;
            hostname?: string;
            action?: string;
          };
          if (
            !verified.success ||
            verified.hostname !== url.hostname ||
            verified.action !== "session"
          )
            throw new HttpError(403, "Please complete the verification");
        }
        const id = uid(),
          registry = env.SESSIONS.get(env.SESSIONS.idFromName(id)),
          r = await registry.init(id);
        const signed = await signSession(
          id,
          r.expiresAt,
          await signingKey(env),
        );
        return new Response(JSON.stringify({ expiresAt: r.expiresAt }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": `intenttrace=${signed}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${url.protocol === "https:" ? "; Secure" : ""}`,
          },
        });
      }
      if (path.startsWith("/api/") || path.startsWith("/agents/")) {
        const s = await session(req, env);
        if (req.method !== "GET" || req.headers.get("Upgrade") === "websocket")
          sameOrigin(req);
        if (
          env.RATE_LIMITER &&
          !(await env.RATE_LIMITER.limit({ key: s.id })).success
        )
          throw new HttpError(429, "Too many requests. Please wait a moment.");
        const r = await s.registry.get();
        if (path === "/api/settings" && req.method === "GET")
          return json(settingsView(env, await s.registry.settings()));
        const evaluationId = path.match(/^\/api\/evaluations\/([a-z-]+)$/)?.[1];
        if (evaluationId && req.method === "POST") {
          await readJson(req, 1000);
          const { evaluationCase, evaluationCases } = await import("./evaluation-cases");
          if (!evaluationCases.some((f) => f.id === evaluationId)) throw new HttpError(404, "Unknown synthetic evaluation case.");
          const configured = withSettings(env, await s.registry.settings());
          if (configured.modelMode !== "live") throw new HttpError(409, "Enable Clef to run live evaluations.");
          return json(await assessRequirements(configured, s.id, await evaluationCase(evaluationId)));
        }
        if (path === "/api/connections" && req.method === "GET") return json(await s.registry.listConnections());
        if (path === "/api/connections" && req.method === "POST") return json(await s.registry.addConnection(await readJson(req, 12000)), 201);
        const connectionId = path.match(/^\/api\/connections\/([a-zA-Z0-9_-]+)$/)?.[1];
        if (connectionId && req.method === "DELETE") { if (req.body) await readJson(req, 1000); return json(await s.registry.removeConnection(connectionId)); }
        if (path === "/api/settings" && req.method === "POST") {
          const settings = SettingsSchema.parse(await readJson(req, 5000));
          return json(
            settingsView(env, await s.registry.updateSettings(settings)),
          );
        }
        if (path.startsWith("/agents/")) {
          const allowed = r.cases.some(
            (c) =>
              path === `/agents/case-agent/${s.id}_${c.id}` ||
              path.startsWith(`/agents/case-agent/${s.id}_${c.id}/`),
          );
          if (!allowed) throw new HttpError(404, "Case unavailable");
          return (
            (await routeAgentRequest(req, env)) ||
            json({ error: "Not found" }, 404)
          );
        }
        if (path === "/api/cases" && req.method === "GET")
          return json({
            cases: r.cases,
            sessionId: s.id,
            expiresAt: s.expiresAt,
          });
        if (
          (path === "/api/cases" ||
            path === "/api/import" ||
            path === "/api/intake") &&
          req.method === "POST"
        ) {
          let c: CaseData;
          if (path === "/api/intake") {
            c = await intakeCase(
              withSettings(env, await s.registry.settings()),
              s.id,
              IntakeSchema.parse(await readJson(req)),
            );
          } else if (path === "/api/import") {
            const b = await bundleFrom(req);
            c = { ...newCase("correct"), ...b, findings: [], revision: 1 };
          } else {
            const { scenario } = z
              .object({ scenario: Scenario })
              .parse(await readJson(req, 5000));
            c = newCase(scenario);
          }
          c.expiresAt = s.expiresAt;
          if (new TextEncoder().encode(JSON.stringify(c)).length > 1800000)
            throw new HttpError(
              413,
              "Case evidence exceeds the local storage limit. Choose a smaller conversation or artifact excerpt.",
            );
          await s.registry.add({
            id: c.id,
            title: c.title,
            createdAt: c.createdAt,
          });
          const a = await getAgentByName(env.CaseAgent, `${s.id}_${c.id}`);
          return json(await a.init(c, s.id), 201);
        }
        const match = path.match(/^\/api\/cases\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
        if (!match || !r.cases.some((c) => c.id === match[1]))
          throw new HttpError(404, "Case unavailable");
        const a = await getAgentByName(env.CaseAgent, `${s.id}_${match[1]}`),
          action = match[2] || "";
        if (req.method === "GET" && !action) return json(await a.details());
        if (req.method === "DELETE" && !action) {
          await a.purge();
          await s.registry.remove(match[1]);
          return json({ deleted: true });
        }
        if (req.method === "POST" && action === "scope") {
          const { selection } = z
            .object({ selection: z.enum(["filtered", "project"]) })
            .parse(await readJson(req, 5000));
          return json(await a.confirm(selection));
        }
        if (req.method === "POST" && action === "draft-requirements")
          return json(await a.draftRequirements());
        if (req.method === "POST" && action === "evidence-plan") return json(await a.updateEvidencePlan(EvidencePlanSchema.parse(await readJson(req, 30000))));
        if (req.method === "POST" && action === "requirements") {
          const { requirements } = z
            .object({ requirements: z.array(RequirementSchema).min(1).max(12) })
            .strict()
            .parse(await readJson(req, 20000));
          if (
            new Set(requirements.map((r) => r.id)).size !== requirements.length
          )
            throw new HttpError(400, "Requirement IDs must be unique.");
          return json(await a.confirmRequirements(requirements));
        }
        if (req.method === "POST" && action === "documents") {
          const { documents } = z
            .object({ documents: z.array(DocumentSchema).min(1).max(8) })
            .strict()
            .parse(await readJson(req));
          return json(await a.attachDocuments(documents));
        }
        if (req.method === "POST" && action === "run") {
          const { operationId } = z
            .object({ operationId: z.uuid() })
            .parse(await readJson(req, 5000));
          return json(await a.run(operationId));
        }
        if (req.method === "POST" && action === "investigate") {
          const { runId } = z
            .object({ runId: z.uuid().optional() })
            .parse(await readJson(req, 5000));
          return json(await a.investigate(runId));
        }
        if (req.method === "POST" && action === "evidence")
          return json(await a.append(await bundleFrom(req)));
        if (req.method === "GET" && action === "report") {
          const c = await a.report();
          const { operations: _, activeWorkflow: __, ...report } = c;
          return new Response(JSON.stringify(report, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition":
                'attachment; filename="intenttrace-report.json"',
              "Cache-Control": "no-store",
            },
          });
        }
        if (req.method === "GET" && action.startsWith("artifacts/")) {
          const artifact = await a.getArtifact(action.slice(10));
          const isCsv =
            url.searchParams.get("format") === "csv" &&
            artifact.kind === "export";
          return new Response(
            isCsv ? csv(artifact.content) : artifact.content,
            {
              headers: {
                "Content-Type": isCsv
                  ? "text/csv; charset=utf-8"
                  : artifact.kind === "document"
                    ? "text/plain; charset=utf-8"
                    : "application/json",
                "Content-Disposition": `attachment; filename="${isCsv ? "atlas-export.csv" : artifact.kind === "document" ? artifact.name.replace(/[^a-zA-Z0-9._-]/g, "_") : "evidence.json"}"`,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            },
          );
        }
        throw new HttpError(404, "Not found");
      }
      return env.ASSETS.fetch(req);
    } catch (error) {
      if (req.body && !req.bodyUsed) await readJson(req).catch(() => {});
      if (error instanceof z.ZodError)
        return json(
          {
            error: "Invalid input",
            fields: error.issues.map((i) => i.path.join(".")),
          },
          400,
        );
      if (error instanceof HttpError)
        return json({ error: error.publicMessage }, error.status);
      const remote =
        error instanceof Error
          ? error.message.match(/INTENTTRACE:(\d{3}):(.+)$/)
          : null;
      if (remote) return json({ error: remote[2] }, Number(remote[1]));
      console.error(
        JSON.stringify({ operation: "request", error: "Internal failure" }),
      );
      return json(
        { error: "Operation failed. Refresh the case and try again." },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
