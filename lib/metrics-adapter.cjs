const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 3500;
const CGROUP_ROOT = "/sys/fs/cgroup";
const PROC_ROOT = "/proc";

let lastCpuSample = null;
let lastNetworkSample = null;

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

function readNumberFile(filePath) {
  const value = readText(filePath);
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function safeStatfs(targetPath) {
  try {
    return fs.statfsSync(targetPath);
  } catch {
    return null;
  }
}

function resolveDiskPath() {
  const candidates = ["/data", process.cwd(), "/"];
  for (const candidate of candidates) {
    if (candidate && fileExists(candidate)) return candidate;
  }
  return "/";
}

function readCpuUsageMicros() {
  const cgroupV2 = readText(path.join(CGROUP_ROOT, "cpu.stat"));
  if (cgroupV2) {
    const usageLine = cgroupV2
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("usage_usec "));
    if (usageLine) {
      const value = Number(usageLine.split(/\s+/)[1]);
      if (Number.isFinite(value)) return value;
    }
  }

  const cpuacctNs = readNumberFile(path.join(CGROUP_ROOT, "cpuacct", "cpuacct.usage"));
  if (cpuacctNs != null) return cpuacctNs / 1000;

  return null;
}

function readCpuLimitCores() {
  const cpuMaxRaw = readText(path.join(CGROUP_ROOT, "cpu.max"));
  if (cpuMaxRaw) {
    const [quotaRaw, periodRaw] = cpuMaxRaw.split(/\s+/);
    if (quotaRaw && quotaRaw !== "max") {
      const quota = Number(quotaRaw);
      const period = Number(periodRaw);
      if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
        return Math.max(1, quota / period);
      }
    }
  }

  const quota = readNumberFile(path.join(CGROUP_ROOT, "cpu", "cpu.cfs_quota_us"));
  const period = readNumberFile(path.join(CGROUP_ROOT, "cpu", "cpu.cfs_period_us"));
  if (quota != null && period != null && quota > 0 && period > 0) {
    return Math.max(1, quota / period);
  }

  const cpuCount = Array.isArray(os.cpus()) && os.cpus().length > 0 ? os.cpus().length : 1;
  return cpuCount;
}

function readMemoryStats() {
  const currentV2 = readNumberFile(path.join(CGROUP_ROOT, "memory.current"));
  const maxRawV2 = readText(path.join(CGROUP_ROOT, "memory.max"));
  const currentV1 = readNumberFile(path.join(CGROUP_ROOT, "memory", "memory.usage_in_bytes"));
  const maxV1 = readNumberFile(path.join(CGROUP_ROOT, "memory", "memory.limit_in_bytes"));

  const processRss = Number(process.memoryUsage?.().rss || 0);
  const usedBytes = currentV2 ?? currentV1 ?? processRss;
  let totalBytes = 0;

  if (maxRawV2 && maxRawV2 !== "max") {
    const parsed = Number(maxRawV2);
    if (Number.isFinite(parsed) && parsed > 0) totalBytes = parsed;
  } else if (maxV1 != null && maxV1 > 0) {
    totalBytes = maxV1;
  }

  const hostTotal = Number(os.totalmem?.() || 0);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || (hostTotal > 0 && totalBytes > hostTotal * 8)) {
    totalBytes = hostTotal;
  }

  const memUsedGb = bytesToGb(usedBytes) ?? 0;
  const memTotalGb = bytesToGb(totalBytes) ?? 0;
  const memPercent = memTotalGb > 0 ? (memUsedGb * 100) / memTotalGb : 0;

  return {
    memUsedGb: +memUsedGb.toFixed(2),
    memTotalGb: +memTotalGb.toFixed(2),
    memPercent: +clamp(memPercent, 0, 100).toFixed(1),
  };
}

function readDiskStats() {
  const diskPath = resolveDiskPath();
  const stat = safeStatfs(diskPath);
  if (!stat) {
    return {
      diskUsedGb: 0,
      diskTotalGb: 0,
      diskPercent: 0,
    };
  }

  const totalBytes = Number(stat.blocks || 0) * Number(stat.bsize || 0);
  const freeBlocks = stat.bavail ?? stat.bfree ?? 0;
  const freeBytes = Number(freeBlocks || 0) * Number(stat.bsize || 0);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const diskTotalGb = bytesToGb(totalBytes) ?? 0;
  const diskUsedGb = bytesToGb(usedBytes) ?? 0;
  const diskPercent = diskTotalGb > 0 ? (diskUsedGb * 100) / diskTotalGb : 0;

  return {
    diskUsedGb: +diskUsedGb.toFixed(2),
    diskTotalGb: +diskTotalGb.toFixed(2),
    diskPercent: +clamp(diskPercent, 0, 100).toFixed(1),
  };
}

function readNetworkTotals() {
  const raw = readText(path.join(PROC_ROOT, "net", "dev"));
  if (!raw) return null;

  let rxBytes = 0;
  let txBytes = 0;

  for (const line of raw.split(/\r?\n/).slice(2)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ifaceRaw, payloadRaw] = trimmed.split(":");
    if (!ifaceRaw || !payloadRaw) continue;
    const iface = ifaceRaw.trim();
    if (!iface || iface === "lo") continue;
    const parts = payloadRaw.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const rx = Number(parts[0]);
    const tx = Number(parts[8]);
    if (Number.isFinite(rx)) rxBytes += rx;
    if (Number.isFinite(tx)) txBytes += tx;
  }

  return {
    rxBytes,
    txBytes,
  };
}

function sampleCpuPercent(nowTs) {
  const usageMicros = readCpuUsageMicros();
  const limitCores = readCpuLimitCores();
  if (usageMicros == null) return 0;

  if (!lastCpuSample) {
    lastCpuSample = { ts: nowTs, usageMicros, limitCores };
    return 0;
  }

  const elapsedMs = nowTs - lastCpuSample.ts;
  const deltaUsage = usageMicros - lastCpuSample.usageMicros;
  lastCpuSample = { ts: nowTs, usageMicros, limitCores };

  if (elapsedMs <= 0 || deltaUsage < 0) return 0;

  const usageFraction = deltaUsage / (elapsedMs * 1000 * Math.max(1, limitCores));
  return +clamp(usageFraction * 100, 0, 100).toFixed(1);
}

function sampleNetworkBps(nowTs) {
  const totals = readNetworkTotals();
  if (!totals) return { rxBps: 0, txBps: 0 };

  if (!lastNetworkSample) {
    lastNetworkSample = { ts: nowTs, ...totals };
    return { rxBps: 0, txBps: 0 };
  }

  const elapsedMs = nowTs - lastNetworkSample.ts;
  const deltaRx = totals.rxBytes - lastNetworkSample.rxBytes;
  const deltaTx = totals.txBytes - lastNetworkSample.txBytes;
  lastNetworkSample = { ts: nowTs, ...totals };

  if (elapsedMs <= 0) return { rxBps: 0, txBps: 0 };

  const seconds = elapsedMs / 1000;
  return {
    rxBps: Math.max(0, Math.round(deltaRx / seconds)),
    txBps: Math.max(0, Math.round(deltaTx / seconds)),
  };
}

function collectLocalMetrics() {
  const nowTs = Date.now();
  const cpuPercent = sampleCpuPercent(nowTs);
  const network = sampleNetworkBps(nowTs);
  const memory = readMemoryStats();
  const disk = readDiskStats();

  return {
    cpuPercent,
    cpuTempC: null,
    ...memory,
    ...disk,
    ...network,
    ts: nowTs,
    source: "local",
  };
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
    return collectLocalMetrics();
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
    return {
      ...normalizeMetrics(payload),
      source: "our-os",
    };
  } catch (error) {
    return {
      ...collectLocalMetrics(),
      source: "local-fallback",
      warning: error?.message || "metrics_remote_unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  collectLocalMetrics,
  fetchOurOsMetrics,
  normalizeMetrics,
};
