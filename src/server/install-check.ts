import { getAgentByName } from "agents";
import { launch } from "@cloudflare/playwright";
import { newCase } from "../shared/domain";
import { HttpError, json } from "./security";
import type { Env } from "./index";

/** Owner-authenticated, fixed synthetic probe. Never accepts a URL or arbitrary code. */
export async function installationCheck(req: Request, env: Env) {
  if (
    !env.INSTALL_RELEASE ||
    !env.SESSION_SIGNING_SECRET ||
    req.headers.get("Authorization") !== `Bearer ${env.SESSION_SIGNING_SECRET}`
  )
    throw new HttpError(404, "Not found");
  const key = ".installation/check.json";
  const existing = await env.EVIDENCE.get(key);
  const state = existing
    ? await existing.json<{
        caseId: string;
        startedAt: number;
        initialized?: boolean;
        browser?: boolean;
        attempts?: number;
        release?: string;
        complete?: Record<string, string>;
      }>()
    : { caseId: crypto.randomUUID(), startedAt: Date.now() };
  if (state.release !== env.INSTALL_RELEASE) {
    state.release = env.INSTALL_RELEASE;
    delete state.complete;
  }
  if (state.complete)
    return json({ release: env.INSTALL_RELEASE, checks: state.complete });
  const session = `installation-${state.caseId}`;
  const agent = await getAgentByName(env.CaseAgent, session);
  if (!state.initialized) {
    await env.EVIDENCE.put(key, JSON.stringify(state));
    try {
      await agent.init(newCase("correct"), session);
    } catch {
      await agent.details();
    } // A lost reply may have already initialized this case.
    const c = await agent.details();
    if (!c.scopes.at(-1)?.confirmedAt) await agent.confirm("filtered");
    const current = await agent.details();
    if (
      current.status === "failed" ||
      (current.status === "complete" &&
        current.findings.at(-1)?.explanationMode !== "live")
    ) {
      state.attempts = (state.attempts || 0) + 1;
      if (state.attempts > 3)
        throw new HttpError(
          503,
          "Live model checks failed after three recovery attempts",
        );
      await env.EVIDENCE.put(key, JSON.stringify(state));
      await agent.run(crypto.randomUUID());
    } else await agent.run(state.caseId); // Stable initial identity prevents duplicate model calls on retry.
    state.initialized = true;
    await env.EVIDENCE.put(key, JSON.stringify(state));
  }
  if (!state.browser) {
    if (!env.BROWSER) throw new HttpError(503, "Browser binding missing");
    const browser = await launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setContent(
        "<html><body><h1>IntentTrace installation check</h1></body></html>",
      );
      if (
        (await page.locator("h1").textContent()) !==
        "IntentTrace installation check"
      )
        throw new HttpError(503, "Browser check failed");
      state.browser = true;
      await env.EVIDENCE.put(key, JSON.stringify(state));
    } finally {
      await browser.close();
    }
  }
  const c = await agent.details();
  if (
    c.status === "failed" ||
    (c.status === "complete" && c.findings.at(-1)?.explanationMode !== "live")
  ) {
    state.initialized = false;
    await env.EVIDENCE.put(key, JSON.stringify(state));
    throw new HttpError(
      503,
      "Live model verification has not passed. Retry the check.",
    );
  }
  if (c.status !== "complete")
    return json(
      { release: env.INSTALL_RELEASE, checks: { workflow: "pending" } },
      202,
    );
  state.complete = {
    storage: "passed",
    memory: "passed",
    workflow: "passed",
    workersAI: "passed",
    aiGateway: "passed",
    browser: "passed",
  };
  await env.EVIDENCE.put(key, JSON.stringify(state));
  return json({ release: env.INSTALL_RELEASE, checks: state.complete });
}
