import React, { useState } from "react";
import { FileSearch, Upload, ArrowRight } from "lucide-react";
import {
  IntakeSchema,
  normalizeConversation,
  parseTranscript,
  type Intake,
  type ImportedDocument,
} from "../shared/intake";
import type { CaseView } from "../shared/domain";
import { readArtifact } from "./files";

async function source(url: string, kind: string): Promise<any> {
  const r = await fetch("/local/source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, kind }),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(data.error || "Source import failed.");
  return data;
}
export function ArtifactInput({
  onAdd,
  disabled = false,
  onPending,
}: {
  onAdd: (docs: ImportedDocument[]) => Promise<void>;
  disabled?: boolean;
  onPending?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [url, setUrl] = useState(""),
    [paste, setPaste] = useState(""),
    [name, setName] = useState("artifact.txt");
  const load = async (fn: () => Promise<ImportedDocument[]>) => {
    setBusy(true);
    onPending?.(true);
    setError("");
    try {
      await onAdd(await fn());
      setUrl("");
      setPaste("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onPending?.(false);
    }
  };
  return (
    <div className="artifact-input">
      <label className="file-button">
        <Upload size={16} /> Add artifact files
        <input
          type="file"
          multiple
          disabled={disabled || busy}
          accept=".txt,.md,.csv,.json,.jsonl,.pdf,.docx,.html,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.css,.sql,.log"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            if (files.length)
              void load(async () => {
                if (files.length > 8)
                  throw new Error("Choose at most eight artifacts.");
                return Promise.all(files.map(readArtifact));
              });
          }}
        />
      </label>
      <label>
        Or a public artifact URL
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… (public text, code or HTML)"
          disabled={disabled || busy}
        />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={disabled || busy || !url.trim()}
        onClick={() => void load(async () => [await source(url, "artifact")])}
      >
        {busy ? "Reading artifact…" : "Add linked artifact"}
      </button>
      <details>
        <summary>Or paste artifact text</summary>
        <label>
          Artifact name
          <input
            disabled={disabled || busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={150}
          />
        </label>
        <label>
          Artifact text
          <textarea
            disabled={disabled || busy}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            maxLength={300000}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={disabled || busy || !paste.trim() || !name.trim()}
          onClick={() =>
            void load(async () => [
              { name, content: paste, mediaType: "text/plain" },
            ])
          }
        >
          Add pasted artifact
        </button>
      </details>
      <p className="small muted">
        Text, code, CSV, JSON, PDF and DOCX · 5 MiB per file. PDF/DOCX
        assessment covers extracted text; images, layout and execution need
        separate evidence.
      </p>
      {error && (
        <p role="alert" className="input-error">
          {error}
        </p>
      )}
    </div>
  );
}
export function IntakeForm({
  onCreate,
  onExample,
  local,
}: {
  onCreate: (input: Intake) => Promise<void>;
  onExample: () => void;
  local: boolean;
}) {
  const [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [manual, setManual] = useState(false);
  const [preview, setPreview] = useState<Partial<Intake>>({
    provider: "manual",
    messages: [],
    warnings: [],
  });
  const [title, setTitle] = useState("Conversation investigation"),
    [prompt, setPrompt] = useState(""),
    [transcript, setTranscript] = useState("");
  const [documents, setDocuments] = useState<ImportedDocument[]>([]),
    [choices, setChoices] = useState<any[]>([]);
  const [documentBusy, setDocumentBusy] = useState(false);
  const accept = (value: any, extra: Partial<Intake> = {}) => {
    const c = normalizeConversation(value);
    setPreview({ ...c, provider: "export", warnings: [], ...extra });
    setTitle(c.title);
    setPrompt(
      c.messages.find((m) => m.role === "user")?.text.slice(0, 6000) || "",
    );
    setManual(true);
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      setManual(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="intake">
      <div className="intake-heading">
        <FileSearch size={30} />
        <div>
          <h2>Did the AI deliver what you asked for?</h2>
          <p>
            Start with your conversation. Add the delivered artifact, then
            review the requirements before assessment.
          </p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            const data = await source(url, "conversation");
            accept(data, {
              provider: data.provider,
              sourceUrl: data.sourceUrl,
              warnings: data.warnings,
            });
          });
        }}
      >
        <label htmlFor="shared-link">
          ChatGPT or Claude shared conversation link
        </label>
        <div className="link-entry">
          <input
            id="shared-link"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://chatgpt.com/share/… or https://claude.ai/share/…"
            disabled={busy}
          />
          <button disabled={busy || !url.trim() || !local}>
            {busy ? "Reading conversation…" : "Read shared conversation"}
            <ArrowRight size={16} />
          </button>
        </div>
        <p className="small muted">
          Only public conversation links. Shared snapshots can omit attachments,
          so add those separately.{" "}
          {local
            ? "The local app fetches the link without your ChatGPT or Claude login."
            : "Shared-link fetching is available in the downloaded local app. Use the fallback here."}
        </p>
      </form>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="secondary"
        onClick={() => setManual(!manual)}
      >
        {manual
          ? "Hide intake details"
          : "Use an export, paste a conversation, or enter a prompt"}
      </button>
      {manual && (
        <div className="intake-details">
          <div className="intake-options">
            <label className="file-button">
              <Upload size={16} /> Import chat history JSON
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file)
                    void action(async () => {
                      if (file.size > 1048576)
                        throw new Error(
                          "Choose an export below 1 MiB, containing only the conversation you want to inspect.",
                        );
                      const value = JSON.parse(await file.text());
                      if (
                        Array.isArray(value) &&
                        value.length > 1 &&
                        (value[0].mapping || value[0].chat_messages)
                      ) {
                        setChoices(value);
                        return;
                      }
                      accept(value);
                    });
                }}
              />
            </label>
            {choices.length > 0 && (
              <label>
                Choose one conversation
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value !== "") {
                      accept(choices[Number(e.target.value)]);
                      setChoices([]);
                    }
                  }}
                >
                  <option value="" disabled>
                    Select a conversation
                  </option>
                  {choices.map((c, i) => (
                    <option key={i} value={i}>
                      {c.title || c.name || `Conversation ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Or paste a labelled conversation
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                maxLength={300000}
                placeholder={
                  "User: Original request\nAssistant: Response or delivery"
                }
              />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={busy || !transcript.trim()}
              onClick={() =>
                void action(async () =>
                  accept(parseTranscript(transcript), { provider: "manual" }),
                )
              }
            >
              Read pasted conversation
            </button>
          </div>
          <p className="small">
            {preview.messages?.length || 0} messages received. You can also
            start with just the original prompt and an artifact.
          </p>
          {preview.warnings?.map((w) => (
            <p className="small muted" key={w}>
              {w}
            </p>
          ))}
          <label>
            Case title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={150}
            />
          </label>
          <label>
            Original prompt
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={6000}
              placeholder="What did you ask the AI to produce?"
            />
          </label>
          <ArtifactInput
            disabled={busy}
            onPending={setDocumentBusy}
            onAdd={async (docs) => {
              if (documents.length + docs.length > 8)
                throw new Error("At most eight artifacts per intake.");
              setDocuments([...documents, ...docs]);
            }}
          />
          <ul className="intake-files">
            {documents.map((d, i) => (
              <li key={i}>
                <span>
                  {d.name} · {d.content.length.toLocaleString()} text characters
                </span>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setDocuments(documents.filter((_, n) => n !== i))
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <p className="small muted">
            In live mode, the prompt and selected evidence are sent to
            Cloudflare Workers AI. Evidence stays in the local case store and
            expires after 24 hours. Reports you download remain on your
            computer.
          </p>
          <button
            disabled={
              busy || documentBusy || prompt.trim().length < 3 || !title.trim()
            }
            onClick={() =>
              void action(async () => {
                const input = IntakeSchema.parse({
                  ...preview,
                  title,
                  originalPrompt: prompt,
                  documents,
                  messages: preview.messages || [],
                  warnings: preview.warnings || [],
                });
                if (
                  new TextEncoder().encode(JSON.stringify(input)).length >
                  1048576
                )
                  throw new Error(
                    "Selected evidence exceeds 1 MiB. Use a smaller relevant excerpt.",
                  );
                await onCreate(input);
              })
            }
          >
            {busy
              ? "Preparing case…"
              : documentBusy
                ? "Waiting for artifact…"
                : "Create investigation"}
          </button>
        </div>
      )}
      <div className="suggested-example">
        <strong>Want to explore first?</strong>
        <p>
          Try a synthetic CSV export case: correct delivery, scope divergence,
          or missing evidence.
        </p>
        <button className="secondary" onClick={onExample}>
          Open CSV example
        </button>
      </div>
    </section>
  );
}
export function Requirements({
  data,
  onConfirm,
  onAssess,
  onDocuments,
  busy,
}: {
  data: CaseView;
  onConfirm: (text: string[]) => Promise<void>;
  onAssess: () => Promise<void>;
  onDocuments: (docs: ImportedDocument[]) => Promise<void>;
  busy: boolean;
}) {
  const scope = data.scopes.at(-1)!;
  const [draft, setDraft] = useState(
      scope.requirements?.map((r) => r.text).join("\n") || "",
    ),
    [documentBusy, setDocumentBusy] = useState(false);
  const lines = draft
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const changed = draft !== scope.requirements?.map((r) => r.text).join("\n");
  const invalid =
    !lines.length ||
    lines.length > 12 ||
    lines.some((s) => s.length < 3 || s.length > 1000);
  return (
    <div className="scope">
      <h3>Review delivery requirements</h3>
      <p className="small">
        Drafts can miss nuance. Edit to one testable requirement per line, then
        confirm this version. A later approval does not establish what was
        approved in the original conversation.
      </p>
      <label>
        Requirements
        <textarea
          className="requirements-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy || documentBusy}
          maxLength={12000}
        />
      </label>
      <p className={`small ${invalid ? "input-error" : "muted"}`}>
        {invalid
          ? "Use 1–12 requirements, each between 3 and 1,000 characters. Split or shorten long lines."
          : `${lines.length} of 12 requirements · 3–1,000 characters each`}
      </p>
      <div className="controls">
        <button
          className="secondary"
          disabled={busy || documentBusy || invalid}
          onClick={() => void onConfirm(lines)}
        >
          {scope.confirmedAt
            ? "Confirm new requirements version"
            : "Confirm requirements"}
        </button>
        <button
          disabled={busy || documentBusy || !scope.confirmedAt || changed}
          onClick={() => void onAssess()}
        >
          {documentBusy ? "Waiting for artifact…" : "Assess with CLEF"}
        </button>
      </div>
      {changed && scope.confirmedAt && (
        <p className="small">Confirm your edits before assessment.</p>
      )}
      <ArtifactInput
        disabled={busy}
        onPending={setDocumentBusy}
        onAdd={onDocuments}
      />
    </div>
  );
}
