const fs = require("fs");

const DEFAULT_TIMEOUT_MS = 3500;

function readTokenFromFile(path) {
  try {
    const value = fs.readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function getNested(source, path) {
  if (!source || typeof source !== "object") return undefined;
  let cursor = source;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    const value = key.includes(".") ? getNested(source, key) : source?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function numberValue(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bytesToGb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return null;
  return n / 1024 ** 3;
}

function normalizeMetrics(payload) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;

  const cpuPercent = numberValue(
    firstDefined(source, ["cpuPercent", "cpu.percent", "cpu.usagePercent", "cpu.usage", "cpu.loadPercent"]),
    0
  );

  const cpuTempRaw = firstDefined(source, [
    "cpuTempC",
    "cpu.tempC",
    "cpu.temperatureC",
    "temperatures.cpuC",
    "temperatures.cpu",
  ]);
  const cpuTempC = numberOrNull(cpuTempRaw);

  const memUsedGbDirect = numberOrNull(firstDefined(source, ["memUsedGb", "memory.usedGb"]));
  const memTotalGbDirect = numberOrNull(firstDefined(source, ["memTotalGb", "memory.totalGb"]));
  const memUsedGbFromBytes = bytesToGb(firstDefined(source, ["memory.usedBytes", "memory.used"]));
  const memTotalGbFromBytes = bytesToGb(firstDefined(source, ["memory.totalBytes", "memory.total"]));

  const memUsedGb = memUsedGbDirect ?? memUsedGbFromBytes ?? 0;
  const memTotalGb = memTotalGbDirect ?? memTotalGbFromBytes ?? 0;
  const memPercentRaw = firstDefined(source, ["memPercent", "memory.percent", "memory.usedPercent"]);
  const memPercent =
    memPercentRaw !== undefined && memPercentRaw !== null
      ? numberValue(memPercentRaw, 0)
      : memTotalGb > 0
      ? (memUsedGb * 100) / memTotalGb
      : 0;

  const diskUsedGbDirect = numberOrNull(firstDefined(source, ["diskUsedGb", "disk.usedGb", "storage.disk.usedGb"]));
  const diskTotalGbDirect = numberOrNull(
    firstDefined(source, ["diskTotalGb", "disk.totalGb", "storage.disk.totalGb"])
  );
  const diskUsedGbFromBytes = bytesToGb(
    firstDefined(source, ["disk.usedBytes", "disk.used", "storage.disk.usedBytes"])
  );
  const diskTotalGbFromBytes = bytesToGb(
    firstDefined(source, ["disk.totalBytes", "disk.total", "storage.disk.totalBytes"])
  );

  const diskUsedGb = diskUsedGbDirect ?? diskUsedGbFromBytes ?? 0;
  const diskTotalGb = diskTotalGbDirect ?? diskTotalGbFromBytes ?? 0;
  const diskPercentRaw = firstDefined(source, ["diskPercent", "disk.percent", "storage.disk.percent"]);
  const diskPercent =
    diskPercentRaw !== undefined && diskPercentRaw !== null
      ? numberValue(diskPercentRaw, 0)
      : diskTotalGb > 0
      ? (diskUsedGb * 100) / diskTotalGb
      : 0;

  const rxBps = numberValue(
    firstDefined(source, ["rxBps", "network.rxBps", "network.rxBytesPerSec", "network.inBps"]),
    0
  );
  const txBps = numberValue(
    firstDefined(source, ["txBps", "network.txBps", "network.txBytesPerSec", "network.outBps"]),
    0
  );

  const tsRaw = firstDefined(source, ["ts", "timestamp", "time"]);
  let ts = Date.now();
  if (typeof tsRaw === "number" && Number.isFinite(tsRaw)) {
    ts = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
  } else if (typeof tsRaw === "string") {
    const parsed = Date.parse(tsRaw);
    if (Number.isFinite(parsed)) ts = parsed;
  }

  return {
    cpuPercent: +cpuPercent.toFixed(1),
    cpuTempC: cpuTempC == null ? null : +cpuTempC.toFixed(1),
    memUsedGb: +memUsedGb.toFixed(2),
    memTotalGb: +memTotalGb.toFixed(2),
    memPercent: +memPercent.toFixed(1),
    diskUsedGb: +diskUsedGb.toFixed(2),
    diskTotalGb: +diskTotalGb.toFixed(2),
    diskPercent: +diskPercent.toFixed(1),
    rxBps: Math.max(0, Math.round(rxBps)),
    txBps: Math.max(0, Math.round(txBps)),
    ts,
  };
}

function resolveMetricsConfig() {
  const baseUrl = process.env.OUR_OS_METRICS_BASE_URL;
  const path = process.env.OUR_OS_METRICS_PATH || "/api/v1/system/metrics";
  const authMode = (process.env.OUR_OS_METRICS_AUTH_MODE || "none").toLowerCase();
  const timeoutMs = numberValue(process.env.OUR_OS_METRICS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const tokenFromEnv = process.env.OUR_OS_METRICS_TOKEN || null;
  const tokenFromFile = process.env.OUR_OS_METRICS_TOKEN_FILE
    ? readTokenFromFile(process.env.OUR_OS_METRICS_TOKEN_FILE)
    : null;

  return {
    baseUrl,
    path,
    authMode,
    token: tokenFromEnv || tokenFromFile,
    timeoutMs,
  };
}

async function fetchOurOsMetrics() {
  const config = resolveMetricsConfig();

  if (!config.baseUrl) {
    throw new Error("OUR_OS_METRICS_BASE_URL is required");
  }

  const url = new URL(config.path, config.baseUrl).toString();
  const headers = {
    Accept: "application/json",
  };

  if (config.authMode === "bearer") {
    if (!config.token) {
      throw new Error("OUR_OS_METRICS_TOKEN or OUR_OS_METRICS_TOKEN_FILE is required for bearer auth");
    }
    headers.Authorization = `Bearer ${config.token}`;
  }

  if (config.authMode === "x-api-key") {
    if (!config.token) {
      throw new Error("OUR_OS_METRICS_TOKEN or OUR_OS_METRICS_TOKEN_FILE is required for x-api-key auth");
    }
    headers["x-api-key"] = config.token;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: ac.signal,
    });

    if (!response.ok) {
      const snippet = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`metrics API responded ${response.status}${snippet ? `: ${snippet}` : ""}`);
    }

    const payload = await response.json();
    return normalizeMetrics(payload);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchOurOsMetrics,
  normalizeMetrics,
};
