import React, { useEffect, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
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
  Settings,
  Compass,
} from "lucide-react";
import type { CaseView, Scenario } from "../shared/domain";
import { tasks, TaskSchema } from "../shared/domain";
import "./style.css";
import { EvidenceControls } from "./evidence-plan";
import { IntakeForm, Requirements } from "./intake";
import type { SettingsView } from "../shared/settings";
import { ChatMetadata } from "../shared/chat";
import { ChatProgress, ChatFailureNotice } from "./chat-feedback";
import {
  ApplicationSettings,
  tourInitiallyOpen,
  dismissTour,
  focusTarget,
} from "./guidance";

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
  data,
  mode,
  onCaseChanged,
  onSettings,
  onEvidence,
  messageTarget,
  conversationOpen,
  onInteract,
  workspace,
}: {
  name: string;
  data: CaseView;
  mode: string;
  onCaseChanged: () => void;
  onSettings: () => void;
  onEvidence: (id: string) => void;
  messageTarget: HTMLDivElement | null;
  conversationOpen: boolean;
  onInteract: () => void;
  workspace: React.RefObject<HTMLDivElement | null>;
}) {
  const { events } = data;
  const agent = useAgent({
    agent: "case-agent",
    name,
    onStateUpdate: () => onCaseChanged(),
  });
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");
  const awaitingAnswer = useRef(false);
  const interrupted = useRef(false);
  const [failure, setFailure] = useState("");
  const { messages, sendMessage, status, error, regenerate, stop } = useAgentChat({
    agent,
  });
  const busy = status === "submitted" || status === "streaming";
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  // Also cover a lost WebSocket response, which a server deadline cannot deliver.
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => {
      interrupted.current = true;
      setFailure("The response took too long. Your question is preserved.");
      void stop();
    }, 75000);
    return () => clearTimeout(timer);
  }, [busy, stop]);
  const [dismissedSuggestion, setDismissedSuggestion] = useState("");
  const latestMessage = messages.at(-1);
  const metadata = ChatMetadata.safeParse(latestMessage?.metadata);
  const responseFailed = metadata.success && metadata.data.outcome === "failed";
  const incomplete = latestMessage?.role === "user" || (metadata.success && metadata.data.outcome === "pending");
  const retryAnswer = () => {
    onInteract();
    interrupted.current = false;
    setFailure("");
    setSubmitted(messages.filter((m) => m.role === "user").at(-1)?.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n") || "");
    void regenerate().catch(() => setFailure("The connection was interrupted. Your question is still here. Please retry."));
  };
  const stopAnswer = () => {
    interrupted.current = true;
    setFailure("The response was stopped. Your question is still here.");
    void stop();
  };
  const suggestion =
    latestMessage?.role === "assistant" &&
    latestMessage.id !== dismissedSuggestion &&
    status === "ready" && !error && mode === "live" && draft === "" &&
    metadata.success
      ? metadata.data.suggestion.trim()
      : "";
  // Keep messages in the single case scroll area; the composer stays docked.
  useLayoutEffect(() => {
    if (!conversationOpen) return;
    const frame = requestAnimationFrame(() => {
      const area = workspace.current;
      area?.scrollTo({ top: area.scrollHeight });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, status, error, failure, conversationOpen, messageTarget, workspace]);
  useLayoutEffect(() => {
    const area = workspace.current;
    if (!conversationOpen || !area) return;
    const observer = new ResizeObserver(() => {
      area.scrollTo({ top: area.scrollHeight });
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [conversationOpen, workspace]);
  useEffect(() => {
    if (status === "submitted" || status === "streaming")
      awaitingAnswer.current = true;
    if (status === "ready" && !error && !responseFailed && !incomplete && !interrupted.current && submitted && awaitingAnswer.current) {
      setDraft((current) => (current === submitted ? "" : current));
      setSubmitted("");
      awaitingAnswer.current = false;
    }
  }, [status, error, submitted, responseFailed, incomplete]);
  const linkedText = (text: string): React.ReactNode =>
    text.split(/(\[[a-zA-Z0-9_, -]+\])/g).map((part, index) => {
      if (part.startsWith("[") && part.includes(",")) {
        return (
          <React.Fragment key={index}>
            {part
              .slice(1, -1)
              .split(/,\s*/)
              .map((id, i) => (
                <React.Fragment key={`${id}-${i}`}>
                  {i > 0 && ", "}
                  {linkedText(`[${id.trim()}]`)}
                </React.Fragment>
              ))}
          </React.Fragment>
        );
      }
      const reference = part.slice(1, -1);
      const artifact = data.artifacts.find((a) => a.id === reference);
      if (artifact)
        return (
          <a
            className="evidence-link"
            key={index}
            href={`/api/cases/${data.id}/artifacts/${artifact.id}`}
          >
            {artifact.name}
          </a>
        );
      const event = events.find(
        (e) =>
          `[${e.id}]` === part ||
          e.scopeId === reference ||
          e.runId === reference,
      );
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
      <div className="chat-heading">
        <h2>Investigation chat</h2>
        <span className="small muted">
          {mode === "live"
            ? "Llama 3.3 · Cloudflare AI"
            : "Offline · AI is off"}
        </span>
        {mode !== "live" && (
          <button
            className="evidence-link"
            onClick={() => {
              onInteract();
              onSettings();
            }}
          >
            Enable AI in settings
          </button>
        )}
      </div>
      {messageTarget &&
        createPortal(
          <section
            className="investigation-messages"
            aria-label="Investigation conversation"
          >
            <h2>Investigation conversation</h2>
            <p className="small muted">
              Ask about the scope, timeline, evidence, or findings.{" "}
              {events.length} timeline events · {data.artifacts.length}{" "}
              artifacts · {data.status.replaceAll("_", " ")}
            </p>
            {!messages.length && (
              <p className="muted">
                Your questions and answers will appear here.
              </p>
            )}
            <div
              className="messages"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {messages.map((m) => {
                const info = ChatMetadata.safeParse(m.metadata);
                const failed = info.success ? info.data.failure : undefined;
                const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
                if (!text && !failed) return null;
                return <div className={`message ${m.role}${failed ? " message-failed" : ""}`} key={m.id}>
                  <strong>{m.role === "user" ? "You" : "IntentTrace"}</strong>
                  {failed && <ChatFailureNotice failure={failed} />}
                  <p>{linkedText(text)}</p>
                  {failed && m.id === latestMessage?.id && !busy && <div className="chat-feedback-actions">
                    {(failed.retryable || (failed.retryAt && Date.parse(failed.retryAt) <= Date.now())) && <button className="secondary" onClick={retryAnswer}>Retry answer</button>}
                    {failed.code === "expired" && <button className="secondary" onClick={() => window.location.reload()}>Refresh session</button>}
                    {events.length > 0 && <button className="secondary" onClick={() => onEvidence(events.at(-1)!.id)}>Review timeline</button>}
                  </div>}
                </div>
              })}
            </div>
            {!busy && !responseFailed && (error || failure || incomplete) && (
              <div className="message assistant message-failed" role="alert">
                <strong>IntentTrace</strong>
                <p>{failure || (error ? "The connection was interrupted before the answer could finish. Your question is still here." : "This question has no completed answer yet. Retry to continue.")}</p>
                <div className="chat-feedback-actions"><button className="secondary" onClick={retryAnswer}>Retry answer</button>
                {events.length > 0 && <button className="secondary" onClick={() => onEvidence(events.at(-1)!.id)}>Review timeline</button>}</div>
              </div>
            )}
            {busy && <ChatProgress stage={metadata.success && metadata.data.outcome === "pending" ? metadata.data.stage : undefined} elapsed={elapsed} onStop={stopAnswer} />}
          </section>,
          messageTarget,
        )}
      <form
        onFocusCapture={onInteract}
        onPointerDown={onInteract}
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim() || status === "submitted" || status === "streaming")
            return;
          onInteract();
          interrupted.current = false;
          setFailure("");
          setSubmitted(draft);
          const pendingQuestion = latestMessage?.role === "user" || responseFailed || incomplete
            ? messages.filter((m) => m.role === "user").at(-1)?.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
            : undefined;
          void (pendingQuestion === draft
            ? regenerate()
            : sendMessage({ text: draft })).catch(() => setFailure("The connection was interrupted. Your question is still here. Please retry."));
        }}
      >
        <label className="sr-only" htmlFor="question">
          Ask about this case
        </label>
        <textarea
          id="question"
          maxLength={2000}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onInteract();
          }}
          placeholder={suggestion || "Where did delivery diverge?"}
          aria-describedby={suggestion ? "prompt-suggestion-hint" : undefined}
          onKeyDown={(e) => {
            if (!suggestion || e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setDismissedSuggestion(latestMessage!.id);
            } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
              e.preventDefault();
              setDraft(suggestion);
            }
          }}
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
      {busy && <p className="chat-composer-state">Preparing your answer · {elapsed}s · You can keep typing while you wait.</p>}
      {!busy && responseFailed && <p className="chat-composer-state">{metadata.success ? metadata.data.failure?.title : "Answer unavailable"} · Your question is preserved above.</p>}
      {suggestion && (
        <p id="prompt-suggestion-hint" className="small muted" role="status">
          Suggested follow-up · Tab to accept · Esc to dismiss
        </p>
      )}
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
  const [evidencePlanDirty, setEvidencePlanDirty] = useState(false);
  const [sessionId, setSessionId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("divergence"),
    [selected, setSelected] = useState("");
  const [view, setView] = useState("timeline");
  const [selectionRestored, setSelectionRestored] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  const [messageTarget, setMessageTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [artifactId, setArtifactId] = useState("");
  const openConversation = () => {
    setView("conversation");
    requestAnimationFrame(() => {
      const area = workspace.current;
      area?.scrollTo({ top: area.scrollHeight });
    });
  };
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [guideOpen, setGuideOpen] = useState(tourInitiallyOpen);
  const settingsVersion = useRef(0);
  const settingsSaving = useRef(false);
  const upload = useRef<HTMLInputElement>(null),
    turnstile = useRef<HTMLDivElement>(null);
  const refresh = async () => {
    const s = await api("/api/cases");
    setCases(s.cases);
    setSessionId(s.sessionId);
    setSettings(await api<SettingsView>("/api/settings"));
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
          let saved: { caseId?: string; view?: string } | undefined;
          try {
            saved = JSON.parse(sessionStorage.getItem(`intenttrace-view:${s.sessionId}`) || "null") || undefined;
          } catch {}
          const id = saved?.caseId === ""
            ? undefined
            : s.cases.find((c: { id: string }) => c.id === saved?.caseId)?.id || s.cases[0]?.id;
          if (id) {
            const restored = await api<CaseView>(`/api/cases/${id}`);
            setActive(restored);
            const views = restored.intake
              ? ["timeline", "conversation"]
              : ["timeline", "conversation", "comparison", "dashboard"];
            if (saved && saved.caseId === id && views.includes(saved.view || "")) setView(saved.view!);
          }
        } catch {
          if (c.local) await begin();
        }
        setSelectionRestored(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!selectionRestored || !sessionId) return;
    try {
      sessionStorage.setItem(`intenttrace-view:${sessionId}`, JSON.stringify({ caseId: active?.id || "", view }));
    } catch {}
  }, [selectionRestored, sessionId, active?.id, view]);
  useEffect(() => {
    if (!sessionId) return;
    const update = () => {
      if (settingsSaving.current) return;
      const version = settingsVersion.current;
      void api<SettingsView>("/api/settings")
        .then((value) => {
          if (version === settingsVersion.current) setSettings(value);
        })
        .catch(() => {});
    };
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, [sessionId]);
  const openSettings = () => {
    setSettingsOpen(true);
    requestAnimationFrame(() => focusTarget("application-settings"));
  };
  const changeSettings = async (clefEnabled: boolean) => {
    settingsSaving.current = true;
    settingsVersion.current++;
    setSettingsPending(true);
    setError("");
    try {
      setSettings(await api<SettingsView>("/api/settings", { clefEnabled }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      settingsSaving.current = false;
      setSettingsPending(false);
    }
  };
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
  const visibleArtifact =
    artifacts?.find((a) => a.id === artifactId) || artifacts?.[0];
  const settingsPanel = settingsOpen && (
    <ApplicationSettings
      settings={settings}
      pending={settingsPending}
      onChange={(enabled) => void changeSettings(enabled)}
    />
  );
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
          <label className="sr-only" htmlFor="case-picker">
            Open a case
          </label>
          <select
            id="case-picker"
            value={active?.id || ""}
            disabled={busy || !sessionId}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) {
                setActive(null);
                setSelected("");
                return;
              }
              void act(async () => {
                setActive(await api(`/api/cases/${id}`));
                setSelected("");
                setView("timeline");
              });
            }}
          >
            <option value="">New investigation</option>
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
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
          <div className="header-actions">
            <span className="badge">
              {settings
                ? settings.mode === "live"
                  ? "Clef on · Live AI"
                  : "Clef off · Offline"
                : "Connecting"}
            </span>
            <button
              className="secondary"
              disabled={!sessionId}
              aria-expanded={settingsOpen}
              aria-controls="application-settings"
              onClick={() =>
                settingsOpen ? setSettingsOpen(false) : openSettings()
              }
            >
              <Settings size={17} aria-hidden="true" /> Settings
            </button>
          </div>
        </header>
        {!sessionId ? (
          <div
            className="workspace"
            ref={workspace}
            tabIndex={0}
            aria-label="Case workspace"
          >
            {settingsPanel}
            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}
            <section className="empty">
              <h2>Start a private demo session</h2>
              <p>
                Open your private case desk. Case records expire after 24 hours.
              </p>
              <div ref={turnstile} />
              {config?.local && (
                <button onClick={() => void act(() => begin())}>
                  Start local session
                </button>
              )}
            </section>
          </div>
        ) : (
          <>
            {active ? (
              <>
                <div
                  className={`status-strip ${!currentFindings || latest?.findings.some((f) => f.status !== "supported") ? "warn" : ""}`}
                >
                  <strong>
                    {active.status === "failed"
                      ? "Investigation failed · Previous findings remain below"
                      : active.status === "running"
                        ? "Execution in progress"
                        : active.status === "analysing"
                          ? "Investigation in progress"
                          : currentFindings && latest.decision?.mode === "unavailable"
                            ? "Model assessment unavailable · Captures and direct checks saved"
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
                        ["conversation", "Conversation"],
                        ["comparison", "Agreed vs delivered"],
                        ["dashboard", "Demo dashboard"],
                      ]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={view === id ? "selected" : "secondary"}
                      aria-pressed={view === id}
                      onClick={() =>
                        id === "conversation" ? openConversation() : setView(id)
                      }
                    >
                      {label}
                    </button>
                  ))}
                  {active.intake && (
                    <button
                      className="secondary"
                      onClick={() => {
                        setGuideOpen(true);
                        setView("timeline");
                        requestAnimationFrame(() =>
                          focusTarget("guide-heading"),
                        );
                      }}
                    >
                      <Compass size={16} aria-hidden="true" /> Guided tour
                    </button>
                  )}
                </nav>
                <div className="case-shell">
                  <div
                    className="workspace"
                    ref={workspace}
                    tabIndex={0}
                    aria-label="Case workspace"
                  >
                    {settingsPanel}
                    {error && (
                      <div className="alert" role="alert">
                        {error}
                      </div>
                    )}
                    {active && !active.intake && (
                      <div className="toolbar">
                        <label>
                          Scenario{" "}
                          <select
                            value={scenario}
                            onChange={(e) =>
                              setScenario(e.target.value as Scenario)
                            }
                          >
                            <option value="divergence">Scope divergence</option>
                            <option value="correct">Correct delivery</option>
                            <option value="missing">Missing evidence</option>
                          </select>
                        </label>
                        <button
                          disabled={busy}
                          onClick={() => void act(create)}
                        >
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
                    <section className="timeline">
                      <div hidden={view !== "timeline"}>
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
                          <EvidenceControls key={active.id} data={active} busy={busy || ["running", "analysing"].includes(active.status)} onSaved={setActive} onDirty={setEvidencePlanDirty} />
                          {active.intake ? (
                            <Requirements
                              onDraft={async () =>
                                (
                                  await api(
                                    `/api/cases/${active.id}/draft-requirements`,
                                    {},
                                  )
                                ).requirements.map(
                                  (r: { text: string }) => r.text,
                                )
                              }
                              key={`${active.id}-${scope?.id}`}
                              data={active}
                              clefEnabled={Boolean(settings?.clefEnabled)}
                              guideOpen={guideOpen}
                              onSettings={openSettings}
                              onDismissGuide={() => {
                                dismissTour();
                                setGuideOpen(false);
                              }}
                              onFindings={() => {
                                focusTarget("case-findings");
                              }}
                              busy={
                                busy || evidencePlanDirty ||
                                settingsPending ||
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
                                  await api(
                                    `/api/cases/${active.id}/documents`,
                                    {
                                      documents,
                                    },
                                  ),
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
                                        await api(
                                          `/api/cases/${active.id}/run`,
                                          {
                                            operationId: crypto.randomUUID(),
                                          },
                                        ),
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
                              <li
                                key={event.id}
                                id={`event-${event.id}`}
                                tabIndex={-1}
                              >
                                <time>
                                  {new Date(
                                    event.occurredAt,
                                  ).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
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
                                  {selected === event.id && (
                                    <>
                                      {event.scopeId && (
                                        <p>
                                          Scope v
                                          {
                                            active.scopes.find(
                                              (s) => s.id === event.scopeId,
                                            )?.version
                                          }
                                          :{" "}
                                          {
                                            active.scopes.find(
                                              (s) => s.id === event.scopeId,
                                            )?.text
                                          }
                                        </p>
                                      )}
                                      {latest?.findings
                                        .filter((f) =>
                                          f.evidenceIds.includes(event.id),
                                        )
                                        .map((f) => (
                                          <p key={f.criterion}>
                                            {f.criterion}:{" "}
                                            {f.status.replaceAll("_", " ")}
                                          </p>
                                        ))}
                                    </>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ol>
                      </div>
                      <div hidden={view !== "conversation"}>
                        {active.intake && (
                          <section>
                            <h2>Supplied conversation</h2>
                            <p className="small muted">
                              Received snapshot · {active.intake.provider} ·{" "}
                              {active.intake.messages.length} messages.
                              Conversation claims are not verified execution.
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
                            <details className="supplied-transcript">
                              <summary>
                                Read supplied conversation (
                                {active.intake.messages.length} messages)
                              </summary>
                              {active.intake.messages.map((m, i) => (
                                <article
                                  className="transcript-message"
                                  key={`${m.id}-${i}`}
                                >
                                  <h3>
                                    {m.role === "user" ? "User" : "Assistant"}
                                  </h3>
                                  <p>{m.text}</p>
                                </article>
                              ))}
                            </details>
                          </section>
                        )}
                        <div ref={setMessageTarget} />
                      </div>
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
                      {latest && view !== "conversation" && (
                        <div
                          className="findings"
                          id="case-findings"
                          tabIndex={-1}
                        >
                          <h2>
                            {currentFindings ? "Findings" : "Previous findings"}
                          </h2>
                          {latest.research && (
                            <details className="research-coverage" open>
                              <summary>
                                Online evidence:{" "}
                                {
                                  latest.research.sources.filter(
                                    (s) => s.status === "captured",
                                  ).length
                                }{" "}
                                sources read
                              </summary>
                              <p className="small muted">
                                Llama 3.3 examines the evidence; CLEF assesses
                                each confirmed requirement. Probabilities
                                describe model judgments, not delivery
                                percentages.
                              </p>
                              <ul>
                                {latest.research.sources.map((s, i) => (
                                  <li key={i}>
                                    <a
                                      href={s.url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {s.url}
                                    </a>{" "}
                                    — {s.detail}{" "}
                                    <span className="muted">
                                      {new Date(s.capturedAt).toLocaleString()}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                              <p className="small">Coverage: {latest.research.coverageMode || "targeted"}. {latest.research.stopReason?.replaceAll("_", " ") || "Collection complete."} {latest.research.discovered !== undefined ? `${latest.research.discovered} relevant URLs discovered.` : "This earlier run did not record its discovered URL count."}</p>
                              {!!latest.research.unvisited?.length && <details><summary>{latest.research.unvisited.length} discovered URLs not visited</summary><ul>{latest.research.unvisited.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul></details>}
                              {!!latest.research.checks?.length && <details open><summary>Acceptance check results</summary><ul>{latest.research.checks.map((check) => <li key={check.id}><strong>{check.requirementId} · {check.status.replaceAll("_", " ")}</strong> — {check.label}<p>{check.explanation}</p>{check.artifactIds.map((id) => <a key={id} href={`/api/cases/${active.id}/artifacts/${id}`} target="_blank" rel="noreferrer">Source {id.slice(0, 8)} </a>)}</li>)}</ul></details>}
                              {latest.research.limitations.map((s, i) => (
                                <p className="small muted" key={i}>
                                  {s}
                                </p>
                              ))}
                            </details>
                          )}
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
                              {!!f.observations?.length && (
                                <div>
                                  <h4>What the evidence shows</h4>
                                  <ul>
                                    {f.observations.map((s, i) => (
                                      <li key={i}>{s}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {!!f.gaps?.length && (
                                <div>
                                  <h4>What remains unverified</h4>
                                  <ul>
                                    {f.gaps.map((s, i) => (
                                      <li key={i}>{s}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {!!f.nextSteps?.length && (
                                <div>
                                  <h4>How to resolve this</h4>
                                  <ul>
                                    {f.nextSteps.map((s, i) => (
                                      <li key={i}>{s}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {!!f.citations?.length && (
                                <details>
                                  <summary>
                                    Source quotations ({f.citations.length})
                                  </summary>
                                  {f.citations.map((citation, i) => (
                                    <blockquote key={i}>
                                      <p>{citation.quote}</p>
                                      <footer>
                                        {citation.source.startsWith(
                                          "https://",
                                        ) ? (
                                          <a
                                            href={citation.source}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            {citation.source}
                                          </a>
                                        ) : (
                                          citation.source
                                        )}
                                        {citation.capturedAt &&
                                          ` · Observed ${new Date(citation.capturedAt).toLocaleString()}`}
                                      </footer>
                                    </blockquote>
                                  ))}
                                </details>
                              )}
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
                      {view !== "conversation" && (
                        <button
                          className="delete secondary"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api(
                                `/api/cases/${active.id}`,
                                {},
                                "DELETE",
                              );
                              setActive(null);
                              await refresh();
                            })
                          }
                        >
                          <Trash2 size={15} />
                          Delete this case
                        </button>
                      )}
                    </section>
                  </div>
                  <aside className="inspector">
                    <h2>Linked evidence</h2>
                    {selectedEvent && (
                      <div className="selected-evidence">
                        <h3>{selectedEvent.title}</h3>
                        <button
                          className="evidence-link"
                          onClick={() => selectEvidence(selectedEvent.id)}
                        >
                          Read event in Timeline
                        </button>
                        <button
                          className="secondary"
                          onClick={() => setSelected("")}
                        >
                          Show all evidence
                        </button>
                      </div>
                    )}
                    {artifacts?.length ? (
                      <>
                        <label className="small" htmlFor="artifact-picker">
                          Artifacts ({artifacts.length})
                        </label>
                        <select
                          id="artifact-picker"
                          value={visibleArtifact?.id || ""}
                          onChange={(e) => setArtifactId(e.target.value)}
                        >
                          {artifacts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                        {visibleArtifact && (
                          <a
                            className="artifact"
                            href={`/api/cases/${active.id}/artifacts/${visibleArtifact.id}`}
                            aria-label={`Download ${visibleArtifact.name} · ${visibleArtifact.kind} · Integrity checked on download`}
                            title={`Download ${visibleArtifact.name}`}
                          >
                            <FileSearch size={21} />
                            <span>
                              <strong>{visibleArtifact.name}</strong>
                              <small>
                                {visibleArtifact.kind} · Integrity checked on
                                download
                              </small>
                            </span>
                            <Download size={16} />
                          </a>
                        )}
                      </>
                    ) : (
                      <p className="muted small">
                        Select an execution event to inspect its artifacts.
                      </p>
                    )}
                  </aside>
                </div>
                <Chat
                  key={active.id}
                  name={`${sessionId}_${active.id}`}
                  data={active}
                  mode={settings?.mode || "offline"}
                  onSettings={openSettings}
                  onCaseChanged={() => {
                    const id = active.id;
                    void api<CaseView>(`/api/cases/${id}`)
                      .then((value) =>
                        setActive((current) =>
                          current?.id === id ? value : current,
                        ),
                      )
                      .catch((e) => setError(e.message));
                  }}
                  onEvidence={selectEvidence}
                  messageTarget={messageTarget}
                  conversationOpen={view === "conversation"}
                  onInteract={openConversation}
                  workspace={workspace}
                />
              </>
            ) : (
              <div
                className="workspace"
                ref={workspace}
                tabIndex={0}
                aria-label="Case workspace"
              >
                {settingsPanel}
                {error && (
                  <div className="alert" role="alert">
                    {error}
                  </div>
                )}
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
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
const root =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<App />);
