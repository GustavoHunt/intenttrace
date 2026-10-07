# IntentTrace

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React, TypeScript, Vite, Cloudflare Workers, Agents SDK, Durable Objects, Workflows, Workers AI, R2, AI Gateway, Turnstile.

## Users

Engineering leaders and developers investigating whether an AI-assisted deliverable fulfilled the user's request. The downloadable local app also serves hiring reviewers evaluating implementation quality.

## Product Purpose

Reconstruct a request, its confirmed scope, execution, observed output, and revised findings in an inspectable chronological case file.

## Positioning

Connect agreed scope to observed delivery with explicit evidence references and versioned conclusions. Later approvals cannot retroactively authorize earlier runs.

## Operating Context

Localhost app downloaded from GitHub, with isolated 24-hour case sessions. Start with a public ChatGPT or Claude shared link; fall back to exported/pasted history or original prompt plus artifact. A suggested synthetic CSV dashboard provides deterministic scope checks. Real model calls are visibly distinguished from offline fixtures and injected faults.

## Capabilities and Constraints

Live CLEF probabilities assess reviewed requirements against general supplied artifacts. Llama drafts requirements and explains results; missing evidence and weak decisions remain unresolved. ChatGPT/Claude JSON and labelled text imports, public HTTPS link intake, text/code/CSV/JSON/PDF/DOCX extraction, durable chat, report export, scope versions and private local storage. Public URL fetching is local-only and blocks private networks; no imported code or page script executes. Three CSV scenarios remain suggestions. No production integrations, employer data or hardcoded secrets.

## Brand Commitments

Name: IntentTrace. Timeline-first case file, with supporting chat and agreed-versus-delivered comparison. Mockups must precede UI implementation.

## Evidence on Hand

All demonstration records are authored synthetic material. No real customer data or performance claims.

## Product Principles

- Evidence precedes conclusions.
- Confirm intent before execution.
- Preserve history when new facts arrive.
- Treat missing evidence as unresolved.
- Make every finding inspectable.

## Accessibility & Inclusion

Responsive desktop/mobile web, keyboard access, visible focus, labelled statuses, reduced motion.
