import { parseHTML } from "linkedom";
import { normalizeConversation, type ChatMessage } from "./intake.ts";

// Public Codex shares serve a versioned snapshot after loading the HTML shell.
// Import only conversation text; tools, reasoning, diffs and assets are not messages.
export function parseCodexSnapshot(value: unknown) {
  const snapshot = value as any;
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.turns))
    throw new Error(
      "Unsupported shared Codex snapshot. Use an export or paste the conversation instead.",
    );
  const messages: { role: string; content: string }[] = [];
  for (const turn of snapshot.turns) {
    if (!Array.isArray(turn?.items))
      throw new Error("Invalid shared Codex turn.");
    for (const item of turn.items) {
      if (item?.type === "userMessage" && Array.isArray(item.content)) {
        const content = item.content
          .filter(
            (part: any) =>
              part?.type === "text" && typeof part.text === "string",
          )
          .map((part: any) => part.text)
          .join("\n");
        if (content.trim()) messages.push({ role: "user", content });
      } else if (
        item?.type === "agentMessage" &&
        typeof item.text === "string" &&
        item.text.trim()
      ) {
        messages.push({ role: "assistant", content: item.text });
      }
    }
  }
  return normalizeConversation({ title: snapshot.title, messages });
}

// React Router's shared ChatGPT payload is a flattened graph. Resolve only its JSON data.
export function decodeGraph(flat: any[]): any {
  const cache = new Map<number, any>();
  function visit(index: number, depth = 0): any {
    if (index < 0 || index >= flat.length || depth > 120) return null;
    if (cache.has(index)) return cache.get(index);
    const v = flat[index];
    if (!v || typeof v !== "object") return v;
    const out: any = Array.isArray(v) ? [] : Object.create(null);
    cache.set(index, out);
    if (Array.isArray(v))
      v.forEach((x) => out.push(Number.isInteger(x) ? visit(x, depth + 1) : x));
    else
      Object.entries(v).forEach(([key, x]) => {
        const k = /^_[0-9]+$/.test(key)
          ? String(visit(Number(key.slice(1)), depth + 1))
          : key;
        if (!["__proto__", "constructor", "prototype"].includes(k))
          out[k] = Number.isInteger(x) ? visit(x as number, depth + 1) : x;
      });
    return out;
  }
  return visit(0);
}
export function parseSharedHtml(html: string, provider: "chatgpt" | "claude") {
  const { document } = parseHTML(html);
  const candidates: any[] = [];
  for (const script of Array.from(document.querySelectorAll("script"))) {
    const source = script.textContent || "";
    try {
      candidates.push(JSON.parse(source));
    } catch {}
    for (const match of source.matchAll(
      /(?:enqueue|push)\(("(?:[^"\\]|\\.)*")\)/g,
    )) {
      try {
        const str = JSON.parse(match[1]);
        const parsed = JSON.parse(str);
        candidates.push(
          parsed,
          Array.isArray(parsed) ? decodeGraph(parsed) : parsed,
        );
      } catch {}
    }
    // Next.js Flight embeds a JSON tuple containing its streamed payload.
    for (const match of source.matchAll(/\.push\((\[[\s\S]*?\])\)\s*;?/g)) {
      try {
        const item = JSON.parse(match[1]);
        if (typeof item[1] === "string")
          for (const line of item[1].split("\n")) {
            const start = line.indexOf(":");
            try {
              candidates.push(JSON.parse(line.slice(start + 1)));
            } catch {}
          }
      } catch {}
    }
  }
  const seen = new Set<any>();
  let count = 0;
  let result: { title: string; messages: ChatMessage[] } | undefined;
  function walk(v: any, depth = 0) {
    if (
      !v ||
      typeof v !== "object" ||
      seen.has(v) ||
      depth > 80 ||
      ++count > 25000
    )
      return;
    seen.add(v);
    if (v.mapping || v.chat_messages || v.messages)
      try {
        const c = normalizeConversation(v);
        if (!result || c.messages.length > result.messages.length) result = c;
      } catch {}
    Object.values(v).forEach((x) => walk(x, depth + 1));
  }
  candidates.forEach((x) => walk(x));
  if (!result) {
    const nodes = Array.from(
      document.querySelectorAll(
        '[data-message-author-role], [data-testid="user-message"], [data-testid="assistant-message"], [data-testid="human-message"]',
      ),
    );
    const messages = nodes
      .map((node, index) => ({
        id: `message-${index + 1}`,
        role:
          node.getAttribute("data-message-author-role") ||
          (/user|human/.test(node.getAttribute("data-testid") || "")
            ? "user"
            : "assistant"),
        text: (node.textContent || "").trim(),
      }))
      .filter((x) => x.text);
    if (messages.length)
      result = normalizeConversation({ title: document.title, messages });
  }
  if (!result)
    throw new Error(
      `${provider === "chatgpt" ? "ChatGPT" : "Claude"} did not expose readable messages. The link may be restricted or rendered dynamically. Import its JSON export or paste the conversation instead.`,
    );
  return result;
}
