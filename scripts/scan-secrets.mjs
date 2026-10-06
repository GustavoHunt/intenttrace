import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{25,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{25,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /(?:api[_-]?token|secret[_-]?key|session_signing_secret)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{24,}["']/i,
];
let count = 0;
for (const file of files) {
  if (
    /\.(?:png|jpg|webp|woff2|pdf)$/.test(file) ||
    file === "package-lock.json"
  )
    continue;
  if (
    /(^|\/)(?:\.dev\.vars|\.env)(?:\.|$)/.test(file) &&
    !file.endsWith(".example")
  ) {
    console.error(`Private configuration tracked: ${file}`);
    count++;
    continue;
  }
  const text = await readFile(file, "utf8");
  if (patterns.some((pattern) => pattern.test(text))) {
    console.error(`Potential credential in ${file}; value withheld`);
    count++;
  }
}
if (count) process.exit(1);
console.log(
  `Scanned ${files.length} public files; no matching credential patterns. This is a heuristic, not a proof of absence.`,
);
