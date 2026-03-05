#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function usage() {
  console.error("Usage: node scripts/onboarding/parse-onboarding-log.mjs --in <log-file> [--out <json-file>]");
}

function parseArgs(argv) {
  const args = { in: "", out: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--in") {
      args.in = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (token === "--out") {
      args.out = argv[i + 1] || "";
      i += 1;
      continue;
    }
  }
  return args;
}

function stripAnsi(input) {
  return input
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/\r/g, "");
}

function normalizeLine(line) {
  return line
    .replace(/\t/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripBoxPrefix(line) {
  return line.replace(/^[│└├┌┐┘┤┬┴┼◆◇■\s]+/u, "").trim();
}

function isNoise(line) {
  if (!line) return true;
  if (/^Script (started|done) on /i.test(line)) return true;
  if (/^Type "?help"? for/i.test(line)) return true;
  if (/^[│└├┌┐┘┤┬┴┼─\s]+$/u.test(line)) return true;
  return false;
}

function isOption(line) {
  const text = stripBoxPrefix(line);
  return (
    /^[●○]\s+.+/u.test(text) ||
    /^([>\-*]|\u203A)?\s*(\d+[.)]|[a-z][.)])\s+.+/i.test(line) ||
    /^([>\-*]|\u203A)?\s*\[[ xX]?\]\s+.+/.test(line) ||
    /^([>\-*]|\u203A)?\s*\(.+\)\s*.+/.test(line)
  );
}

function isPrompt(line) {
  const text = stripBoxPrefix(line);
  if (!line) return false;
  if (isOption(line)) return false;
  if (/^Gateway (port|bind|auth):/i.test(text)) return false;
  if (/^Tailscale exposure:/i.test(text)) return false;
  if (/^Direct to chat channels/i.test(text)) return false;
  if (/^Model\/auth provider$/i.test(text)) return true;
  if (/[?:]$/.test(text)) return true;
  return /\b(select|choose|pick|enter|input|provide|api key|token|model|provider|workspace|port|auth|confirm|yes\/no|y\/n|password|path|name|region)\b/i.test(
    text
  );
}

function inferType(prompt, options) {
  const text = `${prompt} ${options.join(" ")}`.toLowerCase();
  if (options.length > 0 || /select|choose|pick|option/.test(text)) return "select";
  if (/api key|token|password|secret/.test(text)) return "secret";
  if (/yes\/no|y\/n|confirm|continue|proceed|accept/.test(text)) return "confirm";
  return "input";
}

function extractDefault(prompt) {
  const bracket = prompt.match(/\[([^\]]+)\]/);
  if (bracket) return bracket[1];
  const paren = prompt.match(/\(default:\s*([^\)]+)\)/i);
  if (paren) return paren[1].trim();
  return "";
}

function buildSteps(lines) {
  const steps = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const promptText = stripBoxPrefix(line);

    if (!isPrompt(line)) {
      i += 1;
      continue;
    }

    const context = [promptText];
    const options = [];
    const validations = [];
    let j = i + 1;

    while (j < lines.length) {
      const next = lines[j];
      const nextText = stripBoxPrefix(next);
      if (!next) {
        break;
      }
      if (isPrompt(next) && options.length === 0) {
        break;
      }
      if (isOption(next)) {
        options.push(nextText.replace(/^[●○]\s+/u, ""));
        context.push(nextText);
        j += 1;
        continue;
      }
      if (/(required|must|invalid|error|failed|cannot|timeout|unauthorized|forbidden)/i.test(nextText)) {
        validations.push(nextText);
        context.push(nextText);
        j += 1;
        continue;
      }
      if (options.length > 0 && !isOption(next)) {
        break;
      }
      context.push(nextText);
      if (context.length >= 6) {
        break;
      }
      j += 1;
    }

    const stepId = `step-${String(steps.length + 1).padStart(2, "0")}`;
    const prompt = promptText;

    steps.push({
      stepId,
      prompt,
      type: inferType(prompt, options),
      options,
      defaultValue: extractDefault(prompt),
      validations,
      rawContext: context,
      sourceLine: i + 1,
    });

    i = Math.max(j, i + 1);
  }

  return steps;
}

function collectErrors(lines) {
  const errors = [];
  lines.forEach((line, index) => {
    if (/(error|failed|invalid|timeout|unauthorized|forbidden|could not|cannot)/i.test(line)) {
      errors.push({ line: index + 1, message: line });
    }
  });
  return errors;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.in) {
    usage();
    process.exit(1);
  }

  const inputPath = path.resolve(args.in);
  const outPath = args.out
    ? path.resolve(args.out)
    : path.resolve(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.json`);

  const raw = await fs.readFile(inputPath, "utf8");
  const cleaned = stripAnsi(raw);
  const lines = cleaned
    .split("\n")
    .map(normalizeLine)
    .filter((line) => !isNoise(line));

  const steps = buildSteps(lines);
  const errors = collectErrors(lines);

  const payload = {
    sourceLog: inputPath,
    generatedAt: new Date().toISOString(),
    totalLines: lines.length,
    stepCount: steps.length,
    steps,
    errors,
  };

  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Wrote ${steps.length} steps to ${outPath}`);
  if (errors.length > 0) {
    console.log(`Detected ${errors.length} error-like lines in log.`);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
