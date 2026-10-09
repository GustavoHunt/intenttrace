import { Settings, X, ArrowRight, Check } from "lucide-react";
import type { SettingsView } from "../shared/settings";

export const tourStorageKey = "intenttrace-assessment-tour-v1";
export function tourInitiallyOpen() {
  try {
    return localStorage.getItem(tourStorageKey) !== "dismissed";
  } catch {
    return true;
  }
}
export function dismissTour() {
  try {
    localStorage.setItem(tourStorageKey, "dismissed");
  } catch {}
}
export function focusTarget(id: string) {
  const el = document.getElementById(id);
  el?.scrollIntoView({
    block: "center",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
  el?.focus({ preventScroll: true });
}

export function ApplicationSettings({
  settings,
  pending,
  onChange,
}: {
  settings: SettingsView | null;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <section
      className="app-settings"
      id="application-settings"
      aria-labelledby="settings-heading"
      tabIndex={-1}
    >
      <h2 id="settings-heading">
        <Settings size={18} aria-hidden="true" /> Application settings
      </h2>
      <label className="setting-switch">
        <input
          type="checkbox"
          role="switch"
          checked={Boolean(settings?.clefEnabled)}
          disabled={pending || !settings?.aiAvailable}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby="ai-setting-description"
        />
        <span>Use Clef and live AI</span>
      </label>
      <p id="ai-setting-description">
        {settings?.aiAvailable
          ? "When on, Clef assesses artifacts and Llama drafts requirements and answers questions. Supplied context goes to your Cloudflare account and uses its AI allowance. When off, new requests use no AI."
          : "Live AI needs a configured Workers AI binding and AI Gateway. Follow the local setup instructions, then restart the app once to connect those services. This switch works without a restart after setup."}
      </p>
      {!settings?.aiAvailable && (
        <a
          href="https://github.com/GustavoHunt/intenttrace/blob/main/docs/INSTALLATION.md#with-real-workers-ai"
          target="_blank"
          rel="noreferrer"
        >
          Open local AI setup instructions
        </a>
      )}
      <p className="small muted" role="status">
        {pending
          ? "Saving setting…"
          : settings?.clefEnabled
            ? "Clef is on. New requests use live AI."
            : "Clef is off. Evidence, requirements and CSV checks remain available."}{" "}
        Changes affect new requests; an assessment already started keeps its
        original mode. Saved for this private session.
      </p>
    </section>
  );
}

export function AssessmentGuide({
  step,
  enabled,
  hasArtifacts,
  running,
  onSettings,
  onDismiss,
  onFindings,
}: {
  step: 1 | 2 | 3;
  enabled: boolean;
  hasArtifacts: boolean;
  running: boolean;
  onSettings: () => void;
  onDismiss: () => void;
  onFindings: () => void;
}) {
  const titles = [
    "Confirm requirements",
    "Assess with Clef",
    "Inspect findings",
  ];
  return (
    <section className="assessment-guide" aria-labelledby="guide-heading">
      <div className="guide-heading">
        <h3 id="guide-heading">Your next step</h3>
        <button className="secondary" onClick={onDismiss}>
          <X size={15} aria-hidden="true" /> Skip tour
        </button>
      </div>
      <ol className="guide-progress" aria-label="Assessment steps">
        {titles.map((title, i) => (
          <li key={title} aria-current={step === i + 1 ? "step" : undefined}>
            <span aria-hidden="true">
              {step > i + 1 ? <Check size={14} /> : i + 1}
            </span>
            {title}
          </li>
        ))}
      </ol>
      <p role="status" aria-live="polite">
        {step === 1
          ? "Review the requirements below, edit to one testable condition per line, then choose Confirm requirements. Clef uses only the version you approve."
          : step === 3
            ? "Your assessment is recorded below. Inspect each finding and its linked evidence. Model probabilities support your review; they are not proof of delivery."
            : running
              ? "The assessment is running. Findings will appear in Timeline when it finishes."
              : !hasArtifacts
                ? "Requirements are confirmed. Add the delivered artifact below before assessment; conversation claims alone cannot verify delivery."
                : !enabled
                  ? "Requirements are confirmed. Turn on Clef in Application settings, then choose Assess with Clef below."
                  : "Requirements are confirmed. Choose Assess with Clef below to compare your supplied artifacts with this approved version."}
      </p>
      {!running && (
        <button
          className="secondary"
          onClick={() => {
            if (step === 3) onFindings();
            else if (step === 1) focusTarget("requirements-editor");
            else if (!hasArtifacts) focusTarget("artifact-entry");
            else if (!enabled) onSettings();
            else focusTarget("assess-requirements");
          }}
        >
          <ArrowRight size={16} aria-hidden="true" />
          {step === 3
            ? "Show findings"
            : step === 1
              ? "Show requirements"
              : !hasArtifacts
                ? "Show artifact input"
                : !enabled
                  ? "Open AI settings"
                  : "Show assessment action"}
        </button>
      )}
    </section>
  );
}
