import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  FileSearch,
  Plus,
  Download,
  Play,
  Upload,
  Trash2,
  Send,
  Cloud,
  ArrowRight,
} from "lucide-react";
import type { CaseView, Scenario } from "../shared/domain";
import { tasks, TaskSchema } from "../shared/domain";
import "./style.css";
import { IntakeForm, Requirements } from "./intake";

async function api<T = any>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const r = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = (await r.json()) as any;
  if (!r.ok) throw new Error(result.error || "Request failed");
  return result as T;
}
function ProjectDashboard({ data }: { data: CaseView }) {
  const [rows, setRows] = useState<ReturnType<typeof tasks>>([]);
  const [filter, setFilter] = useState("open");
  const [failure, setFailure] = useState("");
  const snapshot = data.artifacts.find((a) => a.kind === "snapshot");
  const output = data.artifacts.find(
    (a) => a.id === data.runs.at(-1)?.artifactId,
  );
  useEffect(() => {
    let current = true;
    if (snapshot)
      void api(`/api/cases/${data.id}/artifacts/${snapshot.id}`)
        .then((value) => {
          const parsed = TaskSchema.array().parse(value.before);
          if (current) setRows(parsed);
        })
        .catch(() => {
          if (current)
            setFailure(
              "The source snapshot could not be loaded. Select its evidence link to retry.",
            );
        });
    else
      setRows(
        data.events.some((e) => e.provenance === "supplied") ? [] : tasks(),
      );
    return () => {
      current = false;
    };
  }, [data.id, snapshot?.id]);
  const visible = rows.filter(
    (row) => filter === "all" || row.status === "open",
  );
  return (
    <section>
      <h2>Project Atlas</h2>
      <p>
        The source tasks for this export. The approved filtered selection
        contains open tasks. This preview filter does not change an approved
        scope.
      </p>
      <label>
        Show tasks{" "}
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="open">Open tasks</option>
          <option value="all">All project tasks</option>
        </select>
      </label>
      <p className="small muted">
        {visible.length} of {rows.length} tasks ·{" "}
        {snapshot
          ? "Recorded source snapshot"
          : "Synthetic demonstration source"}
      </p>
      {failure && <p role="alert">{failure}</p>}
      {output ? (
        <a href={`/api/cases/${data.id}/artifacts/${output.id}?format=csv`}>
          <Download size={16} /> Download observed CSV export
        </a>
      ) : (
        <p>
          No export artifact yet. Confirm the scope and run the demonstration in
          Timeline.
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Title</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id}>
                <th>{row.id}</th>
                <td>{row.title}</td>
                <td>{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function Chat({
  name,
  events,
  onEvidence,
}: {
  name: string;
  events: CaseView["events"];
  onEvidence: (id: string) => void;
}) {
  const agent = useAgent({ agent: "case-agent", name });
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");
  const awaitingAnswer = useRef(false);
  const { messages, sendMessage, status, error, regenerate } = useAgentChat({
    agent,
  });
  useEffect(() => {
    if (status === "submitted" || status === "streaming")
      awaitingAnswer.current = true;
    if (status === "ready" && !error && submitted && awaitingAnswer.current) {
      setDraft((current) => (current === submitted ? "" : current));
      setSubmitted("");
      awaitingAnswer.current = false;
    }
  }, [status, error, submitted]);
  const linkedText = (text: string) =>
    text.split(/(\[[a-zA-Z0-9_, -]+\])/g).map((part, index) => {
      if (part.startsWith("[") && part.includes(",")) {
        const linked = part
          .slice(1, -1)
          .split(/,\s*/)
          .map((id) => events.find((e) => e.id === id));
        if (linked.every(Boolean))
          return (
            <React.Fragment key={index}>
              {linked.map((event, i) => (
                <React.Fragment key={event!.id}>
                  {i > 0 && ", "}
                  <button
                    className="evidence-link"
                    onClick={() => onEvidence(event!.id)}
                  >
                    {event!.title}
                  </button>
                </React.Fragment>
              ))}
            </React.Fragment>
          );
      }
      const event = events.find((e) => `[${e.id}]` === part);
      return event ? (
        <button
          className="evidence-link"
          key={index}
          onClick={() => onEvidence(event.id)}
        >
          {event.title}
        </button>
      ) : (
        part
      );
    });
  return (
    <section className="chat">
      <h2>Investigation chat</h2>
      <p className="muted small">Ask about the scope, evidence, or findings.</p>
      <div className="messages" aria-live="polite">
        {messages.map((m) => (
          <div className={`message ${m.role}`} key={m.id}>
            <strong>{m.role === "user" ? "You" : "IntentTrace"}</strong>
            <p>
              {linkedText(
                m.parts
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("\n"),
              )}
            </p>
          </div>
        ))}
      </div>
      {error && (
        <div role="alert">
          <p>The answer could not be completed. Your question is preserved.</p>
          <button className="secondary" onClick={() => void regenerate()}>
            Retry answer
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          setSubmitted(draft);
          void sendMessage({ text: draft }).catch(() => {});
        }}
      >
        <label className="sr-only" htmlFor="question">
          Ask about this case
        </label>
        <textarea
          id="question"
          maxLength={2000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Where did delivery diverge?"
        />
        <button
          aria-label="Send question"
          disabled={
            !draft.trim() || status === "streaming" || status === "submitted"
          }
        >
          <Send size={18} />
        </button>
      </form>
      <p className="small muted">
        AI can make mistakes. Inspect the linked evidence.
      </p>
    </section>
  );
}
function App() {
  const [config, setConfig] = useState<{
    mode: string;
    siteKey: string;
    local: boolean;
  } | null>(null);
  const [cases, setCases] = useState<{ id: string; title: string }[]>([]),
    [active, setActive] = useState<CaseView | null>(null);
  const [sessionId, setSessionId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("divergence"),
    [selected, setSelected] = useState("");
  const [view, setView] = useState("timeline");
  const upload = useRef<HTMLInputElement>(null),
    turnstile = useRef<HTMLDivElement>(null);
  const refresh = async () => {
    const s = await api("/api/cases");
    setCases(s.cases);
    setSessionId(s.sessionId);
    return s;
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const begin = async (token?: string) => {
    await api("/api/session", { token });
    await refresh();
  };
  useEffect(() => {
    void api("/api/config")
      .then(async (c) => {
        setConfig(c);
        try {
          const s = await refresh();
          if (s.cases[0]) setActive(await api(`/api/cases/${s.cases[0].id}`));
        } catch {
          if (c.mode === "offline" || c.local) await begin();
        }
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!config?.siteKey || sessionId || !turnstile.current) return;
    let widget: string | undefined;
    const render = () => {
      const t = (window as any).turnstile;
      if (t && turnstile.current)
        widget = t.render(turnstile.current, {
          sitekey: config.siteKey,
          action: "session",
          callback: (token: string) => void act(() => begin(token)),
        });
    };
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.onload = render;
    document.head.appendChild(script);
    return () => {
      script.remove();
      if (widget) (window as any).turnstile?.remove(widget);
    };
  }, [config, sessionId]);
  useEffect(() => {
    if (!active || !["running", "analysing"].includes(active.status)) return;
    const id = setInterval(() => {
      void api(`/api/cases/${active.id}`)
        .then(setActive)
        .catch((e) => setError(e.message));
    }, 1800);
    return () => clearInterval(id);
  }, [active?.id, active?.status]);
  const create = async () => {
    setActive(await api("/api/cases", { scenario }));
    setSelected("");
    setView("timeline");
    await refresh();
  };
  const latest = active?.findings.at(-1),
    scope = active?.scopes.at(-1);
  const selectedEvent = active?.events.find((e) => e.id === selected);
  const selectEvidence = (id: string) => {
    setSelected(id);
    setView("timeline");
    requestAnimationFrame(() =>
      document
        .getElementById(`event-${id}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  };
  const currentFindings =
    active?.status === "complete" && latest && !latest.superseded;
  const artifacts = selected
    ? active?.artifacts.filter((a) =>
        active.events
          .find((e) => e.id === selected)
          ?.artifactIds.includes(a.id),
      )
    : active?.artifacts;
  return (
    <div className="desk">
      <aside className="sidebar">
        <a className="brand" href="/">
          <FileSearch size={28} />{" "}
          <span>
            IntentTrace<small>Trace intent. Verify delivery.</small>
          </span>
        </a>
        <h2>Cases</h2>
        <button
          className="new-case"
          disabled={busy || !sessionId}
          onClick={() => {
            setActive(null);
            setSelected("");
            setView("timeline");
          }}
        >
          <Plus size={17} />
          New investigation
        </button>
        <nav aria-label="Cases">
          {cases.map((c) => (
            <button
              key={c.id}
              className={active?.id === c.id ? "current" : ""}
              onClick={() =>
                void act(async () => {
                  setActive(await api(`/api/cases/${c.id}`));
                  setSelected("");
                })
              }
            >
              {c.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <Cloud size={18} />
          <span>
            Cloudflare native
            <br />
            <small>Isolated 24-hour session</small>
          </span>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <h1>{active?.title || "Your case desk"}</h1>
            <p className="small muted">
              {active
                ? active.events.some((e) => e.provenance === "supplied")
                  ? "Imported evidence · Supplied claims require verification"
                  : "Synthetic demonstration · Project Atlas"
                : "Connect agreed scope to observed delivery."}
            </p>
          </div>
          <span className="badge">
            {config?.mode === "live"
              ? "Live AI"
              : config
                ? "Offline fixtures"
                : "Connecting"}
          </span>
        </header>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        {!sessionId ? (
          <section className="empty">
            <h2>Start a private demo session</h2>
            <p>
              Open your private case desk. Case records expire after 24 hours.
            </p>
            <div ref={turnstile} />
            {(config?.mode === "offline" || config?.local) && (
              <button onClick={() => void act(() => begin())}>
                Start local session
              </button>
            )}
          </section>
        ) : (
          <>
            {active && !active.intake && (
              <div className="toolbar">
                <label>
                  Scenario{" "}
                  <select
                    value={scenario}
                    onChange={(e) => setScenario(e.target.value as Scenario)}
                  >
                    <option value="divergence">Scope divergence</option>
                    <option value="correct">Correct delivery</option>
                    <option value="missing">Missing evidence</option>
                  </select>
                </label>
                <button disabled={busy} onClick={() => void act(create)}>
                  <Plus size={16} />
                  Create case
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => upload.current?.click()}
                >
                  <Upload size={16} />
                  Import evidence
                </button>
                <input
                  ref={upload}
                  hidden
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void act(async () => {
                        if (file.size > 1048576)
                          throw new Error(
                            "Choose an evidence bundle below 1 MiB.",
                          );
                        setActive(
                          await api(
                            "/api/import",
                            JSON.parse(await file.text()),
                          ),
                        );
                        setSelected("");
                        await refresh();
                      });
                    e.target.value = "";
                  }}
                />
              </div>
            )}
            {active ? (
              <>
                <div
                  className={`status-strip ${!currentFindings || latest?.findings.some((f) => f.status === "contradicted") ? "warn" : ""}`}
                >
                  <strong>
                    {active.status === "failed"
                      ? "Investigation failed · Previous findings remain below"
                      : active.status === "running"
                        ? "Execution in progress"
                        : active.status === "analysing"
                          ? "Investigation in progress"
                          : currentFindings
                            ? latest.findings.some(
                                (f) => f.status === "contradicted",
                              )
                              ? active.intake
                                ? "CLEF assessment · Contradiction flagged"
                                : "Execution completed · Scope not fulfilled"
                              : latest.findings.some(
                                    (f) => f.status === "insufficient_evidence",
                                  )
                                ? "Evidence incomplete · Review required"
                                : active.intake
                                  ? "CLEF assessment · Requirements supported"
                                  : "Delivery supported by evidence"
                            : active.intake
                              ? "Review requirements, add artifacts, then assess"
                              : "Confirm the scope, then run the demonstration"}
                  </strong>
                  <span>
                    Scope v{scope?.version} ·{" "}
                    {currentFindings
                      ? `${latest.decision?.mode || latest.explanationMode} ${active.intake ? "assessment" : "explanation"}`
                      : active.intake
                        ? "Awaiting assessment"
                        : "Awaiting execution"}
                  </span>
                </div>
                <nav className="views" aria-label="Case views">
                  {(active.intake
                    ? [
                        ["timeline", "Timeline"],
                        ["conversation", "Conversation"],
                      ]
                    : [
                        ["timeline", "Timeline"],
                        ["comparison", "Agreed vs delivered"],
                        ["dashboard", "Demo dashboard"],
                      ]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={view === id ? "selected" : "secondary"}
                      aria-pressed={view === id}
                      onClick={() => setView(id)}
                    >
                      {label}
                    </button>
                  ))}
                </nav>
                <div className="workspace">
                  <section className="timeline">
                    {view === "timeline" && (
                      <>
                        <div className="section-header">
                          <h2>Timeline</h2>
                          <a href={`/api/cases/${active.id}/report`}>
                            <Download size={16} />
                            Report
                          </a>
                        </div>
                        <p className="muted">
                          The request, approval, execution, and findings in
                          order.
                        </p>
                        {active.intake ? (
                          <Requirements
                            key={`${active.id}-${scope?.id}`}
                            data={active}
                            busy={
                              busy ||
                              ["running", "analysing"].includes(active.status)
                            }
                            onConfirm={(lines) =>
                              act(async () =>
                                setActive(
                                  await api(
                                    `/api/cases/${active.id}/requirements`,
                                    {
                                      requirements: lines.map((text, i) => ({
                                        id: `req_${i + 1}`,
                                        text,
                                      })),
                                    },
                                  ),
                                ),
                              )
                            }
                            onAssess={() =>
                              act(async () =>
                                setActive(
                                  await api(
                                    `/api/cases/${active.id}/investigate`,
                                    {},
                                  ),
                                ),
                              )
                            }
                            onDocuments={async (documents) => {
                              setActive(
                                await api(`/api/cases/${active.id}/documents`, {
                                  documents,
                                }),
                              );
                            }}
                          />
                        ) : (
                          <div className="scope">
                            <h3>Agreed scope</h3>
                            <p>{scope?.text}</p>
                            <div className="controls">
                              <button
                                disabled={
                                  busy ||
                                  !["ready", "complete", "failed"].includes(
                                    active.status,
                                  )
                                }
                                className="secondary"
                                onClick={() =>
                                  void act(async () =>
                                    setActive(
                                      await api(
                                        `/api/cases/${active.id}/scope`,
                                        {
                                          selection: "filtered",
                                        },
                                      ),
                                    ),
                                  )
                                }
                              >
                                {scope?.confirmedAt
                                  ? "Confirm new scope version"
                                  : "Confirm scope"}
                              </button>
                              <button
                                disabled={
                                  busy ||
                                  !scope?.confirmedAt ||
                                  ["running", "analysing"].includes(
                                    active.status,
                                  )
                                }
                                onClick={() =>
                                  void act(async () =>
                                    setActive(
                                      await api(`/api/cases/${active.id}/run`, {
                                        operationId: crypto.randomUUID(),
                                      }),
                                    ),
                                  )
                                }
                              >
                                <Play size={15} />
                                Run demonstration
                              </button>
                            </div>
                          </div>
                        )}
                        <ol className="events">
                          {active.events.map((event) => (
                            <li key={event.id} id={`event-${event.id}`}>
                              <time>
                                {new Date(event.occurredAt).toLocaleTimeString(
                                  [],
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                              </time>
                              <button
                                className={`event ${selected === event.id ? "selected" : ""}`}
                                aria-pressed={selected === event.id}
                                onClick={() => setSelected(event.id)}
                              >
                                <strong>
                                  {event.title}
                                  <ArrowRight size={16} />
                                </strong>
                                <p>{event.detail}</p>
                                <small>
                                  {event.provenance === "supplied"
                                    ? "Supplied evidence"
                                    : "Observed event"}{" "}
                                  · {event.artifactIds.length} artifacts
                                </small>
                              </button>
                            </li>
                          ))}
                        </ol>
                      </>
                    )}
                    {view === "conversation" && active.intake && (
                      <section>
                        <h2>Supplied conversation</h2>
                        <p className="small muted">
                          Received snapshot · {active.intake.provider} ·{" "}
                          {active.intake.messages.length} messages. Conversation
                          claims are not verified execution.
                        </p>
                        {active.intake.sourceUrl && (
                          <a
                            href={active.intake.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open source conversation
                          </a>
                        )}
                        {active.intake.warnings.map((w) => (
                          <p className="small" key={w}>
                            {w}
                          </p>
                        ))}
                        {active.intake.messages.map((m, i) => (
                          <article
                            className="transcript-message"
                            key={`${m.id}-${i}`}
                          >
                            <h3>{m.role === "user" ? "User" : "Assistant"}</h3>
                            <p>{m.text}</p>
                          </article>
                        ))}
                      </section>
                    )}
                    {view === "comparison" && !active.intake && (
                      <section>
                        <h2>Agreed vs delivered</h2>
                        <p>{scope?.text}</p>
                        {active.runs.length ? (
                          <div className="table-scroll">
                            <table>
                              <thead>
                                <tr>
                                  <th>Run</th>
                                  <th>Approved version</th>
                                  <th>Approved selection</th>
                                  <th>Executed selection</th>
                                  <th>Internal notes</th>
                                </tr>
                              </thead>
                              <tbody>
                                {active.runs.map((r, i) => (
                                  <tr key={r.id}>
                                    <th>{i + 1}</th>
                                    <td>
                                      v
                                      {
                                        active.scopes.find(
                                          (s) => s.id === r.scopeId,
                                        )?.version
                                      }
                                    </td>
                                    <td>
                                      {
                                        active.scopes.find(
                                          (s) => s.id === r.scopeId,
                                        )?.selection
                                      }
                                    </td>
                                    <td>{r.config.selection}</td>
                                    <td>
                                      {r.config.includeNotes
                                        ? "Included"
                                        : "Excluded"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p>No execution has been recorded yet.</p>
                        )}
                      </section>
                    )}
                    {view === "dashboard" && !active.intake && (
                      <ProjectDashboard key={active.id} data={active} />
                    )}
                    {latest && (
                      <div className="findings">
                        <h2>
                          {currentFindings ? "Findings" : "Previous findings"}
                        </h2>
                        {!currentFindings && (
                          <p className="muted">
                            These findings do not describe a completed
                            investigation of the current case state.
                          </p>
                        )}
                        {latest.findings.map((f) => (
                          <article key={f.criterion}>
                            <span className={`finding-status ${f.status}`}>
                              {f.status.replaceAll("_", " ")}
                            </span>
                            <h3>
                              {active.intake
                                ? active.scopes
                                    .find((s) => s.id === latest.scopeId)
                                    ?.requirements?.find(
                                      (r) => r.id === f.criterion,
                                    )?.text || f.criterion
                                : f.criterion === "selection"
                                  ? "Only approved tasks exported"
                                  : f.criterion === "notes"
                                    ? "Internal notes excluded"
                                    : "Source data unchanged"}
                            </h3>
                            <p>{f.explanation}</p>
                            {latest.decision?.answers[f.criterion] && (
                              <div className="decision-probabilities">
                                <p className="small muted">
                                  {latest.decision.model} · Live model
                                  probabilities
                                </p>
                                {Object.entries(
                                  latest.decision.answers[f.criterion]
                                    .probabilities,
                                ).map(([status, probability]) => (
                                  <div key={status}>
                                    <span>{status.replaceAll("_", " ")}</span>
                                    <meter
                                      min={0}
                                      max={1}
                                      value={probability}
                                      aria-label={`${status} probability`}
                                    />
                                    <strong>
                                      {(probability * 100).toFixed(1)}%
                                    </strong>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="evidence-links">
                              {f.evidenceIds.map((id) => (
                                <button
                                  className="evidence-link"
                                  key={id}
                                  onClick={() => selectEvidence(id)}
                                >
                                  {active.events.find((e) => e.id === id)
                                    ?.title || "Evidence reference"}
                                </button>
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    <button
                      className="delete secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api(`/api/cases/${active.id}`, {}, "DELETE");
                          setActive(null);
                          await refresh();
                        })
                      }
                    >
                      <Trash2 size={15} />
                      Delete this case
                    </button>
                  </section>
                  <aside className="inspector">
                    <h2>Linked evidence</h2>
                    {selectedEvent && (
                      <div className="selected-evidence">
                        <h3>{selectedEvent.title}</h3>
                        <p className="small">{selectedEvent.detail}</p>
                        {selectedEvent.scopeId && (
                          <p className="small">
                            Scope v
                            {
                              active.scopes.find(
                                (s) => s.id === selectedEvent.scopeId,
                              )?.version
                            }
                            :{" "}
                            {
                              active.scopes.find(
                                (s) => s.id === selectedEvent.scopeId,
                              )?.text
                            }
                          </p>
                        )}
                        {latest?.findings
                          .filter((f) => f.evidenceIds.includes(selected))
                          .map((f) => (
                            <p className="small" key={f.criterion}>
                              {f.criterion}: {f.status.replaceAll("_", " ")}
                            </p>
                          ))}
                        <button
                          className="secondary"
                          onClick={() => setSelected("")}
                        >
                          Show all evidence
                        </button>
                      </div>
                    )}
                    {artifacts?.length ? (
                      artifacts.map((a) => (
                        <a
                          className="artifact"
                          href={`/api/cases/${active.id}/artifacts/${a.id}`}
                          key={a.id}
                        >
                          <FileSearch size={21} />
                          <span>
                            <strong>{a.name}</strong>
                            <small>
                              {a.kind} · Integrity checked on download
                            </small>
                          </span>
                          <Download size={16} />
                        </a>
                      ))
                    ) : (
                      <p className="muted small">
                        Select an execution event to inspect its artifacts.
                      </p>
                    )}
                    <Chat
                      key={active.id}
                      name={`${sessionId}_${active.id}`}
                      events={active.events}
                      onEvidence={selectEvidence}
                    />
                  </aside>
                </div>
              </>
            ) : (
              <IntakeForm
                local={Boolean(config?.local)}
                onExample={() => void act(create)}
                onCreate={async (input) => {
                  setActive(await api("/api/intake", input));
                  setSelected("");
                  setView("timeline");
                  await refresh();
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
