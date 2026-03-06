const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const TARGET_DIRS = [path.join(ROOT, "ui", "src")];
const TARGET_FILES = [
  path.join(ROOT, "server.cjs"),
  path.join(ROOT, "lib", "runtime", "default-skills.cjs"),
  path.join(ROOT, "lib", "runtime", "feature-contract.cjs"),
  path.join(ROOT, "lib", "runtime", "feature-toggle-manager.cjs"),
  path.join(ROOT, "lib", "runtime", "openclaw-adapter.cjs"),
  path.join(ROOT, "lib", "runtime", "runtime-store.cjs"),
  path.join(ROOT, "lib", "runtime", "usecase-demo-runtime.cjs"),
];

const BANNED_PATTERNS = [
  { label: "formal-nida", regex: /[가-힣]니다(?:[.?!'"`]|$)/ },
  { label: "formal-hasigess", regex: /하시겠/ },
  { label: "formal-gyesi", regex: /계시/ },
  { label: "formal-yeojjub", regex: /여쭙/ },
  { label: "sentence-final-dot", regex: /(?:\.\.\.|…|\.)\s*$/ },
  { label: "sentence-middle-dot", regex: /[가-힣0-9)]\.\s+[가-힣]/ },
];

const ALLOWLIST = [
  "OpenClaw did not confirm execution feature enforcement",
  "OpenClaw confirmed a different execution feature set",
  "execution feature enforcement failed",
  "runtime operation failed",
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const nextPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(nextPath));
      continue;
    }
    if (/\.(js|jsx)$/.test(entry.name)) out.push(nextPath);
  }
  return out;
}

function normalizeRel(filePath) {
  return path.relative(ROOT, filePath) || filePath;
}

function shouldSkip(line) {
  return ALLOWLIST.some((token) => line.includes(token));
}

function sanitizeCandidateText(text) {
  return String(text || "")
    .replace(/\$\{[^}]*\}/g, "")
    .replace(/\\./g, "")
    .trim();
}

function extractCandidateTexts(line) {
  const out = [];
  const stringLiteralRegex = /(["`])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = stringLiteralRegex.exec(line))) {
    out.push(match[2]);
  }

  const jsxTextRegex = />([^<]*)</g;
  while ((match = jsxTextRegex.exec(line))) {
    out.push(match[1]);
  }

  return out.map(sanitizeCandidateText).filter(Boolean);
}

const files = [...TARGET_FILES, ...TARGET_DIRS.flatMap(walk)].filter((filePath) => fs.existsSync(filePath));
const problems = [];

for (const filePath of files) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/[가-힣]/.test(line) || shouldSkip(line)) return;
    const candidates = extractCandidateTexts(line);
    if (candidates.length === 0) return;
    for (const candidate of candidates) {
      if (!/[가-힣]/.test(candidate) || shouldSkip(candidate)) continue;
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.regex.test(candidate)) {
          problems.push({
            filePath,
            line: index + 1,
            label: pattern.label,
            text: candidate,
          });
          return;
        }
      }
    }
  });
}

if (problems.length > 0) {
  console.error("UX writing check failed:\n");
  for (const problem of problems) {
    console.error(`${normalizeRel(problem.filePath)}:${problem.line} [${problem.label}] ${problem.text}`);
  }
  process.exit(1);
}

console.log(`UX writing check passed (${files.length} files)`);
