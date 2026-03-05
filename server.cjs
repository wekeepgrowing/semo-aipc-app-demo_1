const http = require("http");
const net = require("net");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const pty = require("node-pty");
const WebSocket = require("ws");
const mime = require("mime-types");
const { fetchOurOsMetrics } = require("./lib/metrics-adapter.cjs");
const { listProviderCatalog, findMethod } = require("./lib/onboarding/provider-catalog.cjs");
const {
  normalizeResetScope,
  buildResetCommand,
  buildNonInteractiveOnboardCommand,
  buildInteractiveAuthCommand,
  buildFinalizeOnboardCommand,
} = require("./lib/onboarding/command-builder.cjs");
const { OnboardingSessionManager } = require("./lib/onboarding/session-manager.cjs");

const execAsync = promisify(exec);

const CONFIG_DIR =
  process.env.OPENCLAW_DATA_DIR || path.join(process.env.HOME || process.cwd(), ".openclaw");
const CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");
const ENV_FILE = path.join(CONFIG_DIR, ".env");

const PORT = Number(process.env.SETUP_PORT || "18789");
const OPENCLAW_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || "18790");
const OPENCLAW_NPM_VERSION = process.env.OPENCLAW_NPM_VERSION || "2026.3.2";
const SKELETON_DIR = "/home-skeleton";
const ONBOARDING_CLI_TIMEOUT_MS = Number(process.env.ONBOARDING_CLI_TIMEOUT_MS || "300000");
const ONBOARDING_SESSION_IDLE_TIMEOUT_MS = Number(process.env.ONBOARDING_SESSION_IDLE_TIMEOUT_MS || "600000");

const UI_DIST_CANDIDATES = [path.join(__dirname, "ui", "dist"), path.join(__dirname, "ui-dist")];

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "DASHSCOPE_API_KEY",
  "ZAI_API_KEY",
  "VENICE_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "OLLAMA_API_KEY",
  "OPENROUTER_API_KEY",
];

let openclawProcess = null;
let openclawStarting = false;
let terminalOnboardingPty = null;
let lastOnboardingErrorCode = null;
let resolvedOpenclawBin = null;

const authSessionManager = new OnboardingSessionManager({
  idleTimeoutMs: ONBOARDING_SESSION_IDLE_TIMEOUT_MS,
});
const interactiveAuthContexts = new Map();

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function getEnvPath(env) {
  const raw = typeof env?.PATH === "string" ? env.PATH : "";
  if (raw.trim()) return raw;
  const processPath = typeof process.env.PATH === "string" ? process.env.PATH : "";
  if (processPath.trim()) return processPath;
  return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin";
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(commandName, envPath) {
  if (!commandName) return null;
  if (commandName.includes(path.sep) && isExecutable(commandName)) return commandName;

  const nodeBinDir = path.dirname(process.execPath || "");
  if (nodeBinDir) {
    const fromNodeBin = path.join(nodeBinDir, commandName);
    if (isExecutable(fromNodeBin)) return fromNodeBin;
  }

  for (const dir of String(envPath || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, commandName);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function resolveOpenclawInvocation(args = [], env = process.env) {
  const mergedPath = getEnvPath(env);
  const configured = process.env.OPENCLAW_BIN && process.env.OPENCLAW_BIN.trim();

  if (configured) {
    if (isExecutable(configured)) return { command: configured, args: [...args] };
    console.warn(`OPENCLAW_BIN is set but not executable: ${configured}`);
  }

  if (resolvedOpenclawBin && isExecutable(resolvedOpenclawBin)) {
    return { command: resolvedOpenclawBin, args: [...args] };
  }

  const openclawBin = findExecutable("openclaw", mergedPath);
  if (openclawBin) {
    resolvedOpenclawBin = openclawBin;
    return { command: openclawBin, args: [...args] };
  }

  const npxBin = findExecutable("npx", mergedPath);
  if (npxBin) {
    return {
      command: npxBin,
      args: ["-y", `openclaw@${OPENCLAW_NPM_VERSION}`, ...args],
    };
  }

  return { command: "openclaw", args: [...args] };
}

function readEnv() {
  const env = {};
  try {
    if (!fs.existsSync(ENV_FILE)) return env;
    const content = fs.readFileSync(ENV_FILE, "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) env[match[1]] = match[2];
    }
    return env;
  } catch (error) {
    console.error("Failed to read env file:", error.message);
    return env;
  }
}

function writeEnv(env) {
  const lines = ["# OpenClaw Configuration", "# Generated by UI orchestrator", ""];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== null && value !== "") lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const workspaceDir = path.join(CONFIG_DIR, "workspace");
  if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch (error) {
    console.error("Config appears corrupted, trying .bak restore:", error.message);
    const backupFile = `${CONFIG_FILE}.bak`;
    try {
      if (fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, CONFIG_FILE);
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      }
    } catch (backupError) {
      console.error("Backup restore failed:", backupError.message);
    }
  }
  return null;
}

function isConfigured() {
  const config = readConfig();
  if (config?.wizard) return true;

  const env = readEnv();
  for (const key of PROVIDER_KEYS) {
    if (env[key] || process.env[key]) return true;
  }
  return false;
}

function reconcileConfig() {
  const config = readConfig();
  if (!config) return;

  let changed = false;

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.controlUi) config.gateway.controlUi = {};

  if (!config.gateway.controlUi.allowInsecureAuth) {
    config.gateway.controlUi.allowInsecureAuth = true;
    changed = true;
  }

  if (!config.gateway.controlUi.dangerouslyDisableDeviceAuth) {
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
    changed = true;
  }

  if (!config.update) config.update = {};
  if (config.update.checkOnStart !== false) {
    config.update.checkOnStart = false;
    changed = true;
  }

  if (changed) writeConfig(config);

  const token = config?.gateway?.auth?.token;
  if (token) {
    const env = readEnv();
    if (env.OPENCLAW_GATEWAY_TOKEN !== token) {
      env.OPENCLAW_GATEWAY_TOKEN = token;
      writeEnv(env);
    }
  }
}

function getGatewayToken() {
  const env = readEnv();
  if (env.OPENCLAW_GATEWAY_TOKEN) return env.OPENCLAW_GATEWAY_TOKEN;
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  const config = readConfig();
  return config?.gateway?.auth?.token || null;
}

async function runDoctor() {
  try {
    const env = onboardingCliEnv();
    const invocation = resolveOpenclawInvocation(["doctor", "--repair", "--yes", "--non-interactive"], env);
    const result = await runCliCommand({
      command: invocation.command,
      args: invocation.args,
      cwd: CONFIG_DIR,
      env,
      timeoutMs: ONBOARDING_CLI_TIMEOUT_MS,
    });
    if (result.ok) {
      console.log("openclaw doctor completed");
    } else {
      console.error("openclaw doctor failed:", tailStderr(result.stderr || result.stdout) || "unknown error");
    }
  } catch (error) {
    console.error("openclaw doctor failed:", error.message);
  }
}

function startOpenclaw() {
  if (openclawProcess || openclawStarting) return;

  openclawStarting = true;
  reconcileConfig();

  runDoctor().finally(() => {
    openclawStarting = false;

    const env = onboardingCliEnv();
    const invocation = resolveOpenclawInvocation(["gateway", "--port", OPENCLAW_PORT.toString()], env);
    openclawProcess = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      env,
    });

    openclawProcess.on("exit", (code) => {
      console.log(`OpenClaw gateway exited with code ${code}`);
      openclawProcess = null;
    });
  });
}

async function initializeHome() {
  const homeDir = process.env.HOME || "/data";
  try {
    const entries = await fsp.readdir(SKELETON_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(SKELETON_DIR, entry.name);
      const destPath = path.join(homeDir, entry.name);

      let exists = true;
      try {
        await fsp.access(destPath);
      } catch {
        exists = false;
      }

      if (!exists) {
        if (entry.isDirectory()) {
          await execAsync(`cp -r "${srcPath}" "${destPath}"`);
        } else {
          await fsp.copyFile(srcPath, destPath);
        }
      }
    }
  } catch (error) {
    console.error("Failed to initialize home skeleton:", error.message);
  }
}

function resolveUiDistDir() {
  for (const candidate of UI_DIST_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function safeResolve(baseDir, requestedPath) {
  const normalized = path.normalize(requestedPath).replace(/^([.][.][/\\])+/, "");
  const resolved = path.resolve(baseDir, normalized);
  if (!resolved.startsWith(path.resolve(baseDir))) return null;
  return resolved;
}

async function serveFile(res, filePath) {
  try {
    const content = await fsp.readFile(filePath);
    const contentType = mime.lookup(filePath) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=300",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: "not found" });
  }
}

async function serveUi(req, res, pathname) {
  const distDir = resolveUiDistDir();
  if (!distDir) {
    return sendJson(res, 500, {
      ok: false,
      error: "ui dist not found",
      hint: "Run npm --prefix ui run build to generate static files",
    });
  }

  if (pathname === "/" || pathname === "/app" || pathname.startsWith("/app/")) {
    return serveFile(res, path.join(distDir, "index.html"));
  }

  const candidate = safeResolve(distDir, pathname.slice(1));
  if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return serveFile(res, candidate);
  }

  return sendJson(res, 404, { ok: false, error: "legacy gui path blocked" });
}

function parseRequestUrl(req) {
  const host = req.headers.host || "127.0.0.1";
  return new URL(req.url || "/", `http://${host}`);
}

function proxyHttpToOpenclaw(req, res, rewrittenPath) {
  const token = getGatewayToken();
  const gatewayHost = `127.0.0.1:${OPENCLAW_PORT}`;
  const headers = { ...req.headers };

  headers.host = gatewayHost;
  headers.origin = `http://${gatewayHost}`;
  if (token) headers.Authorization = `Bearer ${token}`;

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: OPENCLAW_PORT,
      path: rewrittenPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    const status = openclawStarting ? 503 : 502;
    sendJson(res, status, {
      ok: false,
      error: "openclaw gateway unavailable",
      detail: error.message,
    });
  });

  req.pipe(proxyReq);
}

function proxyWsToOpenclaw(req, socket, head, rewrittenPath) {
  const token = getGatewayToken();
  const gatewayHost = `127.0.0.1:${OPENCLAW_PORT}`;

  const upstream = net.connect(OPENCLAW_PORT, "127.0.0.1", () => {
    const headers = { ...req.headers };
    headers.host = gatewayHost;
    headers.origin = `http://${gatewayHost}`;
    if (token) headers.authorization = `Bearer ${token}`;

    let request = `${req.method} ${rewrittenPath} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const v of value) request += `${key}: ${v}\r\n`;
      } else if (value !== undefined) {
        request += `${key}: ${value}\r\n`;
      }
    }
    request += "\r\n";

    upstream.write(request);
    if (head && head.length) upstream.write(head);

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const closeBoth = () => {
    try {
      socket.end();
    } catch {}
    try {
      upstream.end();
    } catch {}
  };

  upstream.on("error", closeBoth);
  socket.on("error", closeBoth);
  socket.on("close", () => upstream.end());
  upstream.on("close", () => socket.end());
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("payload too large");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("invalid json");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function maskSecrets(value, secrets) {
  if (typeof value !== "string") return value;
  let next = value;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 3) continue;
    next = next.split(secret).join("***");
  }
  return next;
}

function tailStderr(stderr, maxLines = 20) {
  if (!stderr) return "";
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-maxLines)
    .join("\n");
}

function runCliCommand({ command, args, cwd, env, timeoutMs, maskValues = [] }) {
  return new Promise((resolve) => {
    const envWithPath = {
      ...env,
      PATH: getEnvPath(env),
    };
    const invocation =
      command === "openclaw"
        ? resolveOpenclawInvocation(args, envWithPath)
        : { command, args: Array.isArray(args) ? args : [] };

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: envWithPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const append = (target, chunk) => {
      const incoming = chunk.toString("utf8");
      const combined = target + incoming;
      if (combined.length > 1024 * 1024) {
        return combined.slice(combined.length - 1024 * 1024);
      }
      return combined;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1500);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        signal: null,
        timedOut: false,
        stdout: maskSecrets(stdout, maskValues),
        stderr: maskSecrets(`${stderr}\n${error.message}`, maskValues),
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        stdout: maskSecrets(stdout, maskValues),
        stderr: maskSecrets(stderr, maskValues),
      });
    });
  });
}

function getOnboardingStatePayload() {
  return {
    ok: true,
    configured: isConfigured(),
    onboardingInProgress: Boolean(terminalOnboardingPty || authSessionManager.hasActiveSession()),
    interactiveAuthInProgress: authSessionManager.hasActiveSession(),
    mode: terminalOnboardingPty ? "terminal" : "gui",
    lastErrorCode: lastOnboardingErrorCode,
    gatewayRunning: Boolean(openclawProcess),
    ts: Date.now(),
  };
}

function onboardingCliEnv() {
  const merged = {
    ...process.env,
    ...readEnv(),
  };
  merged.PATH = getEnvPath(merged);
  return merged;
}

function closeTerminalOnboarding(reason = "replaced") {
  if (!terminalOnboardingPty) return;
  try {
    terminalOnboardingPty.kill();
  } catch {
    // ignore kill errors
  }
  terminalOnboardingPty = null;
  if (reason === "cancel") {
    lastOnboardingErrorCode = "interactive_cancelled";
  }
}

function getInteractiveContext(sessionId) {
  return interactiveAuthContexts.get(sessionId) || null;
}

function sendWsMessage(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function broadcastContext(context, message) {
  if (!context) return;
  if (message.type === "phase") context.lastPhase = message.phase || context.lastPhase;
  if (message.type === "error" || message.type === "exit") context.lastEvent = message;

  for (const client of context.clients) {
    sendWsMessage(client, message);
  }
}

function finalizeContextLater(sessionId, delayMs = 60_000) {
  setTimeout(() => {
    const context = getInteractiveContext(sessionId);
    if (!context) return;
    if (context.clients.size === 0) {
      interactiveAuthContexts.delete(sessionId);
    }
  }, delayMs);
}

function summarizeCliFailure(result, maskValues) {
  if (result.timedOut) {
    return {
      code: "timeout",
      message: "command timed out",
    };
  }

  const raw = tailStderr(result.stderr || result.stdout || "");
  const masked = maskSecrets(raw, maskValues);
  return {
    code: "cli_failed",
    message: masked || "openclaw command failed",
  };
}

function validateRequiredFields(method, credentials) {
  const missing = [];
  for (const field of method.requiredFields || []) {
    const value = credentials?.[field];
    if (typeof value !== "string" || !value.trim()) missing.push(field);
  }
  return missing;
}

async function applyResetIfNeeded(resetScope, maskValues) {
  const command = buildResetCommand(resetScope);
  if (!command) return { ok: true };

  const result = await runCliCommand({
    command: command.command,
    args: command.args,
    cwd: CONFIG_DIR,
    env: onboardingCliEnv(),
    timeoutMs: ONBOARDING_CLI_TIMEOUT_MS,
    maskValues,
  });

  if (result.ok) return { ok: true };
  const failure = summarizeCliFailure(result, maskValues);
  return {
    ok: false,
    code: failure.code,
    error: failure.message,
  };
}

async function handleOnboardingApply(req, res) {
  ensureConfigDir();

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    if (error.code === "PAYLOAD_TOO_LARGE") {
      return sendJson(res, 413, { ok: false, code: "invalid_input", error: "payload too large" });
    }
    return sendJson(res, 422, { ok: false, code: "invalid_input", error: "invalid json body" });
  }

  const providerId = typeof payload.providerId === "string" ? payload.providerId.trim() : "";
  const methodId = typeof payload.methodId === "string" ? payload.methodId.trim() : "";
  const credentials = payload.credentials && typeof payload.credentials === "object" ? payload.credentials : {};
  const resetScope = normalizeResetScope(payload?.options?.resetScope ?? "none");

  if (!providerId || !methodId) {
    return sendJson(res, 422, {
      ok: false,
      code: "invalid_input",
      error: "providerId and methodId are required",
    });
  }

  if (!resetScope) {
    return sendJson(res, 422, {
      ok: false,
      code: "invalid_input",
      error: "options.resetScope must be one of none|config|config+creds+sessions|full",
    });
  }

  const found = findMethod(providerId, methodId);
  if (!found) {
    return sendJson(res, 422, {
      ok: false,
      code: "invalid_input",
      error: "unknown provider/method",
    });
  }

  const { method } = found;
  const missing = validateRequiredFields(method, credentials);
  if (missing.length > 0) {
    return sendJson(res, 422, {
      ok: false,
      code: "invalid_input",
      error: `missing required fields: ${missing.join(", ")}`,
    });
  }

  const maskValues = Object.values(credentials)
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  closeTerminalOnboarding("replaced");

  const reset = await applyResetIfNeeded(resetScope, maskValues);
  if (!reset.ok) {
    lastOnboardingErrorCode = reset.code;
    return sendJson(res, reset.code === "timeout" ? 504 : 502, {
      ok: false,
      code: reset.code,
      error: reset.error,
    });
  }

  if (method.mode === "non_interactive") {
    const command = buildNonInteractiveOnboardCommand({
      openclawPort: OPENCLAW_PORT,
      method,
      credentials,
    });

    const result = await runCliCommand({
      command: command.command,
      args: command.args,
      cwd: CONFIG_DIR,
      env: onboardingCliEnv(),
      timeoutMs: ONBOARDING_CLI_TIMEOUT_MS,
      maskValues: [...maskValues, ...(command.maskValues || [])],
    });

    if (!result.ok) {
      const failure = summarizeCliFailure(result, [...maskValues, ...(command.maskValues || [])]);
      lastOnboardingErrorCode = failure.code;
      return sendJson(res, failure.code === "timeout" ? 504 : 502, {
        ok: false,
        code: failure.code,
        error: failure.message,
      });
    }

    lastOnboardingErrorCode = null;
    if (isConfigured()) startOpenclaw();
    return sendJson(res, 200, {
      ok: true,
      status: "configured",
      configured: true,
    });
  }

  if (method.mode === "interactive_required") {
    const interactiveCommand = buildInteractiveAuthCommand({ method });
    const invocation = resolveOpenclawInvocation(interactiveCommand.args, onboardingCliEnv());

    let session;
    try {
      session = authSessionManager.startSession({
        command: invocation.command,
        args: invocation.args,
        cwd: CONFIG_DIR,
        env: onboardingCliEnv(),
        cols: 96,
        rows: 30,
      });
    } catch (error) {
      lastOnboardingErrorCode = "cli_failed";
      const baseMessage =
        error?.code === "SPAWN_FAILED"
          ? "openclaw CLI executable not found. Install openclaw or set OPENCLAW_BIN."
          : error.message || "failed to start interactive session";
      return sendJson(res, 502, {
        ok: false,
        code: "cli_failed",
        error: maskSecrets(baseMessage, maskValues),
      });
    }

    const context = {
      sessionId: session.sessionId,
      providerId,
      methodId,
      method,
      clients: new Set(),
      lastPhase: "interactive_auth_started",
      lastEvent: null,
      createdAt: Date.now(),
      completed: false,
    };

    interactiveAuthContexts.set(session.sessionId, context);
    session.events.on("output", (data) => {
      broadcastContext(context, { type: "output", data });
    });

    broadcastContext(context, { type: "phase", phase: "interactive_auth_started" });

    session.exitPromise
      .then(async ({ exitCode, reason }) => {
        const cancelled = reason === "interactive_cancelled" || reason === "interactive_replaced";
        const timeout = reason === "timeout";

        if (cancelled) {
          lastOnboardingErrorCode = "interactive_cancelled";
          broadcastContext(context, {
            type: "error",
            code: "interactive_cancelled",
            message: "interactive auth session cancelled",
          });
          broadcastContext(context, { type: "exit", code: 1, configured: false });
          context.completed = true;
          finalizeContextLater(context.sessionId);
          return;
        }

        if (timeout) {
          lastOnboardingErrorCode = "timeout";
          broadcastContext(context, {
            type: "error",
            code: "timeout",
            message: "interactive auth session timed out",
          });
          broadcastContext(context, { type: "exit", code: 1, configured: false });
          context.completed = true;
          finalizeContextLater(context.sessionId);
          return;
        }

        if (exitCode !== 0) {
          lastOnboardingErrorCode = "cli_failed";
          broadcastContext(context, {
            type: "error",
            code: "cli_failed",
            message: "interactive auth command failed",
          });
          broadcastContext(context, { type: "exit", code: exitCode ?? 1, configured: false });
          context.completed = true;
          finalizeContextLater(context.sessionId);
          return;
        }

        broadcastContext(context, { type: "phase", phase: "interactive_auth_completed" });
        broadcastContext(context, { type: "phase", phase: "finalize_onboarding" });

        const finalizeCommand = buildFinalizeOnboardCommand({
          openclawPort: OPENCLAW_PORT,
          method,
        });

        const finalizeResult = await runCliCommand({
          command: finalizeCommand.command,
          args: finalizeCommand.args,
          cwd: CONFIG_DIR,
          env: onboardingCliEnv(),
          timeoutMs: ONBOARDING_CLI_TIMEOUT_MS,
          maskValues,
        });

        if (!finalizeResult.ok) {
          const failure = summarizeCliFailure(finalizeResult, maskValues);
          lastOnboardingErrorCode = failure.code;
          broadcastContext(context, {
            type: "error",
            code: failure.code,
            message: failure.message,
          });
          broadcastContext(context, { type: "exit", code: 1, configured: false });
          context.completed = true;
          finalizeContextLater(context.sessionId);
          return;
        }

        lastOnboardingErrorCode = null;
        if (isConfigured()) startOpenclaw();
        broadcastContext(context, { type: "phase", phase: "configured" });
        broadcastContext(context, { type: "exit", code: 0, configured: true });
        context.completed = true;
        finalizeContextLater(context.sessionId);
      })
      .catch((error) => {
        lastOnboardingErrorCode = "cli_failed";
        broadcastContext(context, {
          type: "error",
          code: "cli_failed",
          message: maskSecrets(error.message || "interactive flow failed", maskValues),
        });
        broadcastContext(context, { type: "exit", code: 1, configured: false });
        context.completed = true;
        finalizeContextLater(context.sessionId);
      });

    lastOnboardingErrorCode = null;
    return sendJson(res, 200, {
      ok: true,
      status: "interactive_required",
      sessionId: session.sessionId,
    });
  }

  return sendJson(res, 500, {
    ok: false,
    code: "cli_failed",
    error: "unsupported onboarding method mode",
  });
}

const onboardingWss = new WebSocket.Server({ noServer: true });
const onboardingAuthWss = new WebSocket.Server({ noServer: true });

onboardingWss.on("connection", (ws) => {
  if (isConfigured()) {
    sendWsMessage(ws, { type: "error", message: "already configured" });
    ws.close();
    return;
  }

  authSessionManager.shutdownAll("interactive_replaced");

  if (terminalOnboardingPty) {
    try {
      terminalOnboardingPty.kill();
    } catch {}
    terminalOnboardingPty = null;
  }

  ensureConfigDir();

  try {
    const terminalArgs = [
      "onboard",
      "--flow",
      "quickstart",
      "--accept-risk",
      "--skip-channels",
      "--skip-skills",
      "--skip-daemon",
      "--skip-ui",
      "--skip-health",
      "--mode",
      "local",
      "--gateway-port",
      OPENCLAW_PORT.toString(),
    ];
    const invocation = resolveOpenclawInvocation(terminalArgs, onboardingCliEnv());
    terminalOnboardingPty = pty.spawn(
      invocation.command,
      invocation.args,
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: CONFIG_DIR,
        env: {
          ...onboardingCliEnv(),
          TERM: "xterm-256color",
        },
      }
    );
  } catch (error) {
    lastOnboardingErrorCode = "cli_failed";
    sendWsMessage(ws, {
      type: "error",
      code: "cli_failed",
      message: error.message || "failed to start onboarding terminal",
    });
    ws.close();
    return;
  }

  terminalOnboardingPty.onData((data) => {
    sendWsMessage(ws, { type: "output", data });
  });

  terminalOnboardingPty.onExit(({ exitCode }) => {
    sendWsMessage(ws, { type: "exit", code: exitCode, configured: exitCode === 0 });
    terminalOnboardingPty = null;

    if (exitCode === 0) {
      lastOnboardingErrorCode = null;
      if (isConfigured()) startOpenclaw();
    } else {
      lastOnboardingErrorCode = "cli_failed";
    }
  });

  ws.on("message", (raw) => {
    if (!terminalOnboardingPty) return;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input") terminalOnboardingPty.write(String(msg.data || ""));
      if (msg.type === "resize") terminalOnboardingPty.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
      if (msg.type === "cancel") closeTerminalOnboarding("cancel");
    } catch {
      // Ignore malformed payloads.
    }
  });

  ws.on("close", () => {
    if (terminalOnboardingPty) {
      try {
        terminalOnboardingPty.kill();
      } catch {}
      terminalOnboardingPty = null;
    }
  });
});

onboardingAuthWss.on("connection", (ws, req, sessionId) => {
  const context = getInteractiveContext(sessionId);
  if (!context) {
    sendWsMessage(ws, {
      type: "error",
      code: "invalid_input",
      message: "interactive session not found",
    });
    ws.close();
    return;
  }

  context.clients.add(ws);

  if (context.lastPhase) {
    sendWsMessage(ws, { type: "phase", phase: context.lastPhase });
  }
  if (context.lastEvent) {
    sendWsMessage(ws, context.lastEvent);
  }

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input") {
        authSessionManager.sendInput(sessionId, String(msg.data || ""));
      } else if (msg.type === "resize") {
        authSessionManager.resizeSession(sessionId, Number(msg.cols) || 96, Number(msg.rows) || 30);
      } else if (msg.type === "cancel") {
        authSessionManager.cancelSession(sessionId, "interactive_cancelled");
      }
    } catch {
      // Ignore malformed payloads.
    }
  });

  ws.on("close", () => {
    context.clients.delete(ws);
    if (context.completed && context.clients.size === 0) {
      interactiveAuthContexts.delete(sessionId);
    }
  });
});

const server = http.createServer(async (req, res) => {
  const url = parseRequestUrl(req);
  const { pathname, search } = url;

  if (pathname === "/api/ui/health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      service: "openclaw-ui-gateway",
      configured: isConfigured(),
      gatewayRunning: Boolean(openclawProcess),
      onboardingInProgress: Boolean(terminalOnboardingPty || authSessionManager.hasActiveSession()),
      interactiveAuthInProgress: authSessionManager.hasActiveSession(),
      lastErrorCode: lastOnboardingErrorCode,
      ts: Date.now(),
    });
  }

  if (pathname === "/api/ui/onboarding/state" && req.method === "GET") {
    return sendJson(res, 200, getOnboardingStatePayload());
  }

  if (pathname === "/api/ui/onboarding/options" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      flow: "quickstart-fixed",
      providers: listProviderCatalog(),
    });
  }

  if (pathname === "/api/ui/onboarding/apply" && req.method === "POST") {
    return handleOnboardingApply(req, res);
  }

  if (pathname === "/api/ui/onboarding/cancel" && req.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, { ok: false, code: "invalid_input", error: "invalid json body" });
    }

    const sessionId =
      typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : authSessionManager.getActiveSessionId();

    if (!sessionId) {
      return sendJson(res, 404, {
        ok: false,
        code: "invalid_input",
        error: "interactive session not found",
      });
    }

    const cancelled = authSessionManager.cancelSession(sessionId, "interactive_cancelled");
    if (!cancelled) {
      return sendJson(res, 404, {
        ok: false,
        code: "invalid_input",
        error: "interactive session not found",
      });
    }

    lastOnboardingErrorCode = "interactive_cancelled";
    return sendJson(res, 200, {
      ok: true,
      status: "cancelled",
      sessionId,
    });
  }

  if (pathname === "/api/ui/system/metrics" && req.method === "GET") {
    try {
      const metrics = await fetchOurOsMetrics();
      return sendJson(res, 200, { ok: true, ...metrics });
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        code: "metrics_unavailable",
        error: error.message || "failed to fetch metrics",
        ts: Date.now(),
      });
    }
  }

  if (pathname === "/api/oc" || pathname.startsWith("/api/oc/")) {
    if (!isConfigured()) {
      return sendJson(res, 409, { ok: false, error: "openclaw is not configured yet" });
    }

    if (!openclawProcess) startOpenclaw();

    const rewrittenPath = `${pathname.replace(/^\/api\/oc/, "") || "/"}${search}`;
    return proxyHttpToOpenclaw(req, res, rewrittenPath);
  }

  return serveUi(req, res, pathname);
});

server.on("upgrade", (req, socket, head) => {
  const url = parseRequestUrl(req);
  const { pathname, search } = url;

  if (pathname === "/api/ui/onboarding/terminal") {
    onboardingWss.handleUpgrade(req, socket, head, (ws) => {
      onboardingWss.emit("connection", ws, req);
    });
    return;
  }

  const authMatch = pathname.match(/^\/api\/ui\/onboarding\/auth\/([A-Za-z0-9-]+)$/);
  if (authMatch) {
    const sessionId = authMatch[1];
    onboardingAuthWss.handleUpgrade(req, socket, head, (ws) => {
      onboardingAuthWss.emit("connection", ws, req, sessionId);
    });
    return;
  }

  if (pathname === "/ws/oc" || pathname.startsWith("/ws/oc/")) {
    if (!isConfigured()) {
      socket.end("HTTP/1.1 409 Conflict\r\n\r\n");
      return;
    }
    if (!openclawProcess) startOpenclaw();

    const rewrittenPath = `${pathname.replace(/^\/ws\/oc/, "") || "/"}${search}`;
    proxyWsToOpenclaw(req, socket, head, rewrittenPath);
    return;
  }

  socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
});

initializeHome();
ensureConfigDir();

if (isConfigured()) {
  console.log("OpenClaw already configured, starting gateway");
  startOpenclaw();
} else {
  console.log("OpenClaw is not configured, waiting for onboarding GUI flow");
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`UI gateway listening on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down");
  try {
    if (terminalOnboardingPty) terminalOnboardingPty.kill();
  } catch {}
  try {
    authSessionManager.shutdownAll("shutdown");
  } catch {}
  try {
    if (openclawProcess) openclawProcess.kill("SIGTERM");
  } catch {}
  server.close();
});
