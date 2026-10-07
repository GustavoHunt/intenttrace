import { describe, it, expect } from "vitest";
import {
  BundleSchema,
  csv,
  execute,
  newCase,
  validateBundle,
  verify,
  hash,
} from "../src/shared/domain";
import {
  signSession,
  verifySession,
  readJson,
  sameOrigin,
} from "../src/server/security";
import { grounded, parseModelResponse, Answer } from "../src/server/ai";
it("validates both text and structured Workers AI responses", () => {
  const answer = { text: "Synthetic result", evidenceIds: [] };
  expect(parseModelResponse(answer, Answer)).toEqual(answer);
  expect(parseModelResponse(JSON.stringify(answer), Answer)).toEqual(answer);
  expect(() => parseModelResponse({ text: 42 }, Answer)).toThrow();
  expect(() => parseModelResponse(undefined, Answer)).toThrow();
});
async function scenario(
  kind: "correct" | "divergence" | "missing" = "correct",
) {
  const c = newCase(kind);
  c.scopes[0].confirmedAt = new Date(Date.now() - 1000).toISOString();
  const r = await execute(
    c,
    c.scopes[0].id,
    { selection: "filtered", includeNotes: false },
    "offline",
    crypto.randomUUID(),
  );
  return { c, r };
}
describe("evidence verification", () => {
  it("verifies actual export membership, columns and state", async () => {
    const { c, r } = await scenario();
    expect(verify(c, r.id).map((f) => f.status)).toEqual([
      "supported",
      "supported",
      "supported",
    ]);
  });
  it("detects broad selection despite successful execution", async () => {
    const { c, r } = await scenario("divergence");
    expect(verify(c, r.id)[0].status).toBe("contradicted");
    expect(
      JSON.parse(c.artifacts.find((a) => a.id === r.artifactId)!.content),
    ).toHaveLength(24);
  });
  it("does not infer success when evidence is absent", async () => {
    const { c, r } = await scenario("missing");
    expect(
      verify(c, r.id).every((f) => f.status === "insufficient_evidence"),
    ).toBe(true);
  });
  it("does not retroactively authorize an earlier run", async () => {
    const { c, r } = await scenario("divergence");
    c.scopes.push({
      ...c.scopes[0],
      id: crypto.randomUUID(),
      version: 2,
      selection: "project",
      confirmedAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(verify(c, r.id)[0].status).toBe("contradicted");
  });
  it("requires approval before execution", async () => {
    const { c, r } = await scenario();
    c.scopes[0].confirmedAt = new Date(Date.now() + 60000).toISOString();
    expect(verify(c, r.id)[0].status).toBe("insufficient_evidence");
  });
  it("verifies subsequent run against its new explicit scope", async () => {
    const { c } = await scenario("divergence");
    const s = {
      ...c.scopes[0],
      id: crypto.randomUUID(),
      version: 2,
      selection: "project" as const,
    };
    c.scopes.push(s);
    const r = await execute(
      c,
      s.id,
      { selection: "project", includeNotes: false },
      "offline",
      crypto.randomUUID(),
    );
    expect(verify(c, r.id).every((f) => f.status === "supported")).toBe(true);
  });
  it("detects duplicate exported IDs even if row count matches", async () => {
    const { c, r } = await scenario();
    const a = c.artifacts.find((a) => a.id === r.artifactId)!;
    const rows = JSON.parse(a.content);
    rows[1] = rows[0];
    a.content = JSON.stringify(rows);
    expect(verify(c, r.id)[0].status).toBe("contradicted");
  });
  it("detects changed row values", async () => {
    const { c, r } = await scenario();
    const a = c.artifacts.find((a) => a.id === r.artifactId)!;
    const rows = JSON.parse(a.content);
    rows[0].title = "Unexpected change";
    a.content = JSON.stringify(rows);
    expect(verify(c, r.id)[0].status).toBe("contradicted");
  });
  it("detects internal note exposure", async () => {
    const c = newCase("correct");
    c.scopes[0].confirmedAt = new Date(Date.now() - 1000).toISOString();
    const r = await execute(
      c,
      c.scopes[0].id,
      { selection: "filtered", includeNotes: true },
      "offline",
      crypto.randomUUID(),
    );
    expect(verify(c, r.id)[1].status).toBe("contradicted");
  });
  it("detects task mutations", async () => {
    const { c, r } = await scenario();
    const a = c.artifacts.find((a) => a.kind === "snapshot")!;
    const snapshot = JSON.parse(a.content);
    snapshot.after[0].status = "closed";
    a.content = JSON.stringify(snapshot);
    expect(verify(c, r.id)[2].status).toBe("contradicted");
  });
  it("handles malformed artifact data as insufficient evidence", async () => {
    const { c, r } = await scenario();
    c.artifacts.find((a) => a.id === r.artifactId)!.content = "{}";
    expect(verify(c, r.id)[0].status).toBe("insufficient_evidence");
  });
  it("rejects dangling scope links and duplicate records", async () => {
    const { c } = await scenario();
    c.runs[0].scopeId = "unknown";
    expect(() => validateBundle(c)).toThrow("unknown scope");
    c.runs = [];
    c.scopes.push(c.scopes[0]);
    expect(() => validateBundle(c)).toThrow("Duplicate");
  });
  it("rejects unsupported bundle versions and unknown fields", () => {
    expect(BundleSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
    expect(BundleSchema.safeParse({ ...newCase("correct") }).success).toBe(
      false,
    );
  });
  it("hashes exact bytes", async () => {
    expect(await hash("A")).not.toBe(await hash("a"));
  });
  it("escapes spreadsheet formulas and CSV quotes", () => {
    expect(csv(JSON.stringify([{ title: '=HYPERLINK("x")' }]))).toContain("'");
    expect(csv(JSON.stringify([{ title: 'a,"b"' }]))).toContain('"a,""b"""');
  });
  it("rejects invented evidence citations", () => {
    expect(() =>
      grounded({ text: "A claim", evidenceIds: ["invented"] }, ["known"]),
    ).toThrow("unknown evidence");
  });
});
describe("session security", () => {
  it("accepts a valid unexpired signature", async () => {
    const id = crypto.randomUUID(),
      key = crypto.randomUUID();
    const token = await signSession(id, Date.now() + 10000, key);
    expect((await verifySession(token, key))?.id).toBe(id);
  });
  it("rejects tampering and other signing keys", async () => {
    const key = crypto.randomUUID(),
      token = await signSession(crypto.randomUUID(), Date.now() + 10000, key);
    expect(await verifySession(token + "a", key)).toBeNull();
    expect(await verifySession(token, crypto.randomUUID())).toBeNull();
  });
  it("rejects expired sessions", async () => {
    const key = crypto.randomUUID();
    expect(
      await verifySession(
        await signSession(crypto.randomUUID(), Date.now() - 1, key),
        key,
      ),
    ).toBeNull();
  });
  it("rejects cross-origin and absent-origin mutations", () => {
    expect(() =>
      sameOrigin(
        new Request("https://intenttrace.test/api", {
          headers: { Origin: "https://other.test" },
        }),
      ),
    ).toThrow();
    expect(() =>
      sameOrigin(new Request("https://intenttrace.test/api")),
    ).toThrow();
  });
  it("bounds streamed JSON independently of Content-Length", async () => {
    await expect(
      readJson(
        new Request("https://test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"value":"123456789"}',
        }),
        10,
      ),
    ).rejects.toThrow("limit");
  });
});
