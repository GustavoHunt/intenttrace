---
name: IntentTrace
description: A local case desk for comparing AI deliverables with reviewed requirements.
colors:
  primary: "#075cdd"
  primary-hover: "#034ebc"
  navy: "#10294b"
  ink: "#132743"
  muted: "#526782"
  canvas: "#f8fbff"
  surface: "#ffffff"
  line: "#dce6f3"
  selected: "#eaf2ff"
  supported-bg: "#e9f5f1"
  supported-ink: "#175b4f"
  warning-bg: "#fff2df"
  warning-ink: "#794409"
typography:
  title:
    fontFamily: 'Inter, "Segoe UI", sans-serif'
    fontSize: "23px"
    fontWeight: 700
    letterSpacing: "-0.025em"
  section:
    fontFamily: 'Inter, "Segoe UI", sans-serif'
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "-0.015em"
  body:
    fontFamily: 'Inter, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  compact:
    fontFamily: 'Inter, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: 'Inter, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 400
  intake-title:
    fontFamily: 'Inter, "Segoe UI", sans-serif'
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.25
  installer-title:
    fontFamily: 'Inter, "Segoe UI", sans-serif'
    fontSize: "clamp(30px, 3vw, 42px)"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.035em"
rounded:
  field: "5px"
  control: "6px"
  inset: "8px"
  badge: "20px"
spacing:
  compact: "8px"
  control-gap: "10px"
  small: "12px"
  medium: "18px"
  inset: "20px"
  large: "28px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "11px 15px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.control}"
    padding: "11px 15px"
  event:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "17px"
  status-supported:
    backgroundColor: "{colors.supported-bg}"
    textColor: "{colors.supported-ink}"
    rounded: "{rounded.control}"
    padding: "15px 17px"
  status-warning:
    backgroundColor: "{colors.warning-bg}"
    textColor: "{colors.warning-ink}"
    rounded: "{rounded.control}"
    padding: "15px 17px"
---

# Design System: IntentTrace

## Overview

**Creative North Star: "The Case Desk"**

The case desk now fills the viewport. Header, status, view navigation, Linked evidence and the bottom investigation composer sit outside the scroll area. Workspace owns case-content scrolling, including settings and optional CSV controls. Linked evidence uses a fixed side dock on desktop and a compact dock above the composer on narrow or short screens; a native artifact picker keeps every artifact reachable without another panel scrollbar. A native case picker similarly keeps navigation bounded. Investigation messages appear in the Conversation workspace, and interacting with the composer selects that view and follows its latest message. Supplied conversation snapshots remain available through an expandable transcript. Evidence selections reveal scope and finding context in Timeline, while the dock provides the corresponding downloads.

The user selected option A: a navy navigation shell, a pale working surface, a chronological case file, and a supporting evidence inspector. The interface uses familiar controls and compact, readable text to make an investigation inspectable. The primary downloadable local app now opens with conversation intake: a public shared link, followed by artifacts and reviewed requirements. Evidence, versioned scope, and explicit status labels carry the visual hierarchy. The synthetic CSV case remains a secondary way to explore the same desk.

This document records the current implementation in `src/client/main.tsx`, `src/client/intake.tsx`, `src/client/files.ts`, `src/client/style.css`, and `installer/public/`. It is a source-based design record, not a claim that visual acceptance, deployment validation, or the original mockup fidelity gates have passed. Desktop and mobile intake captures were inspected for this update; they show only the initial intake state. The optional Cloudflare installer shares the direction while using a more spacious single-task layout.

**Key Characteristics:**

- Navy navigation and pale work surfaces.
- Cobalt actions, selected evidence, and visible focus.
- Teal supported states and amber states requiring attention, each with text.
- A chronological spine connecting events to an evidence inspector.
- Conversation intake first, with explicit review before assessment.
- Flat surfaces, restrained borders, and system sans typography.

## Colors

The palette separates stable navigation from a quiet working area, with saturated color reserved for interaction and meaning.

### Primary

Cobalt (`primary`) identifies actionable controls and evidence references. Its darker hover value reinforces the same action. Pale cobalt (`selected`) highlights events without obscuring their content. Navy anchors navigation and the brand.

### Secondary

Supported states use the teal background and ink pair. States requiring attention use the amber background and ink pair. These are semantic combinations, not additional brand accents.

### Neutral

Ink carries primary content; muted text carries timestamps and supporting explanations. The pale canvas and white surfaces distinguish the desk from individual evidence rows. The line color separates sections and artifacts.

**The Labelled Status Rule.** Pair semantic color with a written status; color alone cannot communicate the investigation result.

The installer currently has slightly different navy, cobalt, ink, muted, and border literals. These remain implementation drift, not additional palette rules. The frontmatter records the case desk palette for future reuse.

## Typography

The approved direction uses system sans typography. The source declares `Inter, "Segoe UI", sans-serif`, but does not bundle or load Inter; Windows normally renders Segoe UI unless Inter is locally available. Future work must not assume a downloaded font is present.

The case title uses the title role, reducing to 20px below the mobile breakpoint. Section headings use the section role; subordinate headings use 15px bold text. Case explanations commonly use the body role, while timeline details, chat, navigation, and artifacts use compact text. Timestamps use tabular numerals. The browser's default body size remains 16px where no component size overrides it.

The intake title uses its own compact introduction role, reducing to 21px at the intake breakpoint. Supporting prose keeps the default paragraph rhythm. Requirements use a multiline editor with a 1.65 line height; probabilities use 12px labels beside numerical percentages.

The installer title is larger because it introduces a single setup task. Its lead is 18px with a 1.65 line height and a 70ch maximum measure, reducing to 16px on small screens. Its title becomes 32px on small screens. This display scale belongs to setup and empty states, not dense investigation rows.

## Layout

Before a case is open, a single white intake panel sits within the established shell. It is capped at 880px, with a 28px outer margin and 32px padding. The desktop shared-link field and read action form one row. A secondary control reveals export, pasted conversation, original prompt, and artifact details. The suggested CSV example sits below a divider. At 800px and below, panel padding becomes 20px, outer vertical margin becomes 16px, and the link field and full-width action stack. This intake breakpoint is distinct from the case desk breakpoint.

The desktop case desk has a 220px navigation column and a flexible main area. At 1150px and below, navigation becomes 190px. The current workspace splits the main area into flexible case content and an inspector of `minmax(320px, 30%)`; the later declaration takes precedence over the earlier fixed-width declarations. Case content is capped at 1000px and centered within its column. These values describe the current build and do not establish verified responsive acceptance.

Once a case is open, its status strip and case-view controls precede the workspace. General cases offer Timeline and Conversation; CSV examples retain the scenario toolbar, Agreed vs delivered, and Demo dashboard. Timeline rows use a timestamp column and event button. A thin spine and small circular nodes make chronology visible. The selected event controls the adjacent evidence summary and artifact list. The CSV comparison and dashboard views use horizontally scrollable tables. The dashboard puts its task filter, visible-row count, source label, and export link above the task table.

At 850px and below, navigation moves above the desk, the inspector follows case content, the case list scrolls horizontally, and secondary sidebar material and the brand tagline are hidden. Header, toolbar, and scope-panel spacing compresses; toolbar controls wrap and the status strip stacks vertically. Case-view buttons remain on one horizontally scrollable row with 12px labels. The timeline's timestamp column and spine also narrow. The compact top section brings chronology into the initial phone viewport; exact viewport fit remains a rendered validation concern rather than a universal height guarantee.

The installer uses a 230px sidebar and a main section capped at 920px with generous insets. At 700px and below it becomes a single column; supporting sidebar text disappears, and action controls have a 44px minimum height. Preserve the numbered progress sequence across widths.

## Elevation & Depth

The implementation is flat: it uses no box shadows or gradients. White evidence rows, pale inset panels, border separators, and selected-state tints provide depth. A visible focus outline provides interaction feedback without lifting the surrounding surface. There is no animation vocabulary; evidence links use smooth scrolling, with reduced-motion CSS returning scrolling to automatic behavior.

**The Flat Surface Rule.** Use borders and tonal separation for the established desk and installer surfaces; preserve their existing flat treatment.

## Shapes

Controls and event rows use the control radius. Intake text fields use the field radius. Scope, intake, and chat insets use the slightly softer inset radius. Mode badges use the pill radius. Timeline nodes are circular. Tables and artifact lists remain open rows with separators rather than becoming independent cards. Lucide SVG icons support recognizable actions and retain adjacent text or an accessible name.

## Components

### Guided assessment and application settings

General case arrivals open Timeline. An inline, optional guide sits above the requirement editor and follows the actual approval and assessment state. Its three numbered steps communicate order; the active step uses cobalt and a written label. Actions scroll to and focus the real editor, artifact input, Settings region or findings. Skip is always visible, dismissal is remembered in this browser, and the case-view row offers replay. Highlight the current action with a cobalt outline; keep the rest of the case usable.

Application settings expand within the main work surface from the header. A labelled native switch controls Clef and live AI, accompanied by capability, saving, cost/context and offline feedback. Preserve the header mode badge and each finding's original mode independently. Incomplete evidence uses the amber status treatment. On phones, guide steps stack, header actions wrap, and the setting remains in normal document flow; neither surface uses a modal overlay.

### Buttons

Primary actions use cobalt, white text, medium weight, and the control radius. Secondary actions use white or transparent surfaces, cobalt text, and a pale border. The case desk uses 14px semibold labels; installer actions use 15px semibold labels and larger insets. Disabled controls reduce opacity and change the cursor. Global focus outlines are three pixels wide with an offset; they apply to keyboard interaction across buttons and links.

### Inputs and fields

Selects and the chat textarea use white backgrounds, blue-gray strokes, and the control radius. The chat field can grow vertically within bounded heights. It has a programmatic label and retains the submitted question when a response fails. Error feedback includes a retry action. Preserve visible labels and inline explanations when extending the form.

### Conversation and artifact intake

The primary labelled URL field asks for a public ChatGPT or Claude shared conversation. The adjacent action has an explicit reading state. Supporting copy explains that attachments may need to be added separately. A secondary disclosure exposes chat JSON import, a conversation selector when needed, labelled pasted messages, editable case title, and original prompt. The artifact area offers file upload, a public URL, and an expandable pasted-text field. File controls retain native inputs and a visible focus-within outline. Added artifacts appear as simple named rows with extracted-text counts and Remove controls.

Busy and failure states stay adjacent to the affected controls. The create action waits for artifact reading to finish. Format limits, text-extraction boundaries, and live-model data use appear as plain supporting copy. The initial intake uses a secondary CSV example action; it must not visually displace the user's own conversation.

### Requirement review

General cases place an editable requirements panel above chronology. It asks for one testable requirement per line, shows count and validation feedback, and separates Confirm requirements from Assess with CLEF. An edit to a confirmed version requires another confirmation before assessment. The editor has a 180px minimum height. Additional artifacts can be attached inside this panel. Preserve the distinction between a present review and historical approval in the supplied conversation.

### Supplied conversation

The conversation view lists role-labelled messages as open rows divided by fine rules. Text preserves line breaks and wraps long content. A source link, provider, received-message count, and import warnings provide provenance. The introductory label explicitly says that conversation claims are not verified execution.

### Navigation and mode badge

Case navigation is embedded in navy; the current case has a brighter blue fill. Case views are ordinary buttons with an exposed pressed state. The pale mode badge distinguishes live AI, offline fixtures, and connection state in words. It is informational, not an action.

### Timeline and evidence inspector

An event is a full-width, left-aligned button with a title, detail, provenance label, and artifact count. Hover and selected states use a pale blue fill and stronger border; selection is also exposed through `aria-pressed`. Evidence links in findings and chat select the associated event. Single or grouped known references in chat become readable event-title controls; unresolved references remain text. The inspector names the event, its scope and linked criteria, then lists downloadable artifacts. A reset control restores all evidence.

### Project task dashboard

The dashboard uses a labelled open/all task selector, a visible-versus-total count, and a simple Task / Title / Status table with horizontal separators. It loads and validates the recorded source snapshot when one exists; a fresh synthetic case uses its authored demonstration source. Changing the preview filter does not change approved scope. A download link points to the actual recorded CSV export when available, and an explicit empty state explains when no export exists. Loading failures appear as alerts rather than invented task data.

### Findings and status strip

The top strip provides the current execution or investigation state. Findings use text labels, criterion headings, explanations, and evidence links. Findings from an earlier state are explicitly identified as previous findings. Maintain those distinctions when adding loading, failed, superseded, or incomplete states; presentation must follow actual case state.

When a general assessment returns CLEF decision data, each requirement shows the model name and live probabilities. Every probability row combines a written outcome, a native meter on a zero-to-one scale, and a percentage to one decimal place. The desktop grid uses a 140px label, flexible meter, and 55px value; below 800px it narrows to 120px, flexible meter, and 50px value. Native meter appearance can vary by browser. These are model probabilities attached to evidence-based findings, not a decorative certainty score.

### Installer progress

The installer presents a numbered list separated by fine rules. Completed steps use teal text; the active step uses bold cobalt; each row also carries a written state. Inline status messages announce changes politely. Retry, update, receipt, launch, and disconnect controls appear according to progress. Keep error text actionable and keep permissions and account choices understandable before installation begins.

## Do's and Don'ts

### Do:

- **Do** preserve the navy shell, pale work surface, and cobalt interaction hierarchy.
- **Do** pair color with explicit state and provenance labels.
- **Do** retain the evidence-to-event connection and the ability to reset a selection.
- **Do** distinguish current findings from previous findings and live inference from offline fixtures.
- **Do** keep the user's conversation primary and require explicit review before assessing drafted requirements.
- **Do** use visible keyboard focus, labelled controls, wrapping layouts, and reduced-motion behavior.
- **Do** verify the rendered desktop and mobile layouts after changes; this record is not acceptance evidence.

### Don't:

- **Don't** replace the approved system sans direction with an unapproved display-font identity.
- **Don't** add decorative gradients, illustrations, oversized marketing headings, or invented KPIs to the case desk.
- **Don't** present imported claims or unverified artifacts as established observations.
- **Don't** turn the installer's small palette differences into new reusable color roles.
- **Don't** infer passed design or deployment gates from the existence of this document.

### Conversation progress and recovery

Conversation preparation uses a compact status panel in the existing message column: a stage title, elapsed time, four labelled preparation steps and a Stop response action. Stages advance only on server events; the initial connection state is distinct from inference. The four stages are reading case evidence, checking the AI allowance, preparing the answer and checking evidence links. A single current-step dot uses restrained motion, disabled under reduced-motion preferences. The composer remains available for editing and shows a short preparation status.

Failures appear as persisted assistant messages using the existing amber warning palette, with a specific heading, explanation and a relevant action. Allowance failures include the recorded next reset in local time and Review timeline, without implying immediate retry can restore credits. Recoverable failures offer Retry answer. Connection interruptions are explained locally even if no server message arrives. Phone layouts stack the steps and retain readable body text and 44px controls. Actual desktop and 390px phone-emulation views of progress and quota feedback were inspected.
