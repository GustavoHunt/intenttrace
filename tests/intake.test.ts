import { describe, it, expect } from "vitest";
import {
  normalizeConversation,
  parseTranscript,
  shareProvider,
  IntakeSchema,
} from "../src/shared/intake";
import { decodeGraph, parseSharedHtml } from "../src/shared/share-html";
import { classifyAnswer, ClefResponseSchema } from "../src/server/clef";
import { intakeCase } from "../src/server/intake-case";
import { publicAddress, sourceUrl } from "../scripts/source-fetch";
import { hash } from "../src/shared/domain";

describe("conversation intake", () => {
  it("imports the selected ChatGPT branch and excludes system instructions", () => {
    const value = {
      title: "Branch",
      current_node: "b",
      mapping: {
        root: {
          parent: null,
          message: {
            author: { role: "system" },
            content: { parts: ["hidden"] },
          },
        },
        a: {
          parent: "root",
          message: {
            id: "a",
            author: { role: "user" },
            content: { parts: ["Make a CSV"] },
          },
        },
        b: {
          parent: "a",
          message: {
            id: "b",
            author: { role: "assistant" },
            content: { parts: ["Delivered"] },
          },
        },
        other: {
          parent: "a",
          message: {
            author: { role: "assistant" },
            content: { parts: ["other branch"] },
          },
        },
      },
    };
    expect(normalizeConversation(value).messages.map((m) => m.text)).toEqual([
      "Make a CSV",
      "Delivered",
    ]);
  });
  it("normalizes Claude text blocks while preserving user and assistant roles", () => {
    expect(
      normalizeConversation({
        chat_messages: [
          {
            uuid: "a",
            sender: "human",
            content: [{ type: "text", text: "Request" }],
          },
          { uuid: "b", sender: "assistant", text: "Response" },
        ],
      }).messages.map((m) => m.role),
    ).toEqual(["user", "assistant"]);
  });
  it("requires choosing a conversation from a multi-conversation export", () => {
    expect(() =>
      normalizeConversation([
        { mapping: {}, title: "a" },
        { mapping: {}, title: "b" },
      ]),
    ).toThrow("Select one");
  });
  it("reads labelled transcript without executing its content", () => {
    const parsed = parseTranscript(
      "User: Write a report\nAssistant: <script>secret()</script>",
    );
    expect(parsed.messages[1].text).toContain("<script>");
  });
  it("parses readable JSON and DOM share payloads", () => {
    const payload = {
      title: "Synthetic",
      messages: [
        { role: "user", content: "Write a report" },
        { role: "assistant", content: "Delivered" },
      ],
    };
    expect(
      parseSharedHtml(
        `<script type="application/json">${JSON.stringify(payload)}</script>`,
        "chatgpt",
      ).messages,
    ).toHaveLength(2);
    expect(
      parseSharedHtml(
        '<div data-testid="human-message">Hello</div><div data-testid="assistant-message">Hi</div>',
        "claude",
      ).messages,
    ).toHaveLength(2);
  });
  it("resolves flattened share graph without prototype pollution", () => {
    expect(
      decodeGraph([
        { messages: 1 },
        [2],
        { role: 3, content: 4 },
        "user",
        "Request",
      ]).messages[0].content,
    ).toBe("Request");
    const result = decodeGraph([
      JSON.parse('{"__proto__":1}'),
      { polluted: 2 },
      true,
    ]);
    expect(result.polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });
  it("reports dynamic/restricted pages as unavailable instead of inventing a transcript", () => {
    expect(() => parseSharedHtml("<html>Sign in</html>", "claude")).toThrow(
      "did not expose readable messages",
    );
  });
  it("accepts exact provider share URLs and rejects other hosts or credentials", () => {
    expect(
      shareProvider(
        "https://chatgpt.com/share/12345678-abcd-abcd-abcd-123456789abc",
      ),
    ).toBe("chatgpt");
    expect(shareProvider("https://claude.ai/share/abcdefghijklm")).toBe(
      "claude",
    );
    for (const url of [
      "https://chatgpt.com.evil.test/share/12345678901234567890",
      "https://x:secret@claude.ai/share/abcdefghijklm",
      "http://claude.ai/share/abcdefghijklm",
      "https://claude.ai/share/abcdefghijklm?token=secret",
    ])
      expect(() => shareProvider(url)).toThrow();
  });
  it.each([
    ["https://claude.ai/code/session_synthetic-123_A", "claude"],
    ["https://claude.ai/code/session_synthetic-123_A/", "claude"],
    ["https://chatgpt.com/c/synthetic-123", "chatgpt"],
    ["https://chatgpt.com/s/synthetic-123_A", "chatgpt"],
    ["https://chatgpt.com/s/synthetic-123_A/", "chatgpt"],
    ["https://chatgpt.com/synthetic-123", "chatgpt"],
    ["https://chatgpt.com/g/g-synthetic/c/synthetic-123/", "chatgpt"],
  ])("accepts vendor route %s", (url, provider) => {
    expect(shareProvider(url)).toBe(provider);
    expect(
      IntakeSchema.parse({
        title: "Synthetic",
        sourceUrl: url,
        provider,
        messages: [],
        originalPrompt: "Deliver a report",
        documents: [],
      }).sourceUrl,
    ).toBe(url);
  });
  it.each([
    "https://claude.ai/code/session_",
    "https://claude.ai/code/session_synthetic/more",
    "https://claude.ai/chat/synthetic",
    "https://claude.ai.evil.test/code/session_synthetic",
    "https://chatgpt.com/",
    "https://chatgpt.com:443/c/synthetic",
    "https://chatgpt.com/c/synthetic?token=private",
    "https://chatgpt.com/c/synthetic#private",
    "https://chatgpt.com/c/../synthetic",
    "https://chatgpt.com/c/%2e%2e/synthetic",
    "https://chatgpt.com//synthetic",
    "https://chatgpt.com/c/synthetic\n",
    "https://chatgpt.com@evil.test/c/synthetic",
    "https://evil.test/https://chatgpt.com/c/synthetic",
  ])("rejects malformed or unsafe route %s", (url) =>
    expect(() => shareProvider(url)).toThrow(),
  );
  it("creates unapproved supplied evidence with hashes of original extracted text", async () => {
    const input = IntakeSchema.parse({
      title: "Synthetic",
      provider: "manual",
      messages: [],
      originalPrompt: "Deliver a report",
      documents: [{ name: "report.txt", content: "Report text" }],
    });
    const c = await intakeCase(
      { MODE: "offline" } as any,
      "synthetic-session",
      input,
    );
    expect(c.scopes[0].confirmedAt).toBeNull();
    expect(c.runs).toHaveLength(0);
    expect(c.artifacts[0].content).toBe("Report text");
    expect(c.artifacts[0].sha256).toBe(await hash("Report text"));
    expect(c.events.every((e) => e.provenance === "supplied")).toBe(true);
  });
});
describe("source fetch boundaries", () => {
  it("blocks local, private, mapped private and special IPs", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "224.0.0.1",
      "0.0.0.0",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects URLs with credentials, non-HTTPS schemes or custom ports", () => {
    for (const url of [
      "file:///private",
      "http://example.com",
      "https://example.com:444",
      "https://user:pass@example.com",
    ])
      expect(() => sourceUrl(url, "artifact")).toThrow();
  });
});
describe("CLEF decisions", () => {
  const answer = (
    supported: number,
    contradicted: number,
    insufficient_evidence: number,
    choice = "supported",
  ) => ({
    type: "choice" as const,
    choice: choice as any,
    probabilities: { supported, contradicted, insufficient_evidence },
    confidence: 0.8,
  });
  it("routes weak probabilities and absent artifacts to insufficient evidence", () => {
    expect(classifyAnswer(answer(0.55, 0.25, 0.2), true)).toBe(
      "insufficient_evidence",
    );
    expect(classifyAnswer(answer(0.9, 0.05, 0.05), false)).toBe(
      "insufficient_evidence",
    );
    expect(classifyAnswer(answer(0.9, 0.05, 0.05), true)).toBe("supported");
  });
  it("rejects inconsistent probability totals and labels", () => {
    expect(() => classifyAnswer(answer(0.9, 0.8, 0.2), true)).toThrow(
      "inconsistent",
    );
    expect(() =>
      classifyAnswer(answer(0.9, 0.05, 0.05, "contradicted"), true),
    ).toThrow("inconsistent");
  });
  it("validates typed probabilities before publication", () => {
    expect(() =>
      ClefResponseSchema.parse({
        model: "clef",
        answers: { req_1: answer(2, 0, 0) },
      }),
    ).toThrow();
  });
});
