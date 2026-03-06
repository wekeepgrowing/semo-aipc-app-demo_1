const fs = require("fs");
const path = require("path");

function toDayKey(ts) {
  const date = new Date(Number(ts) || Date.now());
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeUsageRow(row = {}) {
  const inputTokens = Number(row.inputTokens || 0);
  const outputTokens = Number(row.outputTokens || 0);
  const totalTokens = Number(row.totalTokens || inputTokens + outputTokens || 0);
  const costUsd = Number(row.costUsd || 0);

  return {
    runId: String(row.runId || "unknown"),
    provider: String(row.provider || "unknown"),
    model: String(row.model || "unknown"),
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    ts: Number(row.ts || Date.now()),
  };
}

function parseDateInput(value, fallback) {
  if (!value) return fallback;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

class UsageLedger {
  constructor({ dir }) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  append(row) {
    const normalized = normalizeUsageRow(row);
    const key = toDayKey(normalized.ts);
    const file = path.join(this.dir, `usage-${key}.ndjson`);
    try {
      fs.appendFileSync(file, `${JSON.stringify(normalized)}\n`);
    } catch (error) {
      console.error("usage-ledger append failed:", error.message);
    }
    return normalized;
  }

  query({ from, to, limit = 200 } = {}) {
    const now = Date.now();
    const fromTs = parseDateInput(from, now - 30 * 24 * 60 * 60 * 1000);
    const toTs = parseDateInput(to, now + 1);

    const files = fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^usage-\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry.name))
      .map((entry) => path.join(this.dir, entry.name))
      .sort();

    const rows = [];
    for (const file of files) {
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }

      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = normalizeUsageRow(JSON.parse(line));
          if (parsed.ts < fromTs || parsed.ts > toTs) continue;
          rows.push(parsed);
        } catch {
          // skip malformed line
        }
      }
    }

    rows.sort((a, b) => b.ts - a.ts);
    const sliced = rows.slice(0, Math.max(1, Math.min(2000, Number(limit) || 200)));

    const summary = sliced.reduce(
      (acc, row) => {
        acc.totalTokens += Number(row.totalTokens || 0);
        acc.totalCostUsd += Number(row.costUsd || 0);
        return acc;
      },
      { totalTokens: 0, totalCostUsd: 0 }
    );

    summary.totalTokens = Math.round(summary.totalTokens);
    summary.totalCostUsd = +summary.totalCostUsd.toFixed(6);

    return {
      rows: sliced,
      summary,
    };
  }
}

module.exports = {
  UsageLedger,
  normalizeUsageRow,
};
