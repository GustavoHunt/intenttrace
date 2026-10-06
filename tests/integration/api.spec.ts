import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
const origin = "http://127.0.0.1:5173";
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
  const socket = new WebSocket(`ws://127.0.0.1:5173${path}`, {
    headers: { Origin: origin, Cookie: cookies },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chat timeout")), 10000);
      socket.on("message", (raw) => {
        const data = JSON.parse(raw.toString());
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
  const imported = await request.post("/api/import", {
    headers: { Origin: origin },
    data: bundle,
  });
  expect(imported.status()).toBe(201);
  const c = await imported.json();
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
