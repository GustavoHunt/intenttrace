import { z } from "zod";

export const MessageSchema = z
  .object({
    id: z.string().max(100),
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(60000),
  })
  .strict();
export const RequirementSchema = z
  .object({
    id: z.string().regex(/^req_[1-9][0-9]?$/),
    text: z.string().min(3).max(1000),
  })
  .strict();
export type Requirement = z.infer<typeof RequirementSchema>;
export const DocumentSchema = z
  .object({
    name: z.string().min(1).max(150),
    content: z.string().min(1).max(300000),
    mediaType: z.string().max(100).default("text/plain"),
    sourceUrl: z.string().url().max(2048).optional(),
    originalSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const IntakeSchema = z
  .object({
    title: z.string().min(1).max(150),
    sourceUrl: z
      .string()
      .url()
      .max(2048)
      .refine((url) => {
        try {
          shareProvider(url);
          return true;
        } catch {
          return false;
        }
      }, "Use a supported ChatGPT or Claude conversation URL.")
      .optional(),
    provider: z.enum(["chatgpt", "claude", "manual", "export"]),
    messages: z.array(MessageSchema).max(150),
    originalPrompt: z.string().min(3).max(6000),
    documents: z.array(DocumentSchema).max(8),
    warnings: z.array(z.string().max(300)).max(8).default([]),
  })
  .strict();
export type Intake = z.infer<typeof IntakeSchema>;
export type ChatMessage = z.infer<typeof MessageSchema>;
export type ImportedDocument = z.infer<typeof DocumentSchema>;

// Validate the complete raw URL, not a substring or a normalized dot-segment path.
// Matching a vendor route establishes its format, not public readability.
export const CONVERSATION_LINK_PATTERNS = {
  chatgpt: /^https:\/\/chatgpt\.com\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/i,
  claude:
    /^https:\/\/claude\.ai\/(?:share\/[A-Za-z0-9_-]+|code\/session_[A-Za-z0-9_-]+)\/?$/i,
} as const;

export function shareProvider(raw: string): "chatgpt" | "claude" {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    raw.length > 2048 ||
    raw !== raw.trim()
  )
    throw new Error(
      "Use an HTTPS ChatGPT or Claude conversation URL without credentials, query parameters or fragments.",
    );
  if (
    u.hostname === "chatgpt.com" &&
    CONVERSATION_LINK_PATTERNS.chatgpt.test(raw)
  )
    return "chatgpt";
  if (u.hostname === "claude.ai" && CONVERSATION_LINK_PATTERNS.claude.test(raw))
    return "claude";
  throw new Error(
    "Use a chatgpt.com/<route>, claude.ai/share/<id>, or claude.ai/code/session_<id> URL.",
  );
}
const textOf = (value: any): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (value.parts) return textOf(value.parts);
    if (value.content) return textOf(value.content);
  }
  return "";
};
export function normalizeConversation(value: any): {
  title: string;
  messages: ChatMessage[];
} {
  if (
    Array.isArray(value) &&
    value.length &&
    (value[0].mapping || value[0].chat_messages)
  ) {
    if (value.length !== 1)
      throw new Error(
        "Select one conversation from your export before importing it.",
      );
    value = value[0];
  }
  const messages: ChatMessage[] = [];
  const add = (node: any) => {
    const m = node?.message || node;
    const role =
      m?.author?.role ||
      m?.role ||
      (m?.sender === "human"
        ? "user"
        : m?.sender === "assistant"
          ? "assistant"
          : null);
    const text = textOf(m?.content ?? m?.text).trim();
    if (["user", "assistant"].includes(role) && text)
      messages.push({
        id: String(m.id || m.uuid || `message-${messages.length + 1}`).slice(
          0,
          100,
        ),
        role,
        text,
      });
  };
  if (value?.mapping && value.current_node) {
    const branch: any[] = [];
    const visited = new Set<string>();
    let id = value.current_node;
    while (id && value.mapping[id] && !visited.has(id)) {
      visited.add(id);
      const node = value.mapping[id];
      branch.unshift(node);
      id = node.parent;
    }
    branch.forEach(add);
  } else if (value?.mapping) Object.values(value.mapping).forEach(add);
  else if (value?.chat_messages) value.chat_messages.forEach(add);
  else if (value?.messages) value.messages.forEach(add);
  else if (Array.isArray(value)) value.forEach(add);
  if (!messages.length)
    throw new Error(
      "No readable user or assistant messages were found. Paste the original prompt and add the artifact instead.",
    );
  z.array(MessageSchema).max(150).parse(messages);
  return {
    title: String(
      value?.title || value?.name || "Conversation investigation",
    ).slice(0, 150),
    messages,
  };
}
export function parseTranscript(text: string) {
  const parts = text.split(/^(User|Human|Assistant|ChatGPT|Claude):\s*/gim);
  const messages: ChatMessage[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const content = parts[i + 1]?.trim();
    if (content)
      messages.push({
        id: `message-${messages.length + 1}`,
        role: /^(user|human)$/i.test(parts[i]) ? "user" : "assistant",
        text: content,
      });
  }
  if (!messages.length)
    throw new Error(
      "Use User: and Assistant: labels, or import a ChatGPT/Claude JSON export.",
    );
  return normalizeConversation({ messages });
}
