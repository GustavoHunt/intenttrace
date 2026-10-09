import { z } from "zod";

export const CheckKind = z.enum([
  "http",
  "text",
  "canonical",
  "no_js",
  "faq",
  "accordion",
  "hreflang",
  "ci",
  "analytics",
]);
export const AcceptanceCheckSchema = z
  .object({
    id: z.string().regex(/^check_[1-9][0-9]?$/),
    requirementId: z.string().regex(/^req_[1-9][0-9]?$/),
    kind: CheckKind,
    url: z.string().url().max(2048).optional(),
    expected: z.string().max(500).default(""),
  })
  .strict();
export const EvidencePlanSchema = z
  .object({
    coverage: z.enum(["targeted", "expanded"]).default("targeted"),
    environment: z
      .enum(["unspecified", "staging", "production"])
      .default("unspecified"),
    targetUrls: z.array(z.string().url().max(2048)).max(8).default([]),
    connectionIds: z.array(z.uuid()).max(6).default([]),
    expectedCommit: z
      .string()
      .regex(/^(?:[a-f0-9]{40})?$/i)
      .default(""),
    maxAgeHours: z.number().int().min(1).max(720).default(24),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    checks: z.array(AcceptanceCheckSchema).max(24).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.environment !== "unspecified" && !p.targetUrls.length)
      ctx.addIssue({
        code: "custom",
        message: "Select a target website URL for the declared environment",
      });
    if (new Set(p.checks.map((c) => c.id)).size !== p.checks.length)
      ctx.addIssue({ code: "custom", message: "Check IDs must be unique" });
    if (!!p.startDate !== !!p.endDate)
      ctx.addIssue({ code: "custom", message: "Choose both report dates" });
    if (p.startDate && p.endDate) {
      const start = Date.parse(p.startDate),
        end = Date.parse(p.endDate);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        new Date(start).toISOString().slice(0, 10) !== p.startDate ||
        new Date(end).toISOString().slice(0, 10) !== p.endDate ||
        start > end ||
        end - start > 92 * 86400000 ||
        end > Date.now()
      )
        ctx.addIssue({
          code: "custom",
          message: "Use valid past dates in a range of at most 93 days",
        });
    }
    for (const c of p.checks) {
      if (
        c.kind === "http" &&
        c.expected &&
        !/^[1-5][0-9]{2}$/.test(c.expected)
      )
        ctx.addIssue({
          code: "custom",
          message: "HTTP checks need a status from 100 to 599",
        });
      if (
        c.kind === "canonical" &&
        c.expected &&
        !z.url().safeParse(c.expected).success
      )
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid expected canonical URL",
        });
      if (!["ci", "analytics"].includes(c.kind) && !c.url)
        ctx.addIssue({
          code: "custom",
          message: "Web checks require a target URL",
        });
      if (["text", "no_js", "analytics"].includes(c.kind) && !c.expected.trim())
        ctx.addIssue({
          code: "custom",
          message:
            "Text, server HTML and analytics checks require expected text or an event name",
        });
      if (c.kind === "ci" && !p.expectedCommit)
        ctx.addIssue({
          code: "custom",
          message: "A CI check requires the expected full commit SHA",
        });
    }
  });
export type EvidencePlan = z.infer<typeof EvidencePlanSchema>;
export const defaultEvidencePlan = (): EvidencePlan =>
  EvidencePlanSchema.parse({});
export const coverageLimits = (mode: EvidencePlan["coverage"]) =>
  mode === "expanded"
    ? { pages: 30, rounds: 6, milliseconds: 300000 }
    : { pages: 10, rounds: 2, milliseconds: 120000 };

export const ConnectionSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("cloudflare_access"),
      label: z.string().min(1).max(80),
      origin: z.string().url(),
      clientId: z.string().min(3).max(500),
      secret: z.string().min(3).max(4000),
    })
    .strict(),
  z
    .object({
      provider: z.literal("github"),
      label: z.string().min(1).max(80),
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      runId: z.string().regex(/^\d+$/),
      secret: z.string().min(3).max(4000),
    })
    .strict(),
  z
    .object({
      provider: z.literal("posthog"),
      label: z.string().min(1).max(80),
      region: z.enum(["eu", "us"]),
      projectId: z.string().regex(/^\d+$/),
      site: z.string().url(),
      secret: z.string().min(3).max(4000),
    })
    .strict(),
  z
    .object({
      provider: z.literal("search_console"),
      label: z.string().min(1).max(80),
      site: z.string().min(4).max(500),
      secret: z.string().min(3).max(4000),
    })
    .strict(),
  z
    .object({
      provider: z.literal("ga4"),
      label: z.string().min(1).max(80),
      propertyId: z.string().regex(/^\d+$/),
      secret: z.string().min(3).max(4000),
    })
    .strict(),
]);
export type ConnectionInput = z.infer<typeof ConnectionSchema>;
export type EvidenceConnection = ConnectionInput & {
  id: string;
  createdAt: string;
};
export type ConnectionView = {
  id: string;
  provider: ConnectionInput["provider"];
  label: string;
  resource: string;
  createdAt: string;
};
export function connectionView(c: EvidenceConnection): ConnectionView {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    createdAt: c.createdAt,
    resource:
      c.provider === "cloudflare_access"
        ? c.origin
        : c.provider === "github"
          ? `${c.repository} / run ${c.runId}`
          : c.provider === "ga4"
            ? `Property ${c.propertyId}`
            : c.site,
  };
}
export type CheckResult = {
  id: string;
  requirementId: string;
  label: string;
  status: "supported" | "contradicted" | "insufficient_evidence";
  explanation: string;
  artifactIds: string[];
};
