import { describe, expect, it, vi } from "vitest";
const { sdkAlarm } = vi.hoisted(() => ({ sdkAlarm: vi.fn(async () => {}) }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {
    env: any;
    constructor(_ctx: any, env: any) {
      this.env = env;
    }
  },
}));
vi.mock("@cloudflare/ai-chat", () => ({
  AIChatAgent: class {
    ctx: any;
    env: any;
    name = "owner_case";
    onMessage = async () => {};
    schedule = vi.fn(async () => ({ id: "expiry" }));
    async alarm() { await sdkAlarm(); }
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    getConnections() {
      return [];
    }
    setState() {}
  },
}));
vi.mock("agents", () => ({
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn(),
}));
vi.mock("agents/chat", () => ({ parseProtocolMessage: vi.fn() }));
vi.mock("@cloudflare/playwright", () => ({ launch: vi.fn() }));
import { getAgentByName } from "agents";
import { CaseAgent, InvestigationWorkflow } from "../src/server/index";
import { CAPTURE_BYTES } from "../src/server/evidence-limits";
import { hash, newCase, type CaseData } from "../src/shared/domain";

function state(initial?: CaseData) {
  let record = initial;
  const kv = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => kv.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      kv.set(key, value);
    }),
    setAlarm: vi.fn(),
    deleteAll: vi.fn(async () => {
      kv.clear();
      record = undefined;
    }),
    sql: {
      exec: vi.fn((query: string, data?: string) => {
        if (query.startsWith("INSERT")) record = JSON.parse(data!);
        return {
          toArray: () =>
            query.startsWith("SELECT") && record
              ? [{ data: JSON.stringify(record) }]
              : [],
        };
      }),
    },
  };
  return { storage, kv };
}
function bucket() {
  const values = new Map<string, string>();
  const api = {
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    get: vi.fn(async (key: string) => {
      const value = values.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return {
        size: bytes.length,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      };
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === "string" ? [keys] : keys)
        values.delete(key);
    }),
    list: vi.fn(
      async ({ prefix, limit }: { prefix: string; limit: number }) => ({
        objects: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .slice(0, limit)
          .map((key) => ({ key })),
      }),
    ),
  };
  return { values, api };
}
describe("case evidence lifecycle", () => {
  it("dispatches chat recovery alarms without deleting an unexpired case", async () => {
    sdkAlarm.mockClear();
    const c = newCase("correct"), ctx = state(c), r2 = bucket();
    r2.values.set("owner_case/evidence", "synthetic evidence");
    const agent = new CaseAgent(ctx as any, { EVIDENCE: r2.api } as any);
    await agent.alarm();
    await agent.alarm();
    expect(sdkAlarm).toHaveBeenCalledTimes(2);
    expect(agent.schedule).toHaveBeenCalledTimes(1);
    expect(agent.schedule).toHaveBeenCalledWith(new Date(Math.ceil(c.expiresAt / 1000) * 1000), "caseExpiryWake", null, { idempotent: true });
    expect(ctx.storage.deleteAll).not.toHaveBeenCalled();
    expect(r2.values.get("owner_case/evidence")).toBe("synthetic evidence");
    expect((await agent.data(false)).id).toBe(c.id);
  });
  it("still purges expired cases before the SDK touches scheduler tables", async () => {
    sdkAlarm.mockClear();
    const c = newCase("correct");
    c.expiresAt = Date.now() - 1;
    const ctx = state(c), r2 = bucket();
    r2.values.set("owner_case/evidence", "synthetic evidence");
    const agent = new CaseAgent(ctx as any, { EVIDENCE: r2.api } as any);
    await agent.alarm();
    expect(ctx.storage.deleteAll).toHaveBeenCalledTimes(1);
    expect(r2.values.size).toBe(0);
    expect(sdkAlarm).not.toHaveBeenCalled();
  });
  it("blocks queued snapshot writes even when workflow termination fails", async () => {
    const c = newCase("correct");
    c.activeWorkflow = "run";
    c.status = "analysing";
    const ctx = state(c),
      r2 = bucket();
    r2.values.set("owner_case/analysis-run", "private snapshot");
    r2.values.set("owner_case/orphan", "private body");
    r2.values.set("other_case/keep", "safe");
    const termination = vi.fn(async () => {
      throw Error("Synthetic unavailable provider");
    });
    const agent = new CaseAgent(
      ctx as any,
      {
        EVIDENCE: r2.api,
        INVESTIGATE: { get: async () => ({ terminate: termination }) },
      } as any,
    );
    const deleting = agent.purge();
    const late = agent.writeSnapshot("run", "late snapshot");
    await deleting;
    await expect(late).rejects.toThrow("Case unavailable");
    expect([...r2.values.keys()]).toEqual(["other_case/keep"]);
    expect(r2.api.put).not.toHaveBeenCalled();
    expect(termination).toHaveBeenCalled();
  });
  it("serializes initialization with deletion and rejects initialization after a tombstone", async () => {
    const c = newCase("correct"),
      ctx = state(),
      r2 = bucket();
    c.artifacts = [
      {
        id: "new",
        name: "synthetic",
        kind: "document",
        content: "private synthetic",
        sha256: "a".repeat(64),
      },
    ];
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    r2.api.put.mockImplementationOnce(async (key, value) => {
      entered();
      await held;
      r2.values.set(key, value);
    });
    const agent = new CaseAgent(ctx as any, { EVIDENCE: r2.api } as any);
    const initializing = agent.init(c, "owner");
    await started;
    const deleting = agent.purge();
    release();
    await initializing;
    await deleting;
    expect(r2.values.size).toBe(0);
    expect(ctx.kv.get("deleting")).toBe(true);
    await expect(agent.init(c, "owner")).rejects.toThrow("Case unavailable");
    expect(r2.values.size).toBe(0);
  });
  it("keeps the write gate if deletion fails, then permits a cleanup retry", async () => {
    const ctx = state(newCase("correct")),
      r2 = bucket();
    r2.values.set("owner_case/orphan", "private");
    r2.api.delete.mockRejectedValueOnce(Error("Synthetic R2 failure"));
    const agent = new CaseAgent(ctx as any, { EVIDENCE: r2.api } as any);
    await expect(agent.purge()).rejects.toThrow("Synthetic R2 failure");
    expect(ctx.kv.get("deleting")).toBe(true);
    await expect(agent.data()).rejects.toThrow("Case unavailable");
    await expect(agent.writeSnapshot("run", "late")).rejects.toThrow(
      "Case unavailable",
    );
    await agent.purge();
    expect(r2.values.size).toBe(0);
    expect(ctx.storage.deleteAll).toHaveBeenCalledTimes(1);
  });
  it("rejects excess aggregate stored bytes during hydration rather than after decoding every object", async () => {
    const c = newCase("correct"),
      content = "x".repeat(CAPTURE_BYTES),
      digest = await hash(content),
      r2 = bucket();
    c.artifacts = Array.from({ length: 66 }, (_, i) => ({
      id: `a${i}`,
      name: "synthetic",
      kind: "document",
      content: "",
      contentStored: true,
      observation: "rendered_dom",
      sha256: digest,
    }));
    c.artifacts.forEach((a) => r2.values.set(`owner_case/${a.id}`, content));
    const agent = new CaseAgent(state(c) as any, { EVIDENCE: r2.api } as any);
    await expect(agent.data()).rejects.toThrow("Stored evidence exceeds");
    expect(r2.api.get).toHaveBeenCalledTimes(65);
  });
  it("removes newly written bodies when a later persistence write fails", async () => {
    const c = newCase("correct"),
      r2 = bucket(),
      ctx = state();
    c.artifacts = ["a", "b"].map((id) => ({
      id,
      name: "synthetic",
      kind: "document",
      content: "synthetic",
      sha256: "a".repeat(64),
    }));
    const write = r2.api.put.getMockImplementation()!;
    r2.api.put
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(Error("Synthetic write failure"));
    const agent = new CaseAgent(ctx as any, { EVIDENCE: r2.api } as any);
    await expect(agent.init(c, "owner")).rejects.toThrow(
      "Synthetic write failure",
    );
    expect(r2.values.size).toBe(0);
    expect(
      ctx.storage.sql.exec.mock.calls.some(([q]) => q.startsWith("INSERT")),
    ).toBe(false);
  });
  it("removes workflow snapshots on verification failure while retaining committed case evidence", async () => {
    const c = newCase("correct"),
      r2 = bucket();
    r2.values.set("owner_case/committed", "original evidence");
    const agent = {
      snapshot: vi.fn(async () => ({ bundle: c, sessionId: "owner" })),
      writeSnapshot: vi.fn(async (id: string, data: string) =>
        r2.api.put(`owner_case/analysis-${id}`, data),
      ),
      fail: vi.fn(),
    };
    vi.mocked(getAgentByName).mockResolvedValue(agent as any);
    const workflow = new InvestigationWorkflow(
      {} as any,
      { EVIDENCE: r2.api } as any,
    );
    const step = {
      do: async (name: string, ...args: any[]) => {
        if (name === "Verify scope")
          throw Error("Synthetic verification failure");
        return args.at(-1)();
      },
    };
    await expect(
      workflow.run(
        {
          instanceId: "run",
          payload: {
            agentName: "owner_case",
            runId: "run",
            revision: 0,
            modelMode: "offline",
          },
        } as any,
        step as any,
      ),
    ).rejects.toThrow("Synthetic verification failure");
    expect([...r2.values.keys()]).toEqual(["owner_case/committed"]);
    expect(agent.fail).toHaveBeenCalledTimes(1);
  });
});
