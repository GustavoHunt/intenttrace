import { describe, it, expect, vi } from "vitest";
import { SettingsSchema, defaultSettings } from "../src/shared/settings";
import { settingsView, withSettings } from "../src/server/settings";
import { assessRequirements } from "../src/server/clef";
import { modelJson } from "../src/server/ai";
import { newCase } from "../src/shared/domain";
import { z } from "zod";

describe("session AI settings", () => {
  it("defaults to no inference, even when old environment mode is live", () => {
    const env = { MODE: "live", AI: {}, AI_GATEWAY_ID: "synthetic" } as any;
    expect(settingsView(env, defaultSettings)).toEqual({
      clefEnabled: false,
      aiAvailable: true,
      mode: "offline",
    });
    expect(withSettings(env, { clefEnabled: true }).modelMode).toBe("live");
  });
  it("does not offer live mode without both provider bindings", () => {
    expect(settingsView({ AI: {} } as any, { clefEnabled: true }).mode).toBe(
      "offline",
    );
    expect(
      settingsView({ AI_GATEWAY_ID: "synthetic" } as any, defaultSettings)
        .aiAvailable,
    ).toBe(false);
  });
  it("rejects ambiguous or expanded settings payloads", () => {
    for (const input of [
      { clefEnabled: "true" },
      {},
      { clefEnabled: true, MODE: "live" },
    ])
      expect(() => SettingsSchema.parse(input)).toThrow();
  });
  it("switches Clef off, on and off without changing the provider connection", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        response: JSON.stringify({
          proposedStatus: "supported",
          explanation: "The supplied summary is present.",
          observations: ["A summary was supplied."],
          gaps: [],
          nextSteps: [],
          citations: [
            { quoteId: "Q1" },
          ],
        }),
      })
      .mockResolvedValue({
        model: "synthetic-clef",
        answers: {
          req_1: {
            type: "choice",
            choice: "supported",
            probabilities: {
              supported: 0.9,
              contradicted: 0.05,
              insufficient_evidence: 0.05,
            },
            confidence: 0.9,
          },
        },
      });
    const reserve = vi.fn().mockResolvedValue(true);
    const env = {
      AI: { run },
      AI_GATEWAY_ID: "synthetic",
      BUDGET: { idFromName: () => "budget", get: () => ({ reserve }) },
    } as any;
    const c = newCase("correct");
    c.scopes[0].requirements = [{ id: "req_1", text: "Deliver a summary" }];
    c.artifacts = [
      {
        id: "artifact",
        name: "summary.txt",
        kind: "document",
        content: "Summary of synthetic delivery",
        sha256: "synthetic",
        createdAt: "synthetic",
      },
    ] as any;
    const off = withSettings(env, defaultSettings);
    expect(
      (await assessRequirements(off, "synthetic-session", c)).decision.mode,
    ).toBe("offline");
    expect(run).not.toHaveBeenCalled();
    const started = withSettings(env, { clefEnabled: true });
    const next = withSettings(env, defaultSettings);
    expect(
      (await assessRequirements(started, "synthetic-session", c)).findings[0]
        .status,
    ).toBe("supported");
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      (await assessRequirements(next, "synthetic-session", c)).decision.mode,
    ).toBe("offline");
    expect(run).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
  });
  it("also blocks new Llama calls when the session is offline", async () => {
    const run = vi.fn();
    const env = withSettings(
      { AI: { run }, AI_GATEWAY_ID: "synthetic" } as any,
      defaultSettings,
    );
    await expect(
      modelJson(
        env,
        "synthetic-session",
        "Explain",
        "Synthetic",
        z.object({ text: z.string() }),
      ),
    ).rejects.toThrow("not configured");
    expect(run).not.toHaveBeenCalled();
  });
});
