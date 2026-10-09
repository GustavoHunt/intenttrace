import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
const origin = "http://127.0.0.1:63022";
test("AI settings are authenticated, persistent, isolated and capability-checked", async ({
  request,
  playwright,
}) => {
  expect((await request.get("/api/settings")).status()).toBe(401);
  await begin(request);
  const settings = await (await request.get("/api/settings")).json();
  expect(settings).toEqual({
    clefEnabled: false,
    aiAvailable: false,
    mode: "offline",
  });
  const update = await request.post("/api/settings", {
    headers: { Origin: origin },
    data: { clefEnabled: false },
  });
  expect(update.status()).toBe(200);
  expect(await update.json()).toEqual(settings);
  expect(await (await request.get("/api/settings")).json()).toEqual(settings);
  expect(
    (
      await request.post("/api/settings", {
        headers: { Origin: origin },
        data: { clefEnabled: true },
      })
    ).status(),
  ).toBe(503);
  expect(
    (
      await request.post("/api/settings", {
        headers: { Origin: "https://attacker.invalid" },
        data: { clefEnabled: false },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/settings", {
        headers: { Origin: origin },
        data: { clefEnabled: true, modelMode: "live" },
      })
    ).status(),
  ).toBe(400);
  const stranger = await playwright.request.newContext({ baseURL: origin });
  try {
    expect(
      (
        await stranger.post("/api/settings", {
          headers: { Origin: origin },
          data: { clefEnabled: false },
        })
      ).status(),
    ).toBe(401);
    await begin(stranger);
    expect(await (await stranger.get("/api/settings")).json()).toEqual(
      settings,
    );
  } finally {
    await stranger.dispose();
  }
});
test("Agent chat streams, persists, and rejects oversized history", async ({
  request,
}) => {
  await begin(request);
  const c = await create(request);
  const session = await (await request.get("/api/cases")).json();
  const cookies = (await request.storageState()).cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const path = `/agents/case-agent/${session.sessionId}_${c.id}`;
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, {
    headers: { Origin: origin, Cookie: cookies },
  });
  const chunks: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chat timeout")), 10000);
      socket.on("message", (raw) => {
        const data = JSON.parse(raw.toString());
        if (data.type === "cf_agent_use_chat_response" && typeof data.body === "string") chunks.push(data.body);
        if (data.type === "cf_agent_use_chat_response" && data.done) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    socket.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: crypto.randomUUID(),
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: "What evidence is available?" }],
              },
            ],
          }),
        },
      }),
    );
    await done;
    expect(chunks.join("")).toContain('"stage":"reading"');
    expect(chunks.join("")).toContain('"outcome":"complete"');
    await expect
      .poll(async () =>
        JSON.stringify(
          await (await request.get(path + "/get-messages")).json(),
        ),
      )
      .toContain("Offline demonstration response");
    const closed = new Promise<number>((resolve) =>
      socket.once("close", resolve),
    );
    socket.send("x".repeat(100001));
    expect(await closed).toBe(1009);
  } finally {
    socket.close();
  }
});
async function begin(request: APIRequestContext) {
  const response = await request.post("/api/session", {
    headers: { Origin: origin },
    data: {},
  });
  expect(response.status(), await response.text()).toBe(200);
}
async function create(request: APIRequestContext, scenario = "correct") {
  const response = await request.post("/api/cases", {
    headers: { Origin: origin },
    data: { scenario },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function action(
  request: APIRequestContext,
  id: string,
  action: string,
  data: unknown,
) {
  const r = await request.post(`/api/cases/${id}/${action}`, {
    headers: { Origin: origin },
    data,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function complete(request: APIRequestContext, id: string) {
  await expect
    .poll(
      async () => (await (await request.get(`/api/cases/${id}`)).json()).status,
    )
    .toBe("complete");
  return (await request.get(`/api/cases/${id}`)).json();
}
for (const [scenario, status] of [
  ["correct", "supported"],
  ["divergence", "contradicted"],
  ["missing", "insufficient_evidence"],
])
  test(`${scenario}: real workflow, replay and artifact integrity`, async ({
    request,
  }) => {
    await begin(request);
    const c = await create(request, scenario);
    await action(request, c.id, "scope", { selection: "filtered" });
    const operationId = crypto.randomUUID();
    await action(request, c.id, "run", { operationId });
    const result = await complete(request, c.id);
    expect(result.findings[0].findings[0].status).toBe(status);
    expect(result.findings[0].explanationMode).toBe("offline");
    const replay = await action(request, c.id, "run", { operationId });
    expect(replay.runs).toHaveLength(1);
    const report = await (
      await request.get(`/api/cases/${c.id}/report`)
    ).json();
    expect(report.operations).toBeUndefined();
    for (const a of report.artifacts) {
      const r = await request.get(`/api/cases/${c.id}/artifacts/${a.id}`);
      expect(await r.text()).toBe(a.content);
    }
    if (scenario === "divergence") {
      await action(request, c.id, "scope", { selection: "project" });
      await action(request, c.id, "run", { operationId: crypto.randomUUID() });
      const updated = await complete(request, c.id);
      expect(updated.findings[0].findings[0].status).toBe("contradicted");
      expect(updated.findings[1].findings[0].status).toBe("supported");
    }
    expect(
      (
        await request.delete(`/api/cases/${c.id}`, {
          headers: { Origin: origin },
        })
      ).ok(),
    ).toBeTruthy();
    expect((await request.get(`/api/cases/${c.id}`)).status()).toBe(404);
  });
test("sessions enforce ownership and same-origin mutation", async ({
  request,
  playwright,
}) => {
  expect((await request.get("/api/cases")).status()).toBe(401);
  await begin(request);
  const c = await create(request);
  expect(
    (
      await request.post(`/api/cases/${c.id}/scope`, {
        headers: { Origin: "https://attacker.invalid" },
        data: { selection: "project" },
      })
    ).status(),
  ).toBe(403);
  const other = await playwright.request.newContext({ baseURL: origin });
  await begin(other);
  expect((await other.get(`/api/cases/${c.id}`)).status()).toBe(404);
  expect(
    (
      await other.get(`/agents/case-agent/unknown_${c.id}/get-messages`)
    ).status(),
  ).toBe(404);
  await other.dispose();
});
test("JSON import marks supplied evidence and rejects corrupt hashes and references", async ({
  request,
}) => {
  await begin(request);
  const bundle = JSON.parse(await readFile("examples/correct.json", "utf8"));
  bundle.artifacts[0].observation = "rendered_dom";
  bundle.artifacts[0].contentStored = true;
  const imported = await request.post("/api/import", {
    headers: { Origin: origin },
    data: bundle,
  });
  expect(imported.status()).toBe(201);
  const c = await imported.json();
  expect(c.artifacts[0].observation).toBeUndefined();
  expect(c.artifacts[0].contentStored).toBeUndefined();
  expect(
    c.events.every((e: { provenance: string }) => e.provenance === "supplied"),
  ).toBe(true);
  await action(request, c.id, "investigate", {});
  expect((await complete(request, c.id)).findings[0].findings[0].status).toBe(
    "supported",
  );
  bundle.artifacts[0].content += " ";
  expect(
    (
      await request.post("/api/import", {
        headers: { Origin: origin },
        data: bundle,
      })
    ).status(),
  ).toBe(400);
  bundle.runs[0].scopeId = "missing";
  expect(
    (
      await request.post("/api/import", {
        headers: { Origin: origin },
        data: bundle,
      })
    ).status(),
  ).toBe(400);
});
test("general intake requires approval, preserves original artifacts and versions assessments", async ({
  request,
}) => {
  await begin(request);
  const response = await request.post("/api/intake", {
    headers: { Origin: origin },
    data: {
      title: "Synthetic report",
      provider: "manual",
      messages: [{ id: "a", role: "user", text: "Deliver a summary" }],
      originalPrompt: "Deliver a summary",
      documents: [
        { name: "summary.md", content: "# Summary\nThree rows delivered" },
      ],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const c = await response.json();
  expect(c.intake.messages).toHaveLength(1);
  expect(c.scopes[0].confirmedAt).toBeNull();
  expect(
    (
      await request.post(`/api/cases/${c.id}/investigate`, {
        headers: { Origin: origin },
        data: {},
      })
    ).status(),
  ).toBe(409);
  await action(request, c.id, "requirements", {
    requirements: [{ id: "req_1", text: "Deliver a summary" }],
  });
  await action(request, c.id, "investigate", {});
  const result = await complete(request, c.id);
  expect(result.findings[0].method).toBe("offline");
  expect(result.findings[0].decision.mode).toBe("offline");
  expect(result.findings[0].findings[0].status).toBe("insufficient_evidence");
  const unchangedPlan = await action(request, c.id, "evidence-plan", {});
  expect(unchangedPlan.status).toBe("complete");
  expect(unchangedPlan.revision).toBe(result.revision);
  expect(unchangedPlan.events).toEqual(result.events);
  expect(unchangedPlan.findings).toEqual(result.findings);
  const changedPlan = await action(request, c.id, "evidence-plan", { coverage: "expanded" });
  expect(changedPlan.status).toBe("ready");
  expect(changedPlan.findings[0].superseded).toBe(true);
  const repeatedPlan = await action(request, c.id, "evidence-plan", { coverage: "expanded" });
  expect(repeatedPlan.revision).toBe(changedPlan.revision);
  expect(repeatedPlan.events).toEqual(changedPlan.events);
  const doc = c.artifacts.find((a: any) => a.name === "summary.md");
  expect(
    await (await request.get(`/api/cases/${c.id}/artifacts/${doc.id}`)).text(),
  ).toBe("# Summary\nThree rows delivered");
  const changed = await action(request, c.id, "documents", {
    documents: [{ name: "additional.txt", content: "Additional evidence" }],
  });
  expect(changed.findings[0].superseded).toBe(true);
  const version = await action(request, c.id, "requirements", {
    requirements: [{ id: "req_1", text: "Deliver a detailed summary" }],
  });
  expect(version.scopes.at(-1).version).toBe(3);
  expect(
    (
      await request.post(`/api/cases/${c.id}/run`, {
        headers: { Origin: origin },
        data: { operationId: crypto.randomUUID() },
      })
    ).status(),
  ).toBe(409);
});
test("local source fetch rejects cross-origin and private destinations", async ({
  request,
}) => {
  expect(
    (
      await request.post("/local/source", {
        headers: { Origin: "https://attacker.invalid" },
        data: { url: "https://127.0.0.1/secret", kind: "artifact" },
      })
    ).status(),
  ).toBe(400);
  const blocked = await request.post("/local/source", {
    headers: { Origin: origin },
    data: { url: "https://127.0.0.1/secret", kind: "artifact" },
  });
  expect(blocked.status()).toBe(400);
  expect(await blocked.text()).toContain("Private and local");
});

test("private connections are redacted, isolated and removable; plans are validated", async ({ request, playwright }) => {
  expect((await request.get("/api/connections")).status()).toBe(401);
  await begin(request);
  const credential = { provider: "github", label: "Synthetic CI", repository: "synthetic/example", runId: "123", secret: "synthetic-test-credential" };
  const saved = await request.post("/api/connections", { headers: { Origin: origin }, data: credential });
  expect(saved.status(), await saved.text()).toBe(201);
  const connection = await saved.json();
  expect(JSON.stringify(connection)).not.toContain(credential.secret);
  const listed = await (await request.get("/api/connections")).json();
  expect(listed).toHaveLength(1); expect(JSON.stringify(listed)).not.toContain(credential.secret);
  expect((await request.post("/api/connections", { headers: { Origin: "https://attacker.invalid" }, data: credential })).status()).toBe(403);
  const stranger = await playwright.request.newContext({ baseURL: origin });
  try { await begin(stranger); expect(await (await stranger.get("/api/connections")).json()).toEqual([]); } finally { await stranger.dispose(); }
  const created = await request.post("/api/intake", { headers: { Origin: origin }, data: { title: "Synthetic CI evidence", provider: "manual", messages: [{ id: "a", role: "user", text: "Verify the selected CI run" }], originalPrompt: "Verify the selected CI run", documents: [] } });
  const c = await created.json();
  await action(request, c.id, "requirements", { requirements: [{ id: "req_1", text: "Verify CI for this commit" }] });
  const plan = { coverage: "expanded", connectionIds: [connection.id], expectedCommit: "a".repeat(40), checks: [{ id: "check_1", requirementId: "req_1", kind: "ci", expected: "" }] };
  const updated = await action(request, c.id, "evidence-plan", plan);
  expect(updated.evidencePlan.coverage).toBe("expanded");
  expect((await request.post(`/api/cases/${c.id}/evidence-plan`, { headers: { Origin: origin }, data: { ...plan, targetUrls: ["https://127.0.0.1/"] } })).status()).toBe(400);
  expect((await request.post(`/api/cases/${c.id}/evidence-plan`, { headers: { Origin: origin }, data: { ...plan, checks: [{ ...plan.checks[0], requirementId: "req_9" }] } })).status()).toBe(400);
  expect((await request.post("/api/evaluations/visible-delivery", { headers: { Origin: origin }, data: {} })).status()).toBe(409);
  const revised = await action(request, c.id, "requirements", { requirements: [{ id: "req_1", text: "A materially different requirement" }] });
  expect(revised.evidencePlan.checks).toEqual([]);
  const report = await (await request.get(`/api/cases/${c.id}/report`)).text(); expect(report).not.toContain(credential.secret);
  expect((await request.delete(`/api/connections/${connection.id}`, { headers: { Origin: origin } })).status()).toBe(200);
  expect(await (await request.get("/api/connections")).json()).toEqual([]);
  expect((await request.post(`/api/cases/${c.id}/evidence-plan`, { headers: { Origin: origin }, data: plan })).status()).toBe(400);
});
