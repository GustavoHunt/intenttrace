import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  BundleSchema,
  execute,
  newCase,
  validateBundle,
} from "../src/shared/domain";
mkdirSync("examples", { recursive: true });
mkdirSync("docs", { recursive: true });
writeFileSync(
  "docs/evidence-bundle.schema.json",
  JSON.stringify(z.toJSONSchema(BundleSchema), null, 2) + "\n",
);
for (const scenario of ["correct", "divergence", "missing"] as const) {
  const c = newCase(scenario);
  c.scopes[0].confirmedAt = new Date(Date.now() - 1000).toISOString();
  await execute(
    c,
    c.scopes[0].id,
    { selection: "filtered", includeNotes: false },
    "offline",
    crypto.randomUUID(),
  );
  const b = {
    schemaVersion: 1 as const,
    title: c.title,
    scopes: c.scopes,
    events: c.events,
    runs: c.runs,
    artifacts: c.artifacts,
  };
  validateBundle(b);
  writeFileSync(`examples/${scenario}.json`, JSON.stringify(b, null, 2) + "\n");
}
