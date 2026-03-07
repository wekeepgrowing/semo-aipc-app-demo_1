const http = require("http");
const net = require("net");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync, exec } = require("child_process");
const { promisify } = require("util");
const { pathToFileURL } = require("url");
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
const { CapabilityRegistry } = require("./lib/runtime/capabilities.cjs");
const { RuntimeStore } = require("./lib/runtime/runtime-store.cjs");
const { UsageLedger } = require("./lib/runtime/usage-ledger.cjs");
const { OpenclawAdapter } = require("./lib/runtime/openclaw-adapter.cjs");
const { RuntimeWsBroker } = require("./lib/runtime/ws-broker.cjs");
const { GatewayRpcClient } = require("./lib/runtime/gateway-rpc-client.cjs");
const { UsecaseDemoRuntime } = require("./lib/runtime/usecase-demo-runtime.cjs");
const { PlanningConversationRuntime } = require("./lib/runtime/planning-conversation-runtime.cjs");
const { GeneralConversationRuntime } = require("./lib/runtime/general-conversation-runtime.cjs");
const { FeatureToggleManager, FEATURE_IDS } = require("./lib/runtime/feature-toggle-manager.cjs");
const { ExecutionFeatureCompat } = require("./lib/runtime/execution-feature-compat.cjs");
const { FixStateStore } = require("./lib/runtime/fix-state-store.cjs");
const { getDefaultSkillDefinitions, getDefaultSkillIds } = require("./lib/runtime/default-skills.cjs");
const { RUN_SESSION_MODE_PER_RUN, createPerRunSessionKey } = require("./lib/runtime/session-utils.cjs");
const {
  FEATURE_UI_ROWS,
  normalizeExecutionFeatures,
  normalizeExecutionFeaturesError,
  normalizeExecutionFeaturesStatus,
  normalizeFeatureStatus,
} = require("./lib/runtime/feature-contract.cjs");

const execAsync = promisify(exec);

function resolveOpenclawPaths(env = process.env) {
  const homeValue = typeof env.OPENCLAW_HOME === "string" ? env.OPENCLAW_HOME.trim() : "";
  const dataValue = typeof env.OPENCLAW_DATA_DIR === "string" ? env.OPENCLAW_DATA_DIR.trim() : "";
  const fallbackHome = path.resolve(env.HOME || process.cwd());

  if (homeValue) {
    const resolvedHome = path.resolve(homeValue);
    if (path.basename(resolvedHome) === ".openclaw") {
      return {
        homeDir: path.dirname(resolvedHome),
        configDir: resolvedHome,
      };
    }
    return {
      homeDir: resolvedHome,
      configDir: path.join(resolvedHome, ".openclaw"),
    };
  }

  if (dataValue) {
    const resolvedData = path.resolve(dataValue);
    if (path.basename(resolvedData) === ".openclaw") {
      return {
        homeDir: path.dirname(resolvedData),
        configDir: resolvedData,
      };
    }
    return {
      homeDir: resolvedData,
      configDir: path.join(resolvedData, ".openclaw"),
    };
  }

  return {
    homeDir: fallbackHome,
    configDir: path.join(fallbackHome, ".openclaw"),
  };
}

const { homeDir: OPENCLAW_HOME_DIR, configDir: CONFIG_DIR } = resolveOpenclawPaths();
const CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const AUTH_PROFILES_FILE = path.join(CONFIG_DIR, "agents", "main", "agent", "auth-profiles.json");

const PORT = Number(process.env.SETUP_PORT || "18789");
const OPENCLAW_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || "18790");
const OPENCLAW_NPM_VERSION = process.env.OPENCLAW_NPM_VERSION || "2026.3.2";
const SKELETON_DIR = "/home-skeleton";
const RUNTIME_TMP_DIR = process.env.TMPDIR || path.join(OPENCLAW_HOME_DIR, ".tmp");
const LINUXBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const LINUXBREW_BIN = path.join(LINUXBREW_PREFIX, "bin", "brew");
const LINUXBREW_INSTALL_TIMEOUT_MS = Number(process.env.LINUXBREW_INSTALL_TIMEOUT_MS || "600000");
const ONBOARDING_CLI_TIMEOUT_MS = Number(process.env.ONBOARDING_CLI_TIMEOUT_MS || "300000");
const ONBOARDING_SESSION_IDLE_TIMEOUT_MS = Number(process.env.ONBOARDING_SESSION_IDLE_TIMEOUT_MS || "600000");
const DEFAULT_TOOLS_PROFILE = process.env.OPENCLAW_TOOLS_PROFILE || "full";
const RUNTIME_POLL_INTERVAL_MS = Number(process.env.RUNTIME_POLL_INTERVAL_MS || "2000");
const RUNTIME_CHAT_SESSION_KEY = process.env.RUNTIME_CHAT_SESSION_KEY || "agent:main:main";
const FIX_ADVANCED_BYPASS_TTL_MS = Number(process.env.FIX_ADVANCED_BYPASS_TTL_MS || String(30 * 60 * 1000));
const FIX_DOCTOR_REPAIR_TIMEOUT_MS = Number(process.env.FIX_DOCTOR_REPAIR_TIMEOUT_MS || "45000");

const UI_DIST_CANDIDATES = [path.join(__dirname, "ui", "dist"), path.join(__dirname, "ui-dist")];

process.env.TMPDIR = RUNTIME_TMP_DIR;
process.env.TMP = RUNTIME_TMP_DIR;
process.env.TEMP = RUNTIME_TMP_DIR;

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

const RUNTIME_STATE_DIR = path.join(CONFIG_DIR, "runtime");
const RUNTIME_USAGE_DIR = path.join(RUNTIME_STATE_DIR, "usage");
const RUNTIME_ATTACHMENT_DIR = path.join(RUNTIME_STATE_DIR, "attachments");
const RUNTIME_WORKSPACE_DIR = path.join(CONFIG_DIR, "workspace");
const SEMO_ASSISTANT_NAME = process.env.SEMO_ASSISTANT_NAME || "Semo AI";
const SEMO_BRANDING_BLOCK_START = "<!-- semo-branding:start -->";
const SEMO_BRANDING_BLOCK_END = "<!-- semo-branding:end -->";
const DEFAULT_SKILL_WORKSPACE_DIR = path.join(RUNTIME_WORKSPACE_DIR, "skills");
const DEFAULT_SKILL_ASSET_DIR = path.join(__dirname, "assets", "default-skills");
const DEFAULT_SKILL_STATE_FILE = path.join(RUNTIME_STATE_DIR, "default-skills-state.json");
const DEFAULT_SKILL_NPM_PREFIX =
  process.env.OPENCLAW_SKILLS_NPM_PREFIX || path.join(process.env.HOME || process.cwd(), ".npm-global");
const DEFAULT_SKILL_PROVISION_TIMEOUT_MS = Number(process.env.DEFAULT_SKILL_PROVISION_TIMEOUT_MS || "600000");
const CONVERSATION_ATTACHMENT_LIMIT = Number(process.env.CONVERSATION_ATTACHMENT_LIMIT || "4");
const CONVERSATION_ATTACHMENT_MAX_BYTES = Number(process.env.CONVERSATION_ATTACHMENT_MAX_BYTES || String(10 * 1024 * 1024));
const FIX_STATE_FILE = path.join(RUNTIME_STATE_DIR, "fix-state.json");
const GOG_RUNTIME_DIR = path.join(RUNTIME_STATE_DIR, "gog");
const GOG_CREDENTIALS_FILE = path.join(GOG_RUNTIME_DIR, "credentials.json");
const GOG_CONNECT_TIMEOUT_MS = Number(process.env.GOG_CONNECT_TIMEOUT_MS || "300000");
const GOG_OAUTH_SERVICES = process.env.GOG_OAUTH_SERVICES || "gmail,calendar,drive,contacts,sheets,docs";
const DEFAULT_SKILL_DEFINITIONS = getDefaultSkillDefinitions();
const DEFAULT_SKILL_ID_SET = new Set(getDefaultSkillIds());
const DEFAULT_SKILL_ENV_KEYS = new Set(
  DEFAULT_SKILL_DEFINITIONS.flatMap((skill) => {
    const fields = Array.isArray(skill?.skillEnvironment?.fields) ? skill.skillEnvironment.fields : [];
    if (fields.length > 0) return fields.map((field) => String(field?.key || "")).filter(Boolean);
    return Array.isArray(skill.requiredEnv) ? skill.requiredEnv : [];
  })
);
const runtimeCapabilities = new CapabilityRegistry();
const runtimeStore = new RuntimeStore({ dir: RUNTIME_STATE_DIR });
const runtimeUsageLedger = new UsageLedger({ dir: RUNTIME_USAGE_DIR });
const fixStateStore = new FixStateStore({ filePath: FIX_STATE_FILE });
const runtimeWsBroker = new RuntimeWsBroker();
let runtimePollTimer = null;
const runtimeRunSummaryFingerprints = new Map();
const runtimeRunDetailState = new Map();
const runtimeUsageFingerprints = new Set();
const runtimeGatewayRunAlias = new Map();
const localRunSimulationTimers = new Map();
let runtimeAdapter = null;
let usecaseDemoRuntime = null;
let planningConversationRuntime = null;
let generalConversationRuntime = null;
let gatewayRpcClient = null;
let featureToggleManager = null;
let executionFeatureCompat = null;
let fixRecovering = false;
let fixBypassAutoOffTimer = null;
let lastGatewayConnectedAt = null;
let defaultSkillProvisionPromise = null;
let defaultSkillProvisionCompleted = false;

const authSessionManager = new OnboardingSessionManager({
  idleTimeoutMs: ONBOARDING_SESSION_IDLE_TIMEOUT_MS,
});
const interactiveAuthContexts = new Map();
const OAUTH_STATUS_AUTH_URL_TIMEOUT_MS = Number(process.env.ONBOARDING_AUTH_URL_TIMEOUT_MS || "45000");
let authProfileHealthCache = {
  ts: 0,
  broken: false,
};
let openaiCodexDirectModulesPromise = null;

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

function safeRealpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function resolveOpenclawPackageRoot(env = process.env) {
  const candidates = new Set();
  const configuredRoot = typeof env.OPENCLAW_PACKAGE_ROOT === "string" ? env.OPENCLAW_PACKAGE_ROOT.trim() : "";
  if (configuredRoot) candidates.add(path.resolve(configuredRoot));

  const invocation = resolveOpenclawInvocation([], env);
  const resolvedCommand = safeRealpath(invocation.command) || invocation.command;
  if (resolvedCommand && path.basename(resolvedCommand) === "openclaw.mjs") {
    candidates.add(path.dirname(resolvedCommand));
  }
  if (resolvedCommand && path.basename(resolvedCommand) === "openclaw") {
    candidates.add(path.resolve(path.dirname(resolvedCommand), "..", "lib", "node_modules", "openclaw"));
  }

  const npmRootResult = spawnSync("npm", ["root", "-g"], {
    cwd: CONFIG_DIR,
    env: { ...env, PATH: getEnvPath(env) },
    encoding: "utf8",
    timeout: 4000,
  });
  if (npmRootResult.status === 0) {
    const npmRoot = String(npmRootResult.stdout || "").trim();
    if (npmRoot) candidates.add(path.join(npmRoot, "openclaw"));
  }

  candidates.add("/usr/local/lib/node_modules/openclaw");
  candidates.add(path.join(DEFAULT_SKILL_NPM_PREFIX, "lib", "node_modules", "openclaw"));
  candidates.add(path.join(OPENCLAW_HOME_DIR, ".npm-global", "lib", "node_modules", "openclaw"));
  candidates.add(path.join(CONFIG_DIR, "node_modules", "openclaw"));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const marker = path.join(candidate, "openclaw.mjs");
    if (fs.existsSync(marker)) return candidate;
  }
  return null;
}

function resolveOpenclawDistModule(rootDir, prefix) {
  if (!rootDir) return null;
  const distDir = path.join(rootDir, "dist");
  if (!fs.existsSync(distDir)) return null;
  try {
    const match = fs
      .readdirSync(distDir)
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js"))
      .sort()[0];
    return match ? path.join(distDir, match) : null;
  } catch {
    return null;
  }
}

async function loadOpenAICodexDirectModules() {
  if (openaiCodexDirectModulesPromise) return openaiCodexDirectModulesPromise;

  openaiCodexDirectModulesPromise = (async () => {
    const packageRoot = resolveOpenclawPackageRoot(onboardingCliEnv());
    if (!packageRoot) {
      throw new Error("OpenClaw package root could not be resolved for direct OpenAI OAuth");
    }

    const oauthModulePath = path.join(
      packageRoot,
      "node_modules",
      "@mariozechner",
      "pi-ai",
      "dist",
      "utils",
      "oauth",
      "openai-codex.js"
    );
    const authTokenModulePath = resolveOpenclawDistModule(packageRoot, "auth-token-");

    if (!fs.existsSync(oauthModulePath)) {
      throw new Error(`OpenAI OAuth helper not found: ${oauthModulePath}`);
    }
    if (!authTokenModulePath) {
      throw new Error("OpenClaw auth-token module not found for direct OpenAI OAuth");
    }

    const oauthModule = await import(pathToFileURL(oauthModulePath).href);
    const authTokenModule = await import(pathToFileURL(authTokenModulePath).href);
    if (typeof oauthModule.loginOpenAICodex !== "function") {
      throw new Error("loginOpenAICodex export is unavailable");
    }
    if (typeof authTokenModule.Ct !== "function" || typeof authTokenModule.d !== "function") {
      throw new Error("OpenClaw auth profile helpers are unavailable");
    }

    return {
      loginOpenAICodex: oauthModule.loginOpenAICodex,
      writeOAuthCredentials: authTokenModule.Ct,
      applyAuthProfileConfig: authTokenModule.d,
    };
  })().catch((error) => {
    openaiCodexDirectModulesPromise = null;
    throw error;
  });

  return openaiCodexDirectModulesPromise;
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

function normalizeTextFile(content) {
  return String(content || "").replace(/\r\n?/g, "\n");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertManagedMarkdownBlock(existingContent, managedBlock) {
  const existing = normalizeTextFile(existingContent).trim();
  const block = normalizeTextFile(managedBlock).trim();
  if (!existing) return `${block}\n`;

  const managedPattern = new RegExp(
    `${escapeRegExp(SEMO_BRANDING_BLOCK_START)}[\\s\\S]*?${escapeRegExp(SEMO_BRANDING_BLOCK_END)}\\s*`,
    "m"
  );

  if (managedPattern.test(existing)) {
    return `${existing.replace(managedPattern, `${block}\n\n`).trim()}\n`;
  }

  return `${block}\n\n${existing}\n`;
}

function buildSemoWorkspaceBrandingTemplates() {
  return {
    "AGENTS.md": [
      SEMO_BRANDING_BLOCK_START,
      "# Semo Identity Guardrails",
      "",
      `- Public-facing identity: ${SEMO_ASSISTANT_NAME}.`,
      "- Never introduce yourself as OpenClaw, OpenClaw-based, OpenClaw-powered, or an OpenClaw assistant.",
      `- If the user asks who you are, answer with "${SEMO_ASSISTANT_NAME}" only.`,
      "- If the user asks whether you are OpenClaw, do not confirm or discuss OpenClaw as your identity.",
      "- Do not volunteer internal runtime, gateway, package, repository, or daemon names in identity answers.",
      `- Keep one consistent external identity in conversation: ${SEMO_ASSISTANT_NAME}.`,
      SEMO_BRANDING_BLOCK_END,
    ].join("\n"),
    "SOUL.md": [
      SEMO_BRANDING_BLOCK_START,
      "# Semo Persona",
      "",
      `- Name: ${SEMO_ASSISTANT_NAME}`,
      "- Tone: calm, direct, practical.",
      "- Keep identity answers short and consistent.",
      `- Preferred identity answer: "저는 ${SEMO_ASSISTANT_NAME}예요"`,
      "- Do not explain old names or internal brands during normal identity questions.",
      SEMO_BRANDING_BLOCK_END,
    ].join("\n"),
    "IDENTITY.md": [
      SEMO_BRANDING_BLOCK_START,
      "# Identity",
      "",
      `- Name: ${SEMO_ASSISTANT_NAME}`,
      "- Theme: pragmatic AI work assistant",
      `- Public identity answer: "저는 ${SEMO_ASSISTANT_NAME}예요"`,
      "- Forbidden self-description: OpenClaw, OpenClaw-based assistant, OpenClaw-powered assistant, OpenClaw 위에서 동작하는 assistant",
      SEMO_BRANDING_BLOCK_END,
    ].join("\n"),
  };
}

function ensureSemoWorkspaceBranding() {
  fs.mkdirSync(RUNTIME_WORKSPACE_DIR, { recursive: true });

  const templates = buildSemoWorkspaceBrandingTemplates();
  for (const [fileName, managedBlock] of Object.entries(templates)) {
    const targetPath = path.join(RUNTIME_WORKSPACE_DIR, fileName);
    const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
    const next = upsertManagedMarkdownBlock(current, managedBlock);
    if (current !== next) {
      fs.writeFileSync(targetPath, next, { mode: 0o600 });
    }
  }

  const bootstrapPath = path.join(RUNTIME_WORKSPACE_DIR, "BOOTSTRAP.md");
  if (fs.existsSync(bootstrapPath)) {
    fs.rmSync(bootstrapPath, { force: true });
  }
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(RUNTIME_WORKSPACE_DIR)) fs.mkdirSync(RUNTIME_WORKSPACE_DIR, { recursive: true });
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

  if (config.wizard && typeof config.wizard === "object") {
    const invalidWizardKeys = ["providerId", "provider", "methodId", "method"];
    for (const key of invalidWizardKeys) {
      if (Object.prototype.hasOwnProperty.call(config.wizard, key)) {
        delete config.wizard[key];
        changed = true;
      }
    }
  }

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.controlUi) config.gateway.controlUi = {};

  if (!config.update) config.update = {};
  if (config.update.checkOnStart !== false) {
    config.update.checkOnStart = false;
    changed = true;
  }

  if (!config.tools) config.tools = {};
  if (config.tools.profile !== DEFAULT_TOOLS_PROFILE) {
    config.tools.profile = DEFAULT_TOOLS_PROFILE;
    changed = true;
  }

  if (!config.agents || typeof config.agents !== "object") {
    config.agents = {};
    changed = true;
  }
  if (!config.agents.defaults || typeof config.agents.defaults !== "object") {
    config.agents.defaults = {};
    changed = true;
  }
  if (config.agents.defaults.workspace !== RUNTIME_WORKSPACE_DIR) {
    config.agents.defaults.workspace = RUNTIME_WORKSPACE_DIR;
    changed = true;
  }
  if (config.agents.defaults.skipBootstrap !== true) {
    config.agents.defaults.skipBootstrap = true;
    changed = true;
  }
  if (!Array.isArray(config.agents.list)) {
    config.agents.list = [];
    changed = true;
  }

  let mainAgent = config.agents.list.find((entry) => entry && entry.id === "main");
  if (!mainAgent) {
    mainAgent = { id: "main" };
    config.agents.list.unshift(mainAgent);
    changed = true;
  }
  if (!mainAgent.identity || typeof mainAgent.identity !== "object") {
    mainAgent.identity = {};
    changed = true;
  }
  if (mainAgent.identity.name !== SEMO_ASSISTANT_NAME) {
    mainAgent.identity.name = SEMO_ASSISTANT_NAME;
    changed = true;
  }
  if (!mainAgent.identity.theme || /openclaw/i.test(String(mainAgent.identity.theme))) {
    mainAgent.identity.theme = "pragmatic AI work assistant";
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

  ensureSemoWorkspaceBranding();
}

function createDefaultSkillState() {
  return {
    version: 1,
    updatedAt: null,
    skills: {},
  };
}

function normalizeDefaultSkillDependencyState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const lastAttemptAt = Number(source.lastAttemptAt);
  return {
    state: source.state === "ready" ? "ready" : source.state === "install_failed" ? "install_failed" : "pending",
    version: source.version ? String(source.version) : null,
    label: source.label ? String(source.label) : null,
    error: source.error ? String(source.error) : null,
    lastAttemptAt: Number.isFinite(lastAttemptAt) ? lastAttemptAt : null,
  };
}

function normalizeDefaultSkillEntryState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const provisionedAt = Number(source.provisionedAt);
  const lastAttemptAt = Number(source.lastAttemptAt);
  const dependencies = source.dependencies && typeof source.dependencies === "object" ? source.dependencies : {};
  const nextDependencies = {};
  for (const [key, value] of Object.entries(dependencies)) {
    nextDependencies[String(key)] = normalizeDefaultSkillDependencyState(value);
  }
  return {
    pinnedVersion: source.pinnedVersion ? String(source.pinnedVersion) : null,
    archiveFile: source.archiveFile ? String(source.archiveFile) : null,
    archiveSha256: source.archiveSha256 ? String(source.archiveSha256) : null,
    installState:
      source.installState === "ready" ? "ready" : source.installState === "install_failed" ? "install_failed" : "pending",
    installError: source.installError ? String(source.installError) : null,
    provisionedAt: Number.isFinite(provisionedAt) ? provisionedAt : null,
    lastAttemptAt: Number.isFinite(lastAttemptAt) ? lastAttemptAt : null,
    dependencies: nextDependencies,
  };
}

function normalizeDefaultSkillState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const updatedAt = Number(source.updatedAt);
  const skills = source.skills && typeof source.skills === "object" ? source.skills : {};
  const next = createDefaultSkillState();
  next.updatedAt = Number.isFinite(updatedAt) ? updatedAt : null;
  for (const skill of DEFAULT_SKILL_DEFINITIONS) {
    next.skills[skill.id] = normalizeDefaultSkillEntryState(skills[skill.id]);
  }
  for (const [skillId, value] of Object.entries(skills)) {
    if (next.skills[skillId]) continue;
    next.skills[skillId] = normalizeDefaultSkillEntryState(value);
  }
  return next;
}

function readDefaultSkillState() {
  try {
    if (!fs.existsSync(DEFAULT_SKILL_STATE_FILE)) return createDefaultSkillState();
    const raw = JSON.parse(fs.readFileSync(DEFAULT_SKILL_STATE_FILE, "utf8"));
    return normalizeDefaultSkillState(raw);
  } catch (error) {
    console.error("default skill state load failed:", error.message);
    return createDefaultSkillState();
  }
}

function writeDefaultSkillState(state) {
  try {
    fs.mkdirSync(RUNTIME_STATE_DIR, { recursive: true });
    const tmp = `${DEFAULT_SKILL_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeDefaultSkillState(state), null, 2));
    fs.renameSync(tmp, DEFAULT_SKILL_STATE_FILE);
  } catch (error) {
    console.error("default skill state save failed:", error.message);
  }
}

function shouldProvisionDefaultSkills(state) {
  const normalized = normalizeDefaultSkillState(state);
  return DEFAULT_SKILL_DEFINITIONS.some((skill) => {
    const entry = normalized.skills[skill.id];
    if (!entry) return true;
    if (entry.installState !== "ready") return true;
    if (entry.pinnedVersion !== skill.pinnedVersion) return true;
    if (entry.archiveFile !== skill.archiveFile) return true;
    if (entry.archiveSha256 !== skill.sha256) return true;
    return false;
  });
}

function buildDefaultSkillProvisionEnv() {
  const env = onboardingCliEnv();
  const npmPrefix = env.NPM_CONFIG_PREFIX || DEFAULT_SKILL_NPM_PREFIX;
  fs.mkdirSync(npmPrefix, { recursive: true });
  env.NPM_CONFIG_PREFIX = npmPrefix;
  env.PATH = [path.join(npmPrefix, "bin"), getEnvPath(env)].filter(Boolean).join(path.delimiter);
  return env;
}

function getSkillEnvironmentConfig(skill) {
  const explicit = skill?.skillEnvironment && typeof skill.skillEnvironment === "object" ? skill.skillEnvironment : null;
  if (explicit) {
    return {
      mode: explicit.mode === "all" ? "all" : "any",
      fields: Array.isArray(explicit.fields) ? explicit.fields.filter((field) => field?.key).map((field) => ({ ...field })) : [],
    };
  }
  const keys = Array.isArray(skill?.requiredEnv) ? skill.requiredEnv.filter(Boolean) : [];
  return {
    mode: keys.length > 1 ? "any" : "all",
    fields: keys.map((key) => ({
      key,
      label: key,
      inputType: "password",
      placeholder: `${key} 값을 입력하세요`,
      required: true,
    })),
  };
}

function getSkillEnvironmentFieldKeys(skill) {
  return getSkillEnvironmentConfig(skill).fields.map((field) => String(field.key));
}

function buildGogCredentialsDocument(envValues) {
  const clientId = String(envValues?.GOG_CLIENT_ID || "").trim();
  const clientSecret = String(envValues?.GOG_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;
  return {
    installed: {
      client_id: clientId,
      client_secret: clientSecret,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      redirect_uris: ["http://localhost"],
    },
  };
}

function runSyncCliCommand({ command, args, cwd, env, timeoutMs }) {
  const envWithPath = {
    ...env,
    PATH: getEnvPath(env),
  };
  const invocation =
    command === "openclaw"
      ? resolveOpenclawInvocation(args, envWithPath)
      : { command, args: Array.isArray(args) ? args : [] };

  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: envWithPath,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    ok: result.status === 0 && !result.error && !result.signal,
    code: typeof result.status === "number" ? result.status : null,
    signal: result.signal || null,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: `${typeof result.stderr === "string" ? result.stderr : ""}${result.error ? `\n${result.error.message}` : ""}`.trim(),
  };
}

function safeParseJson(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseGogAccountRows(payload) {
  if (Array.isArray(payload?.accounts)) {
    return payload.accounts
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object") {
          return String(entry.email || entry.account || entry.name || "").trim();
        }
        return "";
      })
      .filter(Boolean);
  }
  return [];
}

function getGogAuthSnapshot(envValues = {}) {
  const mergedEnv = {
    ...onboardingCliEnv(),
    ...envValues,
  };
  mergedEnv.PATH = getEnvPath(mergedEnv);
  const snapshot = {
    credentialsReady: false,
    accountEmail: String(mergedEnv.GOG_ACCOUNT || "").trim(),
    accountConnected: false,
    connectedAccounts: [],
    statusError: null,
  };

  if (!findExecutable("gog", mergedEnv.PATH)) return snapshot;

  const statusResult = runSyncCliCommand({
    command: "gog",
    args: ["auth", "status", "--json", "--no-input"],
    cwd: CONFIG_DIR,
    env: mergedEnv,
    timeoutMs: 10000,
  });
  const statusPayload = safeParseJson(statusResult.stdout);
  const credentialsExists = Boolean(statusPayload?.account?.credentials_exists);
  const activeEmail = String(statusPayload?.account?.email || "").trim();
  snapshot.credentialsReady = credentialsExists;
  if (!snapshot.accountEmail && activeEmail) snapshot.accountEmail = activeEmail;

  const listResult = runSyncCliCommand({
    command: "gog",
    args: ["auth", "list", "--json", "--no-input"],
    cwd: CONFIG_DIR,
    env: mergedEnv,
    timeoutMs: 10000,
  });
  const listPayload = safeParseJson(listResult.stdout);
  snapshot.connectedAccounts = parseGogAccountRows(listPayload);
  if (snapshot.accountEmail) {
    snapshot.accountConnected = snapshot.connectedAccounts.some(
      (entry) => entry.toLowerCase() === snapshot.accountEmail.toLowerCase()
    );
  } else {
    snapshot.accountConnected = snapshot.connectedAccounts.length > 0;
  }

  if ((!statusResult.ok || !listResult.ok) && !snapshot.accountConnected && !snapshot.credentialsReady) {
    snapshot.statusError = tailStderr(statusResult.stderr || listResult.stderr || "") || null;
  }

  return snapshot;
}

async function syncGogCredentialsFromEnv(envValues) {
  const credentials = buildGogCredentialsDocument(envValues);
  if (!credentials) {
    return {
      ok: true,
      applied: false,
      message: "Google OAuth Client ID와 Secret을 모두 입력하면 gog 자격증명을 저장해요",
    };
  }

  fs.mkdirSync(GOG_RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(GOG_CREDENTIALS_FILE, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });

  const mergedEnv = {
    ...buildDefaultSkillProvisionEnv(),
    ...envValues,
  };
  mergedEnv.PATH = getEnvPath(mergedEnv);

  const result = await runCliCommand({
    command: "gog",
    args: ["auth", "credentials", "set", GOG_CREDENTIALS_FILE, "--json", "--no-input"],
    cwd: CONFIG_DIR,
    env: mergedEnv,
    timeoutMs: 30000,
    maskValues: [String(envValues?.GOG_CLIENT_ID || ""), String(envValues?.GOG_CLIENT_SECRET || "")].filter(Boolean),
  });

  if (!result.ok) {
    return {
      ok: false,
      applied: false,
      message: tailStderr(result.stderr || result.stdout || "") || "gog OAuth 자격증명 저장에 실패했어요",
    };
  }

  return {
    ok: true,
    applied: true,
    message: "gog OAuth 자격증명을 저장했고 이제 계정 연결만 마치면 돼요",
  };
}

function extractAuthUrl(text) {
  const match = String(text || "").match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"]+/);
  return match ? match[0] : "";
}

async function startGogAccountConnection() {
  const envValues = {
    ...process.env,
    ...readEnv(),
  };
  const accountEmail = String(envValues.GOG_ACCOUNT || "").trim();
  if (!accountEmail) {
    return {
      ok: false,
      code: "invalid_input",
      error: "GOG_ACCOUNT를 먼저 입력해 주세요",
    };
  }

  const credentialSync = await syncGogCredentialsFromEnv(envValues);
  if (!credentialSync.ok) {
    return {
      ok: false,
      code: "credential_setup_failed",
      error: credentialSync.message,
    };
  }

  const mergedEnv = {
    ...buildDefaultSkillProvisionEnv(),
    ...envValues,
  };
  mergedEnv.PATH = getEnvPath(mergedEnv);

  const result = await runCliCommand({
    command: "gog",
    args: ["auth", "add", accountEmail, "--services", GOG_OAUTH_SERVICES, "--remote", "--step", "1", "--json", "--no-input"],
    cwd: CONFIG_DIR,
    env: mergedEnv,
    timeoutMs: GOG_CONNECT_TIMEOUT_MS,
  });

  if (!result.ok) {
    return {
      ok: false,
      code: "gog_oauth_start_failed",
      error: tailStderr(result.stderr || result.stdout || "") || "gog 계정 연결 시작에 실패했어요",
    };
  }

  const payload = safeParseJson(result.stdout);
  const authUrl = String(payload?.auth_url || extractAuthUrl(result.stdout || "")).trim();
  if (!authUrl) {
    return {
      ok: false,
      code: "gog_oauth_start_failed",
      error: "gog 인증 URL을 생성하지 못했어요",
    };
  }

  return {
    ok: true,
    accountEmail,
    authUrl,
    skillEnvironment: {
      items: buildSkillEnvironmentItems(),
    },
  };
}

async function completeGogAccountConnection(redirectUrlRaw) {
  const redirectUrl = String(redirectUrlRaw || "").trim();
  if (!redirectUrl) {
    return {
      ok: false,
      code: "invalid_input",
      error: "redirectUrl이 필요해요",
    };
  }

  const envValues = {
    ...process.env,
    ...readEnv(),
  };
  const accountEmail = String(envValues.GOG_ACCOUNT || "").trim();
  if (!accountEmail) {
    return {
      ok: false,
      code: "invalid_input",
      error: "GOG_ACCOUNT를 먼저 입력해 주세요",
    };
  }

  const credentialSync = await syncGogCredentialsFromEnv(envValues);
  if (!credentialSync.ok) {
    return {
      ok: false,
      code: "credential_setup_failed",
      error: credentialSync.message,
    };
  }

  const mergedEnv = {
    ...buildDefaultSkillProvisionEnv(),
    ...envValues,
  };
  mergedEnv.PATH = getEnvPath(mergedEnv);

  const result = await runCliCommand({
    command: "gog",
    args: [
      "auth",
      "add",
      accountEmail,
      "--services",
      GOG_OAUTH_SERVICES,
      "--remote",
      "--step",
      "2",
      "--auth-url",
      redirectUrl,
      "--json",
      "--no-input",
    ],
    cwd: CONFIG_DIR,
    env: mergedEnv,
    timeoutMs: GOG_CONNECT_TIMEOUT_MS,
  });

  if (!result.ok) {
    return {
      ok: false,
      code: "gog_oauth_complete_failed",
      error: tailStderr(result.stderr || result.stdout || "") || "gog 계정 연결 완료 처리에 실패했어요",
    };
  }

  return {
    ok: true,
    accountEmail,
    skillEnvironment: {
      items: buildSkillEnvironmentItems(),
    },
  };
}

function findDefaultSkillById(skillId) {
  return DEFAULT_SKILL_DEFINITIONS.find((skill) => skill.id === String(skillId || "")) || null;
}

function getDefaultSkillArchivePath(skill) {
  return path.join(DEFAULT_SKILL_ASSET_DIR, skill.archiveFile);
}

function createSkillStateEntry(skill) {
  return {
    pinnedVersion: skill.pinnedVersion,
    archiveFile: skill.archiveFile,
    archiveSha256: skill.sha256,
    installState: "pending",
    installError: null,
    provisionedAt: null,
    lastAttemptAt: null,
    dependencies: {},
  };
}

function ensureSkillStateEntry(state, skill) {
  const current = normalizeDefaultSkillEntryState(state.skills[skill.id]);
  state.skills[skill.id] = {
    ...createSkillStateEntry(skill),
    ...current,
    pinnedVersion: skill.pinnedVersion,
    archiveFile: skill.archiveFile,
    archiveSha256: current.archiveSha256 || skill.sha256,
  };
  return state.skills[skill.id];
}

function hashFileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function syncDefaultSkillsIntoRuntimeStore() {
  const currentRows = runtimeStore.listSkills();
  const byId = new Map(currentRows.map((row) => [String(row.id), row]));
  const next = DEFAULT_SKILL_DEFINITIONS.map((skill) => {
    const existing = byId.get(skill.id);
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: existing?.enabled === true ? true : existing?.enabled === false ? false : Boolean(skill.defaultEnabled),
    };
  });
  for (const row of currentRows) {
    if (!row || !row.id || DEFAULT_SKILL_ID_SET.has(String(row.id))) continue;
    next.push({ ...row });
  }
  runtimeStore.setSkills(next);
  return next;
}

function ensureSkillConfigEntries(config) {
  const next = config && typeof config === "object" ? config : {};
  if (!next.skills || typeof next.skills !== "object") next.skills = {};
  if (!next.skills.entries || typeof next.skills.entries !== "object") next.skills.entries = {};
  return next.skills.entries;
}

function applyDefaultSkillConfigDefaults() {
  const existing = readConfig();
  const config = existing && typeof existing === "object" ? existing : {};
  const entries = ensureSkillConfigEntries(config);
  let changed = false;
  for (const skill of DEFAULT_SKILL_DEFINITIONS) {
    const current = entries[skill.id];
    if (current && typeof current === "object" && typeof current.enabled === "boolean") continue;
    entries[skill.id] = {
      ...(current && typeof current === "object" ? current : {}),
      enabled: Boolean(skill.defaultEnabled),
    };
    changed = true;
  }
  if (changed) writeConfig(config);
  return changed;
}

function persistSkillEnabledInConfig(skillId, enabled) {
  const existing = readConfig();
  const config = existing && typeof existing === "object" ? existing : {};
  const entries = ensureSkillConfigEntries(config);
  const current = entries[skillId];
  entries[skillId] = {
    ...(current && typeof current === "object" ? current : {}),
    enabled: Boolean(enabled),
  };
  writeConfig(config);
}

async function extractDefaultSkillArchive(archivePath, destinationDir, env) {
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  return runCliCommand({
    command: "python3",
    args: ["-m", "zipfile", "-e", archivePath, destinationDir],
    cwd: CONFIG_DIR,
    env,
    timeoutMs: DEFAULT_SKILL_PROVISION_TIMEOUT_MS,
  });
}

function binsMissing(bins = [], envPath = "") {
  const out = [];
  for (const bin of bins) {
    if (!findExecutable(bin, envPath)) out.push(bin);
  }
  return out;
}

async function ensureDefaultSkillProvisioned(skill, state, env) {
  const entry = ensureSkillStateEntry(state, skill);
  entry.lastAttemptAt = Date.now();

  const archivePath = getDefaultSkillArchivePath(skill);
  if (!fs.existsSync(archivePath)) {
    entry.installState = "install_failed";
    entry.installError = `vendored archive is missing: ${skill.archiveFile}`;
    return entry;
  }

  let archiveSha256 = "";
  try {
    archiveSha256 = hashFileSha256(archivePath);
  } catch (error) {
    entry.installState = "install_failed";
    entry.installError = error.message || "failed to hash vendored archive";
    return entry;
  }

  if (archiveSha256 !== skill.sha256) {
    entry.installState = "install_failed";
    entry.installError = `archive sha256 mismatch for ${skill.archiveFile}`;
    return entry;
  }

  const skillDir = path.join(DEFAULT_SKILL_WORKSPACE_DIR, skill.slug);
  const skillFile = path.join(skillDir, "SKILL.md");
  const needsExtract =
    !fs.existsSync(skillFile) ||
    entry.pinnedVersion !== skill.pinnedVersion ||
    entry.archiveSha256 !== archiveSha256 ||
    entry.archiveFile !== skill.archiveFile;

  if (needsExtract) {
    const extracted = await extractDefaultSkillArchive(archivePath, skillDir, env);
    if (!extracted.ok || !fs.existsSync(skillFile)) {
      entry.installState = "install_failed";
      entry.installError = tailStderr(extracted.stderr || extracted.stdout || "") || `failed to extract ${skill.archiveFile}`;
      return entry;
    }
    entry.provisionedAt = Date.now();
  }

  entry.pinnedVersion = skill.pinnedVersion;
  entry.archiveFile = skill.archiveFile;
  entry.archiveSha256 = archiveSha256;
  entry.installState = "ready";
  entry.installError = null;

  for (const command of skill.installCommands || []) {
    const dependency = normalizeDefaultSkillDependencyState(entry.dependencies[command.id]);
    const verifyBins = Array.isArray(command.verifyBins) ? command.verifyBins : [];
    const readyByBins = verifyBins.length > 0 && binsMissing(verifyBins, env.PATH).length === 0;
    const readyByState = Boolean(command.oncePerVersion && dependency.state === "ready" && dependency.version === skill.pinnedVersion);
    if (readyByBins || readyByState) {
      entry.dependencies[command.id] = {
        ...dependency,
        state: "ready",
        version: skill.pinnedVersion,
        label: command.label || null,
        error: null,
      };
      continue;
    }

    const installed = await runCliCommand({
      command: command.command,
      args: command.args,
      cwd: CONFIG_DIR,
      env,
      timeoutMs: Number(command.timeoutMs) || DEFAULT_SKILL_PROVISION_TIMEOUT_MS,
    });
    const postMissing = binsMissing(verifyBins, env.PATH);
    const ok = installed.ok && (verifyBins.length === 0 || postMissing.length === 0);
    entry.dependencies[command.id] = {
      state: ok ? "ready" : "install_failed",
      version: skill.pinnedVersion,
      label: command.label || null,
      error: ok
        ? null
        : tailStderr(installed.stderr || installed.stdout || "") || `dependency install failed: ${command.command} ${command.args.join(" ")}`,
      lastAttemptAt: Date.now(),
    };
    if (!ok) {
      entry.installState = "install_failed";
      entry.installError = entry.dependencies[command.id].error;
      return entry;
    }
  }

  const missingRequiredBins = binsMissing(skill.requiredBins, env.PATH);
  if (missingRequiredBins.length > 0) {
    entry.installState = "install_failed";
    entry.installError = `missing required bins: ${missingRequiredBins.join(", ")}`;
    return entry;
  }

  entry.installState = "ready";
  entry.installError = null;
  return entry;
}

async function ensureDefaultSkillsProvisioned() {
  if (defaultSkillProvisionPromise) return defaultSkillProvisionPromise;
  if (defaultSkillProvisionCompleted) {
    const state = readDefaultSkillState();
    if (!shouldProvisionDefaultSkills(state)) return state;
    defaultSkillProvisionCompleted = false;
  }

  defaultSkillProvisionPromise = (async () => {
    ensureConfigDir();
    fs.mkdirSync(DEFAULT_SKILL_WORKSPACE_DIR, { recursive: true });
    const env = buildDefaultSkillProvisionEnv();
    const state = readDefaultSkillState();
    syncDefaultSkillsIntoRuntimeStore();
    applyDefaultSkillConfigDefaults();

    for (const skill of DEFAULT_SKILL_DEFINITIONS) {
      try {
        await ensureDefaultSkillProvisioned(skill, state, env);
      } catch (error) {
        const entry = ensureSkillStateEntry(state, skill);
        entry.installState = "install_failed";
        entry.installError = error.message || "unknown provisioning error";
        entry.lastAttemptAt = Date.now();
      }
    }

    state.updatedAt = Date.now();
    writeDefaultSkillState(state);
    syncDefaultSkillsIntoRuntimeStore();
    defaultSkillProvisionCompleted = true;
    return state;
  })()
    .catch((error) => {
      console.error("default skill provisioning failed:", error.message);
      const state = readDefaultSkillState();
      state.updatedAt = Date.now();
      writeDefaultSkillState(state);
      defaultSkillProvisionCompleted = true;
      return state;
    })
    .finally(() => {
      defaultSkillProvisionPromise = null;
    });

  return defaultSkillProvisionPromise;
}

function resolveDefaultSkillSetup(skill, stateEntry, envValues, envPath) {
  const dependencies = stateEntry?.dependencies && typeof stateEntry.dependencies === "object" ? stateEntry.dependencies : {};
  const dependencyFailure = Object.values(dependencies).find((row) => row?.state === "install_failed");
  if (stateEntry?.installState === "install_failed" || dependencyFailure) {
    return {
      setupState: "install_failed",
      setupHint: stateEntry?.installError || dependencyFailure?.error || skill.setupHint || null,
    };
  }

  const missingBins = binsMissing(skill.requiredBins, envPath);
  if (missingBins.length > 0) {
    return {
      setupState: "install_failed",
      setupHint: `필수 실행 파일이 없어요: ${missingBins.join(", ")}`,
    };
  }

  const environmentConfig = getSkillEnvironmentConfig(skill);
  const requiredFields = environmentConfig.fields.filter((field) => field?.required !== false);
  const envReady =
    requiredFields.length === 0
      ? true
      : environmentConfig.mode === "all"
        ? requiredFields.every((field) => hasEnvValue(envValues[field.key]))
        : requiredFields.some((field) => hasEnvValue(envValues[field.key]));

  if (skill.id === "gog") {
    const gogSnapshot = getGogAuthSnapshot(envValues);
    if (!envReady && !gogSnapshot.credentialsReady) {
      return {
        setupState: "needs_env",
        setupHint: "Google OAuth Client ID, Secret, 연결할 계정 이메일을 먼저 저장해 주세요",
      };
    }
    if (gogSnapshot.accountConnected) {
      return {
        setupState: "ready",
        setupHint:
          gogSnapshot.accountEmail && gogSnapshot.connectedAccounts.length > 0
            ? `${gogSnapshot.accountEmail} 계정 연결이 확인됐어요`
            : skill.setupHint || null,
      };
    }
    return {
      setupState: "needs_oauth",
      setupHint:
        gogSnapshot.credentialsReady || envReady
          ? "OAuth 자격증명은 준비됐으니 계정 연결을 시작해 마무리해 주세요"
          : skill.setupHint || null,
    };
  }

  if (skill.requiresOAuth) {
    return {
      setupState: "needs_oauth",
      setupHint: skill.setupHint || null,
    };
  }

  if (requiredFields.length > 0 && !envReady) {
    return {
      setupState: "needs_env",
      setupHint: skill.setupHint || null,
    };
  }

  if (skill.requiredEnv.length > 0) {
    const hasAnyEnv = skill.requiredEnv.some((key) => hasEnvValue(envValues[key]));
    if (!hasAnyEnv) {
      return {
        setupState: "needs_env",
        setupHint: skill.setupHint || null,
      };
    }
  }

  return {
    setupState: "ready",
    setupHint: skill.setupHint || null,
  };
}

function buildEnrichedSkillItems(rawItems = []) {
  const envValues = {
    ...process.env,
    ...readEnv(),
  };
  const envPath = getEnvPath(envValues);
  const state = readDefaultSkillState();
  const itemMap = new Map();
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    if (!item || !item.id) continue;
    itemMap.set(String(item.id), item);
  }
  for (const item of runtimeStore.listSkills()) {
    if (!item || !item.id || itemMap.has(String(item.id))) continue;
    itemMap.set(String(item.id), item);
  }

  const defaultItems = DEFAULT_SKILL_DEFINITIONS.map((skill) => {
    const current = itemMap.get(skill.id) || null;
    const setup = resolveDefaultSkillSetup(skill, state.skills[skill.id], envValues, envPath);
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: current?.enabled === true ? true : current?.enabled === false ? false : Boolean(skill.defaultEnabled),
      source: "default",
      defaultInstalled: true,
      setupState: setup.setupState,
      setupHint: setup.setupHint,
    };
  });

  const userItems = [];
  for (const [id, item] of itemMap.entries()) {
    if (DEFAULT_SKILL_ID_SET.has(id)) continue;
    userItems.push({
      id,
      name: item?.name ? String(item.name) : id,
      description: item?.description ? String(item.description) : "",
      enabled: Boolean(item?.enabled),
      source: "user",
      defaultInstalled: false,
      setupState: "ready",
      setupHint: null,
    });
  }
  userItems.sort((left, right) => left.name.localeCompare(right.name, "ko"));

  return [...defaultItems, ...userItems];
}

function hasEnvValue(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function buildSkillEnvironmentItems() {
  const fileEnv = readEnv();
  const mergedEnv = {
    ...process.env,
    ...fileEnv,
  };
  return DEFAULT_SKILL_DEFINITIONS.filter((skill) => getSkillEnvironmentFieldKeys(skill).length > 0).map((skill) => {
    const config = getSkillEnvironmentConfig(skill);
    const fields = config.fields.map((field) => {
      const key = String(field.key || "");
      const fileValue = fileEnv[key];
      const processValue = process.env[key];
      const presentInFile = hasEnvValue(fileValue);
      const presentInProcess = hasEnvValue(processValue);
      return {
        key,
        label: field.label ? String(field.label) : key,
        inputType: field.inputType ? String(field.inputType) : "password",
        placeholder: field.placeholder ? String(field.placeholder) : `${key} 값을 입력하세요`,
        required: field.required !== false,
        present: presentInFile || presentInProcess,
        source: presentInFile ? "file" : presentInProcess ? "process" : "none",
      };
    });
    const requiredFields = fields.filter((field) => field.required);
    const satisfied =
      requiredFields.length === 0
        ? true
        : config.mode === "all"
          ? requiredFields.every((field) => field.present)
          : requiredFields.some((field) => field.present);
    const oauth =
      skill.id === "gog"
        ? (() => {
            const snapshot = getGogAuthSnapshot(mergedEnv);
            return {
              supported: true,
              credentialsReady: snapshot.credentialsReady || satisfied,
              accountEmail: snapshot.accountEmail || String(mergedEnv.GOG_ACCOUNT || "").trim(),
              accountConnected: snapshot.accountConnected,
              connectedAccounts: snapshot.connectedAccounts,
            };
          })()
        : null;
    return {
      skillId: skill.id,
      skillName: skill.name,
      description: skill.description,
      setupHint: skill.setupHint || null,
      mode: config.mode,
      satisfied,
      fields,
      oauth,
    };
  });
}

async function applySkillEnvironmentUpdates(updatesRaw) {
  const currentEnv = readEnv();
  const updates = updatesRaw && typeof updatesRaw === "object" ? updatesRaw : {};
  const changedKeys = [];
  const invalidKeys = [];

  for (const [rawKey, rawValue] of Object.entries(updates)) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    if (!DEFAULT_SKILL_ENV_KEYS.has(key)) {
      invalidKeys.push(key);
      continue;
    }
    const value = String(rawValue ?? "").trim();
    if (!value) continue;
    if (currentEnv[key] === value && process.env[key] === value) continue;
    currentEnv[key] = value;
    process.env[key] = value;
    changedKeys.push(key);
  }

  if (invalidKeys.length > 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: `unsupported env keys: ${invalidKeys.join(", ")}`,
    };
  }

  if (changedKeys.length > 0) {
    writeEnv(currentEnv);
  }

  const sideEffects = [];
  if (changedKeys.some((key) => key === "GOG_CLIENT_ID" || key === "GOG_CLIENT_SECRET" || key === "GOG_ACCOUNT")) {
    const gogSync = await syncGogCredentialsFromEnv({
      ...process.env,
      ...currentEnv,
    });
    sideEffects.push({
      id: "gog_credentials",
      ok: Boolean(gogSync.ok),
      applied: Boolean(gogSync.applied),
      message: gogSync.message || "",
    });
  }

  return {
    ok: true,
    changedKeys,
    sideEffects,
    items: buildSkillEnvironmentItems(),
  };
}

const FIX_DIAGNOSIS_LABELS = {
  gateway_down: "게이트웨이 중단",
  pairing_required: "페어링 승인 필요",
  origin_not_allowed: "허용되지 않은 Origin",
  gateway_token_mismatch: "게이트웨이 토큰 불일치",
  device_token_mismatch: "디바이스 토큰 불일치",
  abnormal_closure: "비정상 연결 종료",
  insecure_http_device_identity_required: "보안 컨텍스트 필요",
  unknown: "원인 미확정",
};

function parseJsonSafely(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const startCandidates = [text.indexOf("{"), text.indexOf("[")].filter((idx) => idx >= 0);
    if (startCandidates.length === 0) return null;
    const start = Math.min(...startCandidates);
    const endBrace = text.lastIndexOf("}");
    const endBracket = text.lastIndexOf("]");
    const end = Math.max(endBrace, endBracket);
    if (end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeOrigin(originInput) {
  if (!originInput) return "";
  const raw = String(originInput).trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    try {
      return new URL(`http://${raw}`).origin;
    } catch {
      return "";
    }
  }
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (host === "0.0.0.0") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function isLocalOrigin(originInput) {
  const origin = normalizeOrigin(originInput);
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function extractReasonText(input) {
  return String(input || "")
    .trim()
    .toLowerCase();
}

function reasonIncludes(reason, snippets = []) {
  const value = extractReasonText(reason);
  if (!value) return false;
  return snippets.some((snippet) => value.includes(String(snippet).toLowerCase()));
}

function diagnoseFixCategory({ closeCode, closeReason, origin = "", lastErrorCode = "", gatewayRunning = false }) {
  const reason = extractReasonText(closeReason);
  const code = Number(closeCode);
  const normalizedOrigin = normalizeOrigin(origin);
  const insecureHttpOrigin = (() => {
    if (!normalizedOrigin) return false;
    try {
      const parsed = new URL(normalizedOrigin);
      return parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  })();

  if (insecureHttpOrigin || reasonIncludes(reason, ["secure context", "webcrypto", "device identity"])) {
    return {
      category: "insecure_http_device_identity_required",
      hint: "HTTPS 또는 loopback(localhost/127.0.0.1) 접속이 필요해요",
    };
  }

  if (!gatewayRunning) {
    return {
      category: "gateway_down",
      hint: "게이트웨이 프로세스가 내려가 있어요",
    };
  }

  if (code === 1008) {
    if (reasonIncludes(reason, ["pairing required", "pairing"])) {
      return { category: "pairing_required", hint: "새 브라우저/디바이스 승인 필요" };
    }
    if (reasonIncludes(reason, ["origin not allowed", "origin"])) {
      return { category: "origin_not_allowed", hint: "현재 웹 origin이 allowlist에 없어요" };
    }
    if (reasonIncludes(reason, ["device token mismatch"])) {
      return { category: "device_token_mismatch", hint: "디바이스 토큰 재발급/재페어링이 필요해요" };
    }
    if (reasonIncludes(reason, ["gateway token mismatch"])) {
      return { category: "gateway_token_mismatch", hint: "게이트웨이 인증 토큰 정합화가 필요해요" };
    }
    if (reasonIncludes(reason, ["unauthorized", "token mismatch"])) {
      if (reasonIncludes(reason, ["device"])) {
        return { category: "device_token_mismatch", hint: "디바이스 토큰 불일치로 판단돼요" };
      }
      return { category: "gateway_token_mismatch", hint: "게이트웨이 토큰 불일치로 판단돼요" };
    }
  }

  if (code === 1006) {
    return { category: "abnormal_closure", hint: "채널 불안정/비정상 종료 감지" };
  }

  if (lastErrorCode && String(lastErrorCode).toLowerCase().includes("pair")) {
    return { category: "pairing_required", hint: "최근 오류에서 페어링 필요 신호를 확인했어요" };
  }

  return { category: "unknown", hint: "최근 신호만으로 원인을 특정하지 못했어요" };
}

function getFixStateSnapshot() {
  return fixStateStore.getState();
}

function upsertFixLastClose(code, reason) {
  fixStateStore.patch({
    lastClose: {
      code: Number.isFinite(Number(code)) ? Number(code) : null,
      reason: reason ? String(reason) : "",
      at: Date.now(),
    },
  });
}

function upsertFixLastRecover({ status, category, summaryKo }) {
  fixStateStore.patch({
    lastRecover: {
      at: Date.now(),
      status: status || "unknown",
      category: category || "unknown",
      summaryKo: summaryKo || "",
    },
  });
}

function extractHostFromOrigin(originInput) {
  const origin = normalizeOrigin(originInput);
  if (!origin) return "";
  try {
    const url = new URL(origin);
    return url.hostname || "";
  } catch {
    return "";
  }
}

function applyDangerousBypassFlagsToConfig({ disableDeviceAuth, allowHostHeaderOriginFallback }) {
  const config = readConfig();
  if (!config) {
    return {
      ok: false,
      code: "not_configured",
      error: "openclaw 설정이 없어 고급 우회를 반영할 수 없어요",
      changed: false,
    };
  }

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.controlUi) config.gateway.controlUi = {};

  let changed = false;
  const nextDisable = Boolean(disableDeviceAuth);
  const nextHostFallback = Boolean(allowHostHeaderOriginFallback);

  if (Boolean(config.gateway.controlUi.dangerouslyDisableDeviceAuth) !== nextDisable) {
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = nextDisable;
    changed = true;
  }

  if (Boolean(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback) !== nextHostFallback) {
    config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = nextHostFallback;
    changed = true;
  }

  if (changed) writeConfig(config);
  return { ok: true, changed };
}

function clearFixBypassTimer() {
  if (fixBypassAutoOffTimer) {
    clearTimeout(fixBypassAutoOffTimer);
    fixBypassAutoOffTimer = null;
  }
}

async function stopOpenclawGateway({ timeoutMs = 8_000 } = {}) {
  if (!openclawProcess) return { ok: true, alreadyStopped: true };
  const target = openclawProcess;

  return new Promise((resolve) => {
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try {
        target.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({ ok: false, timedOut: true });
    }, Math.max(1000, Number(timeoutMs) || 8_000));

    target.once("exit", () => finish({ ok: true, stopped: true }));
    try {
      target.kill("SIGTERM");
    } catch {
      finish({ ok: false, stopped: false });
    }
  });
}

function checkPortOpen(port, host = "127.0.0.1", timeoutMs = 1_200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let completed = false;
    const finalize = (value) => {
      if (completed) return;
      completed = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(Boolean(value));
    };

    socket.setTimeout(Math.max(250, Number(timeoutMs) || 1_200));
    socket.on("connect", () => finalize(true));
    socket.on("timeout", () => finalize(false));
    socket.on("error", () => finalize(false));
    try {
      socket.connect(port, host);
    } catch {
      finalize(false);
    }
  });
}

async function checkGatewayHealthSnapshot() {
  const processRunning = Boolean(openclawProcess);
  const portOpen = await checkPortOpen(OPENCLAW_PORT);
  let reachable = false;
  let httpStatus = null;

  const candidates = ["/health", "/api/health", "/", "/status"];
  for (const requestPath of candidates) {
    try {
      const response = await requestRawToOpenclaw({ method: "GET", path: requestPath, timeoutMs: 1_400 });
      httpStatus = Number(response?.status || 0) || null;
      if (httpStatus && httpStatus < 500) {
        reachable = true;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  return {
    processRunning,
    portOpen,
    reachable,
    httpStatus,
  };
}

async function waitForGatewayHealthy({ timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + Math.max(2_000, Number(timeoutMs) || 15_000);
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    lastSnapshot = await checkGatewayHealthSnapshot();
    if (lastSnapshot.processRunning && lastSnapshot.portOpen && lastSnapshot.reachable) {
      return {
        ok: true,
        snapshot: lastSnapshot,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
  }
  return {
    ok: false,
    snapshot: lastSnapshot,
  };
}

async function restartOpenclawGateway() {
  await stopOpenclawGateway({ timeoutMs: 10_000 });
  startOpenclaw();
  return waitForGatewayHealthy({ timeoutMs: 18_000 });
}

async function runFixOpenclawCommand(args, { timeoutMs = ONBOARDING_CLI_TIMEOUT_MS, maskValues = [] } = {}) {
  const env = onboardingCliEnv();
  const invocation = resolveOpenclawInvocation(args, env);
  const result = await runCliCommand({
    command: invocation.command,
    args: invocation.args,
    cwd: CONFIG_DIR,
    env,
    timeoutMs,
    maskValues,
  });
  return result;
}

function scheduleFixBypassAutoOff(expiresAt) {
  clearFixBypassTimer();
  const ts = Number(expiresAt);
  if (!Number.isFinite(ts)) return;
  const waitMs = ts - Date.now();
  if (waitMs <= 0) {
    void applyAdvancedBypass({
      disableDeviceAuth: false,
      allowHostHeaderOriginFallback: false,
      ttlMs: 0,
      reason: "expired",
    });
    return;
  }
  fixBypassAutoOffTimer = setTimeout(() => {
    void applyAdvancedBypass({
      disableDeviceAuth: false,
      allowHostHeaderOriginFallback: false,
      ttlMs: 0,
      reason: "expired",
    });
  }, waitMs);
}

async function applyAdvancedBypass(
  { disableDeviceAuth = false, allowHostHeaderOriginFallback = false, ttlMs = FIX_ADVANCED_BYPASS_TTL_MS, reason = "manual" },
  { restartGateway = true } = {}
) {
  const now = Date.now();
  const enabled = Boolean(disableDeviceAuth || allowHostHeaderOriginFallback);
  const expiresAt = enabled ? now + Math.max(60_000, Number(ttlMs) || FIX_ADVANCED_BYPASS_TTL_MS) : null;

  const configResult = applyDangerousBypassFlagsToConfig({
    disableDeviceAuth: enabled ? Boolean(disableDeviceAuth) : false,
    allowHostHeaderOriginFallback: enabled ? Boolean(allowHostHeaderOriginFallback) : false,
  });

  if (!configResult.ok) return configResult;

  fixStateStore.patch({
    advancedBypass: {
      disableDeviceAuth: enabled ? Boolean(disableDeviceAuth) : false,
      allowHostHeaderOriginFallback: enabled ? Boolean(allowHostHeaderOriginFallback) : false,
      enabledAt: enabled ? now : null,
      expiresAt,
    },
  });

  if (enabled) scheduleFixBypassAutoOff(expiresAt);
  else clearFixBypassTimer();

  let restarted = false;
  if (restartGateway && configResult.changed && openclawProcess && !openclawStarting) {
    const restartResult = await restartOpenclawGateway();
    restarted = Boolean(restartResult.ok);
  }

  return {
    ok: true,
    changed: configResult.changed,
    enabled,
    expiresAt,
    reason,
    restarted,
  };
}

function initializeFixBypassState() {
  const state = getFixStateSnapshot();
  const bypass = state.advancedBypass || {};
  const hasBypass = Boolean(bypass.disableDeviceAuth || bypass.allowHostHeaderOriginFallback);
  if (!hasBypass) {
    clearFixBypassTimer();
    return;
  }

  const now = Date.now();
  const expiresAt = Number(bypass.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    const result = applyDangerousBypassFlagsToConfig({
      disableDeviceAuth: false,
      allowHostHeaderOriginFallback: false,
    });
    if (result.ok) {
      fixStateStore.patch({
        advancedBypass: {
          disableDeviceAuth: false,
          allowHostHeaderOriginFallback: false,
          enabledAt: null,
          expiresAt: null,
        },
      });
    }
    return;
  }

  applyDangerousBypassFlagsToConfig({
    disableDeviceAuth: Boolean(bypass.disableDeviceAuth),
    allowHostHeaderOriginFallback: Boolean(bypass.allowHostHeaderOriginFallback),
  });
  scheduleFixBypassAutoOff(expiresAt);
}

function getGatewayToken() {
  const env = readEnv();
  if (env.OPENCLAW_GATEWAY_TOKEN) return env.OPENCLAW_GATEWAY_TOKEN;
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  const config = readConfig();
  return config?.gateway?.auth?.token || null;
}

function getGatewayPassword() {
  const env = readEnv();
  if (env.OPENCLAW_GATEWAY_PASSWORD) return env.OPENCLAW_GATEWAY_PASSWORD;
  if (process.env.OPENCLAW_GATEWAY_PASSWORD) return process.env.OPENCLAW_GATEWAY_PASSWORD;
  const config = readConfig();
  return config?.gateway?.auth?.password || null;
}

function parseGatewayBody(rawText) {
  if (!rawText || !rawText.trim()) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function requestRawToBackendOpenclaw({ method = "GET", path: requestPath = "/", body, timeoutMs = 3500, headers = {} }) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      const error = new Error("openclaw is not configured");
      error.code = "not_configured";
      reject(error);
      return;
    }

    const token = getGatewayToken();
    const password = getGatewayPassword();
    const payload =
      body !== undefined ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8") : null;

    const requestHeaders = {
      ...headers,
      host: `127.0.0.1:${OPENCLAW_PORT}`,
      accept: "application/json, text/plain, */*",
    };

    if (payload) {
      requestHeaders["content-type"] = requestHeaders["content-type"] || "application/json; charset=utf-8";
      requestHeaders["content-length"] = String(payload.length);
    }
    if (token) requestHeaders.authorization = `Bearer ${token}`;
    if (password && !requestHeaders["x-openclaw-password"]) requestHeaders["x-openclaw-password"] = password;

    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: OPENCLAW_PORT,
        method,
        path: requestPath,
        headers: requestHeaders,
      },
      (upRes) => {
        const chunks = [];
        upRes.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        upRes.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: upRes.statusCode || 500,
            headers: upRes.headers || {},
            body: parseGatewayBody(text),
            text,
          });
        });
      }
    );

    upstream.setTimeout(Math.max(500, Number(timeoutMs) || 3500), () => {
      const error = new Error("gateway request timeout");
      error.code = "timeout";
      upstream.destroy(error);
    });

    upstream.on("error", (error) => {
      if (error && !error.code) error.code = "gateway_unavailable";
      reject(error);
    });

    if (payload) upstream.write(payload);
    upstream.end();
  });
}

function requestRawToOpenclaw({ method = "GET", path: requestPath = "/", body, timeoutMs = 3500, headers = {} }) {
  const isFeatureContractPath =
    requestPath === "/api/features" ||
    requestPath === "/api/v1/features" ||
    /^\/api\/features\/[^/]+\/toggle$/.test(String(requestPath || ""));

  const compatHandled =
    executionFeatureCompat &&
    typeof executionFeatureCompat.handleHttpRequest === "function" &&
    executionFeatureCompat.handleHttpRequest({
      method,
      path: requestPath,
      body,
    });

  if (isFeatureContractPath) {
    return requestRawToBackendOpenclaw({ method, path: requestPath, body, timeoutMs, headers })
      .then((result) => {
        if (executionFeatureCompat && typeof executionFeatureCompat.observeHttpCatalog === "function") {
          executionFeatureCompat.observeHttpCatalog(result?.body);
        }
        const contractState = executionFeatureCompat?.getStatus?.() || null;
        const hasNativeContract = Number(contractState?.httpContractVersion || 0) >= 1 && contractState?.httpContractSource === "native";
        if (hasNativeContract) return result;
        if (compatHandled && Number(result?.status || 0) === 404) return compatHandled;
        return result;
      })
      .catch((error) => {
        if (error?.code === "gateway_unavailable" || error?.code === "timeout") {
          throw error;
        }
        if (compatHandled) return compatHandled;
        throw error;
      });
  }

  if (compatHandled) return Promise.resolve(compatHandled);

  return requestRawToBackendOpenclaw({ method, path: requestPath, body, timeoutMs, headers }).then((result) => {
    if (executionFeatureCompat && typeof executionFeatureCompat.observeHttpCatalog === "function") {
      executionFeatureCompat.observeHttpCatalog(result?.body);
    }
    return result;
  });
}

gatewayRpcClient = new GatewayRpcClient({
  url: `ws://127.0.0.1:${OPENCLAW_PORT}/`,
  origin: `http://127.0.0.1:${OPENCLAW_PORT}`,
  getToken: () => getGatewayToken(),
  getPassword: () => getGatewayPassword(),
  clientId: "gateway-client",
  clientMode: "backend",
  sendOrigin: false,
  executionFeatureCompat:
    (executionFeatureCompat = new ExecutionFeatureCompat({
      runtimeStore,
    })),
});

runtimeAdapter = new OpenclawAdapter({
  requestRaw: requestRawToOpenclaw,
  capabilities: runtimeCapabilities,
  store: runtimeStore,
  usageLedger: runtimeUsageLedger,
  allowLocalFallback: true,
  chatGateway: {
    defaultSessionKey: RUNTIME_CHAT_SESSION_KEY,
    send: async ({ sessionKey, message, idempotencyKey, deliver = false, attachments = undefined, executionFeatures = undefined }) => {
      return gatewayRpcClient.sendChat({
        sessionKey: sessionKey || RUNTIME_CHAT_SESSION_KEY,
        message,
        idempotencyKey,
        deliver,
        attachments,
        executionFeatures,
      });
    },
    history: async ({ sessionKey, limit = 20 }) => {
      return gatewayRpcClient.chatHistory({
        sessionKey: sessionKey || RUNTIME_CHAT_SESSION_KEY,
        limit,
      });
    },
  },
});
usecaseDemoRuntime = new UsecaseDemoRuntime({
  runtimeStore,
  runtimeAdapter,
  runtimeWsBroker,
  timerStore: localRunSimulationTimers,
  bindGatewayAlias: bindGatewayRunAlias,
  getExecutionEnv: onboardingCliEnv,
  getTavilySkillDir: () => path.join(DEFAULT_SKILL_WORKSPACE_DIR, "tavily-search"),
});
featureToggleManager = new FeatureToggleManager({
  requestRaw: requestRawToOpenclaw,
  runtimeStore,
  runtimeAdapter,
  usecaseDemoRuntime,
  getExecutionFeatureContractState: () => gatewayRpcClient?.getExecutionFeatureContractState?.() || null,
  workspaceDir: RUNTIME_WORKSPACE_DIR,
});
planningConversationRuntime = new PlanningConversationRuntime({
  runtimeStore,
  runtimeAdapter,
  usecaseRuntime: usecaseDemoRuntime,
  featureToggleManager,
  chatGateway: runtimeAdapter.chatGateway,
});
generalConversationRuntime = new GeneralConversationRuntime({
  runtimeStore,
  chatGateway: runtimeAdapter.chatGateway,
});

function buildDefaultRunSteps() {
  return [
    { index: 1, label: "요청 분석", status: "running" },
    { index: 2, label: "자료 수집", status: "pending" },
    { index: 3, label: "초안 작성", status: "pending" },
    { index: 4, label: "검토", status: "pending" },
    { index: 5, label: "완료", status: "pending" },
  ];
}

function extractChatText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  const content = Array.isArray(message.content) ? message.content : [];
  const fragments = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text.trim()) fragments.push(part.text.trim());
  }
  return fragments.join("\n").trim();
}

function getLatestUserMessageForRun(runId) {
  const run = runtimeStore.getRunRecord(runId);
  if (!run) return "";
  const logs = Array.isArray(run.logs) ? run.logs : [];
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const entry = logs[index];
    if (String(entry?.level || "").toLowerCase() !== "user") continue;
    const message = String(entry?.message || "").trim();
    if (message) return message;
  }
  return String(run.prompt || "").trim();
}

function looksLikeIdentityQuestion(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return (
    /(who are you|are you openclaw|are you .*openclaw|what are you)/i.test(value) ||
    /(넌 누구|너 누구|너는 누구|너 누구야|넌 뭐야|정체가 뭐|정체가 누구|오픈클로.*아니|너.*오픈클로|이름이 뭐)/i.test(value)
  );
}

function looksLikeIdentityLeak(text) {
  const value = String(text || "").trim();
  if (!value || !/openclaw/i.test(value)) return false;
  return (
    /(기반|플랫폼|시스템|정확히 말하면|위에서 동작|개인 어시스턴트|대화하는 나|이렇게 보면 돼)/i.test(value) ||
    /\b(platform|system|based on|powered by)\b/i.test(value)
  );
}

function sanitizeAssistantIdentityText(text, runId) {
  const value = String(text || "").trim();
  if (!value) return "";
  const latestUserMessage = getLatestUserMessageForRun(runId);
  const shouldSanitize = looksLikeIdentityLeak(value) || (looksLikeIdentityQuestion(latestUserMessage) && /openclaw/i.test(value));
  if (!shouldSanitize) return value;
  return `저는 ${SEMO_ASSISTANT_NAME}예요, 제품과 대화 정체성도 ${SEMO_ASSISTANT_NAME}로 안내해요`;
}

function extractGatewayErrorText(payload) {
  const candidates = [
    payload?.error?.message,
    payload?.error?.detail,
    payload?.error,
    payload?.reason,
    payload?.stateReason,
    payload?.message?.error,
  ];
  for (const row of candidates) {
    if (typeof row === "string" && row.trim()) return row.trim();
    if (row && typeof row === "object") {
      const text = JSON.stringify(row);
      if (text && text !== "{}") return text;
    }
  }
  return "";
}

function isObviouslyInvalidModelApiKey(value) {
  const token = String(value || "").trim();
  if (!token) return true;
  if (token.length < 8) return true;
  if (/^(123|test|dummy|changeme|your[_-]?api[_-]?key)$/i.test(token)) return true;
  return false;
}

function hasBrokenModelAuthProfile() {
  const now = Date.now();
  if (now - authProfileHealthCache.ts < 3000) {
    return authProfileHealthCache.broken;
  }

  let broken = false;
  try {
    if (fs.existsSync(AUTH_PROFILES_FILE)) {
      const raw = fs.readFileSync(AUTH_PROFILES_FILE, "utf8");
      const parsed = JSON.parse(raw);
      const profiles = parsed?.profiles && typeof parsed.profiles === "object" ? Object.values(parsed.profiles) : [];
      const apiKeyProfiles = profiles.filter((entry) => String(entry?.type || "").toLowerCase() === "api_key");
      if (apiKeyProfiles.length > 0) {
        const keys = apiKeyProfiles.map((entry) => String(entry?.key || "").trim());
        const hasPotentiallyValidKey = keys.some((key) => !isObviouslyInvalidModelApiKey(key));
        const hasInvalidKey = keys.some((key) => isObviouslyInvalidModelApiKey(key));
        broken = hasInvalidKey && !hasPotentiallyValidKey;
      }
    }
  } catch {
    broken = false;
  }

  authProfileHealthCache = {
    ts: now,
    broken,
  };
  return broken;
}

function looksLikeModelAuthFailure(text) {
  const value = String(text || "").toLowerCase();
  if (!value) return false;
  return (
    value.includes("incorrect api key") ||
    value.includes("invalid api key") ||
    value.includes("api key not valid") ||
    value.includes("unauthorized") ||
    value.includes("authentication failed") ||
    value.includes("no auth profile") ||
    value.includes("forbidden")
  );
}

function buildExecutionFeatureState(run, payload = null) {
  if (Number.isFinite(Number(run?.executionFeaturesDowngradedAt)) && Number(run.executionFeaturesDowngradedAt) > 0) {
    return {
      executionFeatures: [],
      executionFeaturesLockedAt: null,
      executionFeaturesStatus: "none",
      executionFeaturesError: null,
    };
  }
  const baseFeatures = normalizeExecutionFeatures(run?.executionFeatures || []);
  const nextFeatures = normalizeExecutionFeatures(
    payload?.executionFeatures || payload?.execution_features || baseFeatures
  );
  const nextError = normalizeExecutionFeaturesError(
    payload?.executionFeaturesError || payload?.execution_features_error || run?.executionFeaturesError
  );
  const requestedStatus =
    payload?.executionFeaturesStatus ||
    payload?.execution_features_status ||
    run?.executionFeaturesStatus ||
    (nextFeatures.length > 0 ? "locked" : "none");
  const nextStatus =
    nextFeatures.length === 0
      ? nextError
        ? "failed"
        : "none"
      : normalizeExecutionFeaturesStatus(nextError ? "failed" : requestedStatus);
  return {
    executionFeatures: nextFeatures,
    executionFeaturesLockedAt: run?.executionFeaturesLockedAt || Date.now(),
    executionFeaturesStatus: nextStatus,
    executionFeaturesError: nextError,
  };
}

function buildRunSummary(run) {
  const logs = Array.isArray(run?.logs) ? run.logs : [];
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
  const execution = buildExecutionFeatureState(run);
  return {
    id: run.id,
    title: run.title,
    titleCustomized: Boolean(run.titleCustomized),
    isDraft: Boolean(run.isDraft),
    hasSubmittedPrompt: Boolean(run.hasSubmittedPrompt),
    prompt: String(run?.prompt || ""),
    lastMessage: String(lastLog?.message || run?.lastMessage || ""),
    status: run.status,
    updatedAt: run.updatedAt,
    step: run.step,
    usecaseId: run.usecaseId || "",
    originConversationId: run.originConversationId || "",
    executionFeatures: execution.executionFeatures,
    executionFeaturesLockedAt: execution.executionFeaturesLockedAt,
    executionFeaturesStatus: execution.executionFeaturesStatus,
    executionFeaturesError: execution.executionFeaturesError,
  };
}

function bindGatewayRunAlias(gatewayRunId, canonicalRunId) {
  const source = String(gatewayRunId || "").trim();
  const target = String(canonicalRunId || "").trim();
  if (!source || !target) return;
  runtimeGatewayRunAlias.set(source, target);
  if (runtimeGatewayRunAlias.size > 10_000) {
    const firstKey = runtimeGatewayRunAlias.keys().next().value;
    if (firstKey) runtimeGatewayRunAlias.delete(firstKey);
  }
}

function resolveCanonicalRunId(gatewayRunId) {
  let current = String(gatewayRunId || "").trim();
  if (!current) return "";
  const visited = new Set();
  while (runtimeGatewayRunAlias.has(current) && !visited.has(current)) {
    visited.add(current);
    current = String(runtimeGatewayRunAlias.get(current) || "").trim() || current;
  }
  return current;
}

function canonicalizeRunItems(items = []) {
  const rows = Array.isArray(items) ? items.filter((item) => item && typeof item === "object") : [];
  if (rows.length === 0) return [];

  const byId = new Map();
  for (const item of rows) {
    const itemId = String(item.id || "").trim();
    if (!itemId || byId.has(itemId)) continue;
    byId.set(itemId, item);
  }

  const deduped = [];
  const seenCanonicalIds = new Set();
  for (const item of rows) {
    const itemId = String(item.id || "").trim();
    if (!itemId) continue;
    const canonicalId = resolveCanonicalRunId(itemId) || itemId;
    if (seenCanonicalIds.has(canonicalId)) continue;
    seenCanonicalIds.add(canonicalId);
    deduped.push(byId.get(canonicalId) || item);
  }

  return deduped.sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0));
}

function listVisibleRuns() {
  return canonicalizeRunItems(runtimeStore.listRuns());
}

function handleGatewayChatEvent(payload) {
  if (!payload || typeof payload !== "object") return;
  const gatewayRunId = typeof payload.runId === "string" && payload.runId.trim() ? payload.runId.trim() : "";
  const runId = resolveCanonicalRunId(gatewayRunId);
  if (!runId) return;

  const state = String(payload.state || "running").toLowerCase();
  const usecaseHandled =
    usecaseDemoRuntime && typeof usecaseDemoRuntime.handleGatewayEvent === "function"
      ? usecaseDemoRuntime.handleGatewayEvent({
          runId,
          gatewayRunId,
          state,
          message: payload.message,
          payload,
        })
      : false;
  if (usecaseHandled) return;

  const rawText = extractChatText(payload.message) || extractGatewayErrorText(payload);
  const text = state === "error" ? rawText : sanitizeAssistantIdentityText(rawText, runId);
  const now = Date.now();

  let run = runtimeStore.getRun(runId);
  if (!run && !runtimeGatewayRunAlias.has(gatewayRunId)) {
    return;
  }
  if (!run) {
    const execution = buildExecutionFeatureState(null, payload);
    run = runtimeStore.upsertRun({
      id: runId,
      title: "새 실행",
      prompt: "",
      status: "running",
      sourceAction: "chat",
      sourceType: "gateway",
      createdAt: now,
      updatedAt: now,
      step: 1,
      steps: buildDefaultRunSteps(),
      tasks: [],
      logs: [],
      ...execution,
    });
  }

  if (!run) return;

  const nextStatus = state === "final" ? "completed" : state === "error" || state === "aborted" ? "failed" : "running";
  const nextStep = state === "final" ? 5 : state === "error" || state === "aborted" ? 4 : 2;
  const nextSteps = buildDefaultRunSteps().map((step) => {
    if (step.index < nextStep) return { ...step, status: "completed" };
    if (step.index === nextStep) return { ...step, status: nextStatus === "completed" ? "completed" : "running" };
    return { ...step, status: nextStatus === "completed" ? "completed" : "pending" };
  });
  const execution = buildExecutionFeatureState(run, payload);
  if ((state === "error" || state === "aborted") && !execution.executionFeaturesError && (looksLikeModelAuthFailure(text) || hasBrokenModelAuthProfile())) {
    execution.executionFeaturesError = {
      code: "model_auth_failed",
      message: text || "OpenClaw model authentication failed",
      details: null,
    };
    execution.executionFeaturesStatus = execution.executionFeatures.length > 0 ? "failed" : "none";
  }

  runtimeStore.patchRun(runId, {
    status: nextStatus,
    step: nextStep,
    steps: nextSteps,
    ...execution,
    updatedAt: now,
  });

  let appendedLog = null;
  if (text && (state === "final" || state === "error" || state === "aborted")) {
    const current = runtimeStore.getRun(runId);
    const lastMessage = current?.logs?.[current.logs.length - 1]?.message || "";
    if (String(lastMessage).trim() !== text) {
      const updated = runtimeStore.appendRunLog(runId, text, state === "error" ? "error" : "info");
      appendedLog = updated?.logs?.[updated.logs.length - 1] || null;
    }
  }

  const updatedRun = runtimeStore.getRun(runId);
  if (!updatedRun) return;

  runtimeWsBroker.broadcastRun(runId, {
    type: "run_updated",
    run: buildRunSummary(updatedRun),
    ts: Date.now(),
  });
  runtimeWsBroker.broadcastRun(runId, {
    type: "task_updated",
    runId,
    step: updatedRun.step,
    steps: updatedRun.steps,
    tasks: updatedRun.tasks,
    ts: Date.now(),
  });
  if (appendedLog) {
    runtimeWsBroker.broadcastRun(runId, {
      type: "log_appended",
      runId,
      log: appendedLog,
      ts: Date.now(),
    });
  }
  runtimeWsBroker.broadcastSnapshot({
    items: listVisibleRuns(),
    runById: { [runId]: updatedRun },
  });
}

gatewayRpcClient.on("chat", (payload) => {
  try {
    handleGatewayChatEvent(payload);
  } catch (error) {
    console.error("gateway chat event handling failed:", error.message);
  }
});

gatewayRpcClient.on("connected", () => {
  lastGatewayConnectedAt = Date.now();
});

gatewayRpcClient.on("disconnected", ({ code, reason } = {}) => {
  upsertFixLastClose(code, reason);
});

async function runDoctor() {
  try {
    const env = onboardingCliEnv();
    const invocation = resolveOpenclawInvocation(["doctor", "--non-interactive"], env);
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
  if (gatewayRpcClient) {
    gatewayRpcClient.start();
  }

  ensureDefaultSkillsProvisioned()
    .catch((error) => {
      console.error("default skills bootstrap failed:", error.message);
    })
    .finally(() => {
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
          if (gatewayRpcClient) gatewayRpcClient.stop();
        });
      });
    });
}

function getActiveInteractiveSnapshot() {
  const activeProcessSessionId = authSessionManager.getActiveSessionId();
  if (!activeProcessSessionId) {
    const fallbackContext = [...interactiveAuthContexts.values()]
      .filter((candidate) => candidate && !candidate.completed)
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))[0];
    if (!fallbackContext) {
      return {
        activeSessionId: null,
        activeProviderId: null,
        activeMethodId: null,
        interactivePhase: null,
      };
    }
    return {
      activeSessionId: fallbackContext.sessionId || null,
      activeProviderId: fallbackContext.providerId || null,
      activeMethodId: fallbackContext.methodId || null,
      interactivePhase: fallbackContext.lastPhase || null,
    };
  }

  let context = interactiveAuthContexts.get(activeProcessSessionId);
  if (!context) {
    for (const candidate of interactiveAuthContexts.values()) {
      if (getInteractiveProcessSessionId(candidate) === activeProcessSessionId) {
        context = candidate;
        break;
      }
    }
  }
  return {
    activeSessionId: context?.sessionId || activeProcessSessionId,
    activeProviderId: context?.providerId || null,
    activeMethodId: context?.methodId || null,
    interactivePhase: context?.lastPhase || null,
  };
}

function hasActiveInteractiveAuthSession() {
  if (authSessionManager.hasActiveSession()) return true;
  for (const context of interactiveAuthContexts.values()) {
    if (context && !context.completed) return true;
  }
  return false;
}

function buildWizardState(providerId, methodId) {
  void providerId;
  void methodId;
  const ts = new Date().toISOString();
  return {
    lastRunAt: ts,
    lastRunVersion: OPENCLAW_NPM_VERSION,
    lastRunCommand: "onboard",
    lastRunMode: "local",
  };
}

function applyOpenAICodexDirectDefaults(config, providerId, methodId) {
  const next = config && typeof config === "object" ? config : {};
  next.meta = {
    ...(next.meta && typeof next.meta === "object" ? next.meta : {}),
    lastTouchedVersion: OPENCLAW_NPM_VERSION,
    lastTouchedAt: new Date().toISOString(),
  };
  next.wizard = {
    ...(next.wizard && typeof next.wizard === "object" ? next.wizard : {}),
    ...buildWizardState(providerId, methodId),
  };
  next.agents = next.agents && typeof next.agents === "object" ? next.agents : {};
  next.agents.defaults = next.agents.defaults && typeof next.agents.defaults === "object" ? next.agents.defaults : {};
  next.agents.defaults.model =
    next.agents.defaults.model && typeof next.agents.defaults.model === "object" ? next.agents.defaults.model : {};
  if (!next.agents.defaults.model.primary) {
    next.agents.defaults.model.primary = "openai-codex/gpt-5.3-codex";
  }
  return next;
}

function detectConnectedProviderAndMethod() {
  const config = readConfig();
  const env = onboardingCliEnv();
  const providers = listProviderCatalog();

  const wizardProviderId = config?.wizard?.providerId || config?.wizard?.provider || null;
  const wizardMethodId = config?.wizard?.methodId || config?.wizard?.method || null;
  if (wizardProviderId) {
    return {
      providerId: wizardProviderId,
      methodId: wizardMethodId || null,
      configured: true,
    };
  }

  const authProfiles = config?.auth?.profiles && typeof config.auth.profiles === "object" ? config.auth.profiles : {};
  const hasOpenAICodexOauth = Object.values(authProfiles).some((profile) => {
    if (!profile || typeof profile !== "object") return false;
    return String(profile.provider || "").toLowerCase() === "openai-codex" && String(profile.mode || "").toLowerCase() === "oauth";
  });
  if (hasOpenAICodexOauth) {
    return {
      providerId: "openai",
      methodId: "openai-codex",
      configured: true,
    };
  }

  const envFieldMap = {
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    xai: ["XAI_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    moonshot: ["MOONSHOT_API_KEY"],
    minimax: ["MINIMAX_API_KEY"],
    zai: ["ZAI_API_KEY"],
    volcengine: ["DASHSCOPE_API_KEY"],
    byteplus: ["DASHSCOPE_API_KEY"],
  };

  for (const provider of providers) {
    const keys = envFieldMap[provider.id] || [];
    if (keys.some((key) => Boolean(env[key]))) {
      const defaultMethod = provider.methods?.[0]?.id || null;
      return {
        providerId: provider.id,
        methodId: defaultMethod,
        configured: true,
      };
    }
  }

  return {
    providerId: null,
    methodId: null,
    configured: isConfigured(),
  };
}

function parseRuntimeTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inferProviderIdFromModel(model) {
  const value = String(model || "").trim().toLowerCase();
  if (!value) return null;
  if (value.includes("/")) return value.split("/")[0] || null;
  if (value.includes("claude")) return "anthropic";
  if (value.includes("gpt") || value.includes("o1") || value.includes("o3") || value.includes("o4")) return "openai";
  if (value.includes("gemini")) return "google";
  if (value.includes("grok")) return "xai";
  if (value.includes("mistral")) return "mistral";
  if (value.includes("deepseek")) return "deepseek";
  if (value.includes("llama")) return "meta";
  return null;
}

function normalizeRuntimeModelSnapshot(payload, source) {
  if (!payload || typeof payload !== "object") return null;
  const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const api = typeof payload.api === "string" ? payload.api.trim() : "";
  const ts =
    parseRuntimeTimestamp(payload.ts) ||
    parseRuntimeTimestamp(payload.timestamp) ||
    parseRuntimeTimestamp(payload.updatedAt) ||
    null;

  if (!provider && !model && !api) return null;
  return {
    provider: provider || inferProviderIdFromModel(model) || null,
    model: model || null,
    api: api || null,
    ts,
    source,
  };
}

async function readRuntimeModelFromGatewayStatus() {
  if (!gatewayRpcClient || typeof gatewayRpcClient.request !== "function") return null;
  try {
    const status = await gatewayRpcClient.request("status", {}, { timeoutMs: 2000 });
    const recentRows = Array.isArray(status?.sessions?.recent) ? status.sessions.recent : [];
    const primary = recentRows.find((row) => typeof row?.model === "string" && row.model.trim()) || null;
    const fallbackModel =
      (typeof status?.sessions?.defaults?.model === "string" && status.sessions.defaults.model.trim()) || "";
    const payload = primary
      ? {
          provider: inferProviderIdFromModel(primary.model),
          model: primary.model,
          ts: primary.updatedAt || Date.now(),
        }
      : fallbackModel
        ? {
            provider: inferProviderIdFromModel(fallbackModel),
            model: fallbackModel,
            ts: Date.now(),
          }
        : null;
    return normalizeRuntimeModelSnapshot(payload, "gateway_status");
  } catch {
    return null;
  }
}

function readLatestRuntimeModelFromUsageLedger() {
  try {
    const usage = runtimeUsageLedger.query({ limit: 30 });
    const rows = Array.isArray(usage?.rows) ? usage.rows : [];
    for (const row of rows) {
      const candidate = normalizeRuntimeModelSnapshot(row, "usage_ledger");
      if (candidate) return candidate;
    }
  } catch {}
  return null;
}

function readLatestRuntimeModelFromSessionLogs() {
  const sessionsDir = path.join(CONFIG_DIR, "agents", "main", "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  let files = [];
  try {
    files = fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => {
        const filePath = path.join(sessionsDir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(filePath).mtimeMs;
        } catch {}
        return { filePath, mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 20);
  } catch {
    return null;
  }

  for (const file of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(file.filePath, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const floor = Math.max(0, lines.length - 80);
    for (let index = lines.length - 1; index >= floor; index -= 1) {
      let parsed;
      try {
        parsed = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      const message = parsed?.message;
      if (!message || typeof message !== "object") continue;
      const candidate = normalizeRuntimeModelSnapshot(
        {
          provider: message.provider,
          model: message.model,
          api: message.api,
          ts: message.timestamp || parsed.timestamp || parsed.ts,
        },
        "session_log"
      );
      if (candidate) return candidate;
    }
  }

  return null;
}

async function detectRuntimeModelSnapshot() {
  return (
    (await readRuntimeModelFromGatewayStatus()) ||
    readLatestRuntimeModelFromSessionLogs() ||
    readLatestRuntimeModelFromUsageLedger() ||
    null
  );
}

function normalizeFeatureStatusRow(row) {
  return normalizeFeatureStatus(row);
}

function buildRuntimeFeatureRows() {
  const flags = runtimeStore.getFeatureFlags();
  const status = runtimeStore.getFeatureStatus();

  return FEATURE_UI_ROWS.filter((row) => FEATURE_IDS.includes(row.id)).map((row) => ({
    id: row.id,
    canonicalId: row.canonicalId,
    name: row.name,
    description: row.description,
    enabled: Boolean(flags[row.id]),
    status: normalizeFeatureStatusRow(status[row.id]),
  }));
}

async function refreshRuntimeFeaturesIfPossible() {
  if (!isConfigured()) {
    return {
      ok: false,
      code: "not_configured",
      error: "openclaw is not configured yet",
      items: buildRuntimeFeatureRows(),
    };
  }
  if (!openclawProcess && !openclawStarting) startOpenclaw();
  if (gatewayRpcClient && typeof gatewayRpcClient.waitUntilReady === "function") {
    try {
      await gatewayRpcClient.waitUntilReady(2500);
    } catch {
      // HTTP feature catalog may still succeed even if WS contract negotiation failed.
    }
  }
  try {
    let result = await featureToggleManager.refreshFeatures();
    if (!result.ok && (result.code === "gateway_unavailable" || result.code === "timeout")) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      result = await featureToggleManager.refreshFeatures();
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      code: error?.code || "feature_catalog_failed",
      error: error?.message || "failed to refresh feature catalog",
      items: buildRuntimeFeatureRows(),
    };
  }
}

function formatRunTimestamp(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value)) return Date.now();
  return value;
}

function buildRuntimeHomePayload(runItems = [], usageSummary = null) {
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStartTs = startOfDay.getTime();
  const visibleRuns = runItems.filter((run) => !(run?.isDraft && !run?.hasSubmittedPrompt));
  const dayRuns = visibleRuns.filter((run) => formatRunTimestamp(run.updatedAt) >= dayStartTs);
  const completedCount = dayRuns.filter((run) => run.status === "completed").length;
  const failedCount = dayRuns.filter((run) => run.status === "failed").length;
  const successBase = completedCount + failedCount;

  return {
    ok: true,
    recentRuns: visibleRuns.slice(0, 6),
    todayStats: {
      runsToday: dayRuns.length,
      alerts: failedCount,
      successRate: successBase > 0 ? Math.round((completedCount / successBase) * 100) : 0,
      tokenUsage: Number(usageSummary?.totalTokens || 0),
    },
    ts: now,
  };
}

function normalizeCreatePayload(payload = {}) {
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const sourceAction =
    typeof payload.sourceAction === "string" && payload.sourceAction.trim()
      ? payload.sourceAction.trim()
      : "home_input";
  const parentRunId = typeof payload.parentRunId === "string" ? payload.parentRunId.trim() : "";
  const usecaseId = typeof payload.usecaseId === "string" ? payload.usecaseId.trim() : "";
  const createMode = payload?.createMode === "draft" ? "draft" : "message";
  const formInput = payload.formInput && typeof payload.formInput === "object" ? payload.formInput : {};
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  return {
    prompt,
    sourceAction,
    parentRunId,
    usecaseId,
    createMode,
    formInput,
    attachments,
  };
}

function normalizeConversationPayload(payload = {}) {
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const sourceAction =
    typeof payload.sourceAction === "string" && payload.sourceAction.trim()
      ? payload.sourceAction.trim()
      : "chat";
  const selectedUsecaseId =
    typeof payload.selectedUsecaseId === "string" && payload.selectedUsecaseId.trim()
      ? payload.selectedUsecaseId.trim()
      : "";
  const templateAnswers = payload.templateAnswers && typeof payload.templateAnswers === "object" ? payload.templateAnswers : {};
  const followupAnswers = payload.followupAnswers && typeof payload.followupAnswers === "object" ? payload.followupAnswers : {};
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  return {
    prompt,
    text,
    title,
    sourceAction,
    selectedUsecaseId,
    templateAnswers,
    followupAnswers,
    attachments,
  };
}

function sanitizeAttachmentFilename(filename) {
  const raw = String(filename || "").trim();
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned || "attachment";
}

function getRuntimeServerOrigin(req) {
  const forwardedHost = typeof req?.headers?.["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"].trim() : "";
  const host = forwardedHost || (typeof req?.headers?.host === "string" ? req.headers.host.trim() : "");
  if (host) {
    const forwardedProto = typeof req?.headers?.["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"].trim() : "";
    const protocol = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "http");
    return `${protocol}://${host}`;
  }
  return `http://127.0.0.1:${PORT}`;
}

function readAttachmentMeta(attachmentId) {
  const id = String(attachmentId || "").trim();
  if (!id) return null;
  const metaPath = path.join(RUNTIME_ATTACHMENT_DIR, `${id}.json`);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return {
      id,
      filename: sanitizeAttachmentFilename(raw.filename || "attachment"),
      mime: String(raw.mime || raw.mimeType || "application/octet-stream").trim() || "application/octet-stream",
      size: Number.isFinite(Number(raw.size)) ? Number(raw.size) : null,
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : null,
    };
  } catch {
    return null;
  }
}

function persistConversationAttachments(rawAttachments, req) {
  const source = Array.isArray(rawAttachments) ? rawAttachments.slice(0, CONVERSATION_ATTACHMENT_LIMIT) : [];
  if (source.length === 0) return [];
  fs.mkdirSync(RUNTIME_ATTACHMENT_DIR, { recursive: true });
  const origin = getRuntimeServerOrigin(req);
  return source.map((item) => {
    const row = item && typeof item === "object" ? item : {};
    const existingUrl = typeof row.url === "string" ? row.url.trim() : "";
    const mimeType = String(row.mime || row.mimeType || mime.lookup(String(row.filename || "")) || "application/octet-stream").trim() || "application/octet-stream";
    const filename = sanitizeAttachmentFilename(row.filename || row.name || "");
    const size = Number(row.size);

    if (existingUrl && typeof row.data !== "string" && typeof row.contentBase64 !== "string") {
      return {
        id: String(row.id || crypto.randomUUID()),
        type: "file",
        url: existingUrl,
        filename: filename || "attachment",
        mime: mimeType,
        size: Number.isFinite(size) && size >= 0 ? size : null,
      };
    }

    const base64Value =
      typeof row.data === "string"
        ? row.data.trim()
        : typeof row.contentBase64 === "string"
          ? row.contentBase64.trim()
          : "";
    if (!base64Value) return null;

    const bytes = Buffer.from(base64Value, "base64");
    if (!bytes.length) return null;
    if (bytes.length > CONVERSATION_ATTACHMENT_MAX_BYTES) {
      const error = new Error(`${filename || "attachment"} 파일이 너무 커서 업로드할 수 없어요`);
      error.code = "attachment_too_large";
      throw error;
    }

    const id = String(row.id || crypto.randomUUID());
    const binPath = path.join(RUNTIME_ATTACHMENT_DIR, `${id}.bin`);
    const metaPath = path.join(RUNTIME_ATTACHMENT_DIR, `${id}.json`);
    const normalizedFilename = filename || `${id}.${mime.extension(mimeType) || "bin"}`;
    fs.writeFileSync(binPath, bytes);
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          id,
          filename: normalizedFilename,
          mime: mimeType,
          size: bytes.length,
          createdAt: Date.now(),
        },
        null,
        2
      )
    );
    return {
      id,
      type: "file",
      url: `${origin}/api/ui/runtime/attachments/${encodeURIComponent(id)}`,
      filename: normalizedFilename,
      mime: mimeType,
      size: bytes.length,
    };
  }).filter(Boolean);
}

function usageFingerprint(row) {
  if (!row || typeof row !== "object") return null;
  return [
    row.runId || "unknown",
    row.provider || "unknown",
    row.model || "unknown",
    Number(row.totalTokens || 0),
    Number(row.costUsd || 0),
    Number(row.ts || 0),
  ].join("|");
}

function clearLocalRunSimulation(runId) {
  const timers = localRunSimulationTimers.get(String(runId));
  if (Array.isArray(timers)) {
    for (const timer of timers) clearTimeout(timer);
  }
  localRunSimulationTimers.delete(String(runId));
}

function scheduleLocalRunSimulation(runId) {
  const key = String(runId);
  clearLocalRunSimulation(key);

  const steps = [
    {
      delay: 900,
      status: "running",
      step: 2,
      message: "자료 수집 단계를 시작했어요",
      usage: { provider: "unknown", model: "unknown", inputTokens: 120, outputTokens: 80, totalTokens: 200, costUsd: 0, ts: Date.now() + 900 },
    },
    {
      delay: 1900,
      status: "running",
      step: 3,
      message: "초안을 만들고 있어요",
      usage: { provider: "unknown", model: "unknown", inputTokens: 240, outputTokens: 220, totalTokens: 460, costUsd: 0, ts: Date.now() + 1900 },
    },
    {
      delay: 3200,
      status: "completed",
      step: 5,
      message: "실행이 완료됐어요",
      usage: { provider: "unknown", model: "unknown", inputTokens: 280, outputTokens: 360, totalTokens: 640, costUsd: 0, ts: Date.now() + 3200 },
    },
  ];

  const timers = steps.map((point) =>
    setTimeout(async () => {
      const current = runtimeStore.getRun(key);
      if (!current) return;

      const nextSteps = Array.isArray(current.steps)
        ? current.steps.map((item) => {
            if (Number(item.index) < Number(point.step)) return { ...item, status: "completed" };
            if (Number(item.index) === Number(point.step)) return { ...item, status: point.status === "completed" ? "completed" : "running" };
            return { ...item, status: point.status === "completed" ? "completed" : "pending" };
          })
        : [];

      runtimeStore.patchRun(key, {
        status: point.status,
        step: point.step,
        steps: nextSteps,
        updatedAt: Date.now(),
      });
      runtimeStore.appendRunLog(key, point.message, "info");
      runtimeStore.setRunUsage(key, point.usage);
      runtimeAdapter.appendUsage({ ...point.usage, runId: key });

      const detailResult = await runtimeAdapter.getRun(key);
      const listResult = await runtimeAdapter.listRuns();
      if (detailResult.ok && detailResult.run) {
        runtimeWsBroker.broadcastRun(key, {
          type: "run_updated",
          run: {
            id: detailResult.run.id,
            title: detailResult.run.title,
            status: detailResult.run.status,
            updatedAt: detailResult.run.updatedAt,
          },
          ts: Date.now(),
        });
        runtimeWsBroker.broadcastRun(key, {
          type: "task_updated",
          runId: key,
          step: detailResult.run.step,
          steps: detailResult.run.steps,
          tasks: detailResult.run.tasks,
          ts: Date.now(),
        });
        runtimeWsBroker.broadcastRun(key, {
          type: "log_appended",
          runId: key,
          log: detailResult.run.logs?.[detailResult.run.logs.length - 1] || null,
          ts: Date.now(),
        });
        runtimeWsBroker.broadcastRun(key, {
          type: "usage_updated",
          runId: key,
          usage: detailResult.run.usage || point.usage,
          ts: Date.now(),
        });
      }
      if (listResult.ok) {
        runtimeWsBroker.broadcastSnapshot({
          items: canonicalizeRunItems(listResult.items || []),
          runById: detailResult.ok && detailResult.run ? { [key]: detailResult.run } : {},
        });
      }
    }, point.delay)
  );

  localRunSimulationTimers.set(key, timers);
}

async function pollRuntimeAndBroadcast() {
  if (!isConfigured()) return;
  if (runtimeWsBroker.size() === 0) return;

  if (!openclawProcess && !openclawStarting) {
    startOpenclaw();
  }

  const listResult = await runtimeAdapter.listRuns();
  if (!listResult.ok) return;

  const items = canonicalizeRunItems(listResult.items || []);
  const runById = {};
  for (const item of items) {
    const fp = `${item.status || "running"}|${Number(item.updatedAt || 0)}`;
    const prevFp = runtimeRunSummaryFingerprints.get(item.id);
    if (prevFp !== fp) {
      runtimeRunSummaryFingerprints.set(item.id, fp);
      runtimeWsBroker.broadcastRun(item.id, {
        type: "run_updated",
        run: item,
        ts: Date.now(),
      });
    }
  }

  const subscribedRunIds = runtimeWsBroker.listSubscribedRunIds();
  for (const runId of subscribedRunIds) {
    const detailResult = await runtimeAdapter.getRun(runId);
    if (!detailResult.ok || !detailResult.run) continue;

    const run = detailResult.run;
    runById[run.id] = run;

    const nextFingerprint = `${run.status}|${run.step}|${run.updatedAt}|${Array.isArray(run.tasks) ? run.tasks.length : 0}|${
      Array.isArray(run.logs) ? run.logs.length : 0
    }`;
    const prev = runtimeRunDetailState.get(run.id) || {
      fingerprint: "",
      logCount: 0,
      usageKey: null,
    };

    if (prev.fingerprint !== nextFingerprint) {
      runtimeWsBroker.broadcastRun(run.id, {
        type: "task_updated",
        runId: run.id,
        step: run.step,
        steps: Array.isArray(run.steps) ? run.steps : [],
        tasks: Array.isArray(run.tasks) ? run.tasks : [],
        wbs: run.wbs || null,
        pauseState: run.pauseState || null,
        currentExecution: run.currentExecution || null,
        artifacts: run.artifacts || null,
        ts: Date.now(),
      });
    }

    const logs = Array.isArray(run.logs) ? run.logs : [];
    if (logs.length > prev.logCount) {
      const diffLogs = logs.slice(prev.logCount);
      for (const log of diffLogs) {
        runtimeWsBroker.broadcastRun(run.id, {
          type: "log_appended",
          runId: run.id,
          log,
          ts: Date.now(),
        });
      }
    }

    const usageKey = usageFingerprint(run.usage);
    if (usageKey && prev.usageKey !== usageKey) {
      runtimeWsBroker.broadcastRun(run.id, {
        type: "usage_updated",
        runId: run.id,
        usage: run.usage,
        ts: Date.now(),
      });

      if (!runtimeUsageFingerprints.has(usageKey)) {
        runtimeUsageFingerprints.add(usageKey);
        if (runtimeUsageFingerprints.size > 20_000) {
          runtimeUsageFingerprints.clear();
        }
        runtimeAdapter.appendUsage(run.usage);
      }
    }

    runtimeRunDetailState.set(run.id, {
      fingerprint: nextFingerprint,
      logCount: logs.length,
      usageKey: usageKey || prev.usageKey,
    });
  }

  runtimeWsBroker.broadcastSnapshot({
    items,
    runById,
  });
}

function startRuntimePoller() {
  if (runtimePollTimer) return;
  runtimePollTimer = setInterval(() => {
    pollRuntimeAndBroadcast().catch((error) => {
      console.error("runtime poll failed:", error.message);
    });
  }, RUNTIME_POLL_INTERVAL_MS);
}

async function initializeHome() {
  const homeDir = process.env.HOME || "/data";
  try {
    const entries = await fsp.readdir(SKELETON_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(SKELETON_DIR, entry.name);
      const isLinuxbrewEntry = entry.name === "linuxbrew";
      const destPath = isLinuxbrewEntry ? "/home/linuxbrew" : path.join(homeDir, entry.name);
      const existsCheckPath = isLinuxbrewEntry ? path.join(destPath, ".linuxbrew", "bin", "brew") : destPath;

      let exists = true;
      try {
        await fsp.access(existsCheckPath);
      } catch {
        exists = false;
      }

      if (!exists) {
        if (entry.isDirectory()) {
          await fsp.mkdir(destPath, { recursive: true });
          await execAsync(`cp -r "${srcPath}/." "${destPath}"`);
        } else {
          await fsp.copyFile(srcPath, destPath);
        }
      }
    }
  } catch (error) {
    console.error("Failed to initialize home skeleton:", error.message);
  }

  try {
    await ensureRuntimeTmpDir();
  } catch (error) {
    console.error("Failed to initialize runtime temp dir:", error.message);
  }

  try {
    await ensureLinuxbrewInstalled();
  } catch (error) {
    console.error("Failed to bootstrap Linuxbrew:", error.message);
  }
}

async function ensureRuntimeTmpDir() {
  const tempDir = process.env.TMPDIR || RUNTIME_TMP_DIR;
  await fsp.mkdir(tempDir, { recursive: true });
  await fsp.access(tempDir, fs.constants.W_OK);
  return tempDir;
}

async function ensureLinuxbrewInstalled() {
  try {
    await fsp.access(LINUXBREW_BIN);
    return false;
  } catch {}

  console.log("Linuxbrew not found, bootstrapping runtime install");
  await execAsync("sudo mkdir -p /home/linuxbrew", {
    env: process.env,
    timeout: Math.max(30_000, Math.min(LINUXBREW_INSTALL_TIMEOUT_MS, 120_000)),
    maxBuffer: 1024 * 1024 * 4,
  });

  const installEnv = {
    ...process.env,
    HOME: process.env.HOME || "/data",
    NONINTERACTIVE: "1",
    CI: "1",
    HOMEBREW_NO_ANALYTICS: "1",
  };

  await execAsync('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', {
    env: installEnv,
    timeout: LINUXBREW_INSTALL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 16,
  });

  try {
    await fsp.access(LINUXBREW_BIN);
    console.log("Linuxbrew runtime install completed");
    return true;
  } catch {
    throw new Error("Linuxbrew bootstrap finished without brew binary");
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

  const safeDestroySocket = (target) => {
    if (!target) return;
    try {
      if (!target.destroyed) target.destroy();
    } catch {
      // ignore socket destroy errors
    }
  };

  const closeBoth = () => {
    safeDestroySocket(socket);
    safeDestroySocket(upstream);
  };

  upstream.on("error", () => closeBoth());
  socket.on("error", () => closeBoth());
  socket.on("close", () => safeDestroySocket(upstream));
  upstream.on("close", () => safeDestroySocket(socket));
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function softKeyValidationResponse({
  providerId,
  valid,
  severity = "info",
  code = null,
  message = "",
  canProceed = true,
}) {
  return {
    ok: true,
    valid: Boolean(valid),
    severity,
    code,
    message,
    canProceed,
    provider: providerId,
  };
}

function extractCredentialValue(method, credentials) {
  if (!method) return "";
  const required = Array.isArray(method.requiredFields) ? method.requiredFields : [];
  const firstField = required[0] || Object.keys(method.credentialFlags || {})[0];
  if (!firstField) return "";
  const value = credentials?.[firstField];
  return typeof value === "string" ? value.trim() : "";
}

function messageForInvalidKey(providerLabel) {
  return `${providerLabel} API 키 검증에 실패했으니 키를 다시 확인하거나 그대로 진행할 수 있어요`;
}

async function validateApiKeySoft({ providerId, method, credentials }) {
  const token = extractCredentialValue(method, credentials);
  if (!token) {
    const error = new Error("credential value is required");
    error.code = "invalid_input";
    throw error;
  }

  try {
    if (providerId === "openai") {
      const response = await fetchWithTimeout("https://api.openai.com/v1/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        return softKeyValidationResponse({
          providerId,
          valid: true,
          message: "OpenAI API 키 검증에 성공했어요",
          canProceed: true,
        });
      }
      if (response.status === 401 || response.status === 403) {
        return softKeyValidationResponse({
          providerId,
          valid: false,
          severity: "warn",
          code: "invalid_key",
          message: messageForInvalidKey("OpenAI"),
          canProceed: true,
        });
      }
      return softKeyValidationResponse({
        providerId,
        valid: false,
        severity: "warn",
        code: "validation_unavailable",
        message: `OpenAI 검증 응답이 비정상(${response.status})이라 지금은 확인이 어렵지만 그래도 진행할 수 있어요`,
        canProceed: true,
      });
    }

    if (providerId === "anthropic") {
      const response = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "x-api-key": token,
          "anthropic-version": "2023-06-01",
        },
      });
      if (response.ok) {
        return softKeyValidationResponse({
          providerId,
          valid: true,
          message: "Anthropic API 키 검증에 성공했어요",
          canProceed: true,
        });
      }
      if (response.status === 401 || response.status === 403) {
        return softKeyValidationResponse({
          providerId,
          valid: false,
          severity: "warn",
          code: "invalid_key",
          message: messageForInvalidKey("Anthropic"),
          canProceed: true,
        });
      }
      return softKeyValidationResponse({
        providerId,
        valid: false,
        severity: "warn",
        code: "validation_unavailable",
        message: `Anthropic 검증 응답이 비정상(${response.status})이라 지금은 확인이 어렵지만 그래도 진행할 수 있어요`,
        canProceed: true,
      });
    }

    if (providerId === "google") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(token)}`;
      const response = await fetchWithTimeout(url, { method: "GET" });
      if (response.ok) {
        return softKeyValidationResponse({
          providerId,
          valid: true,
          message: "Google Gemini API 키 검증에 성공했어요",
          canProceed: true,
        });
      }

      const bodyText = await response.text();
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        if (/api key not valid|invalid api key|unauth|forbidden|permission denied/i.test(bodyText)) {
          return softKeyValidationResponse({
            providerId,
            valid: false,
            severity: "warn",
            code: "invalid_key",
            message: messageForInvalidKey("Google Gemini"),
            canProceed: true,
          });
        }
      }
      return softKeyValidationResponse({
        providerId,
        valid: false,
        severity: "warn",
        code: "validation_unavailable",
        message: `Google 검증 응답이 비정상(${response.status})이라 지금은 확인이 어렵지만 그래도 진행할 수 있어요`,
        canProceed: true,
      });
    }

    return softKeyValidationResponse({
      providerId,
      valid: false,
      severity: "warn",
      code: "validation_not_supported",
      message: "이 provider는 현재 키 검증을 지원하지 않지만 그래도 진행할 수 있어요",
      canProceed: true,
    });
  } catch (error) {
    const code = error?.name === "AbortError" ? "timeout" : "gateway_unavailable";
    return softKeyValidationResponse({
      providerId,
      valid: false,
      severity: "warn",
      code,
      message: "키 검증 서버에 연결하지 못했지만 그래도 진행할 수 있어요",
      canProceed: true,
    });
  }
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

function parseFixOptions(input) {
  const src = input && typeof input === "object" ? input : {};
  const advancedSrc = src.advancedBypass && typeof src.advancedBypass === "object" ? src.advancedBypass : {};
  const disableDeviceAuth = Boolean(advancedSrc.disableDeviceAuth);
  const allowHostHeaderOriginFallback = Boolean(advancedSrc.allowHostHeaderOriginFallback);
  const applyAdvancedBypass = Boolean(src.applyAdvancedBypass);
  return {
    applyChannelMitigation: Boolean(src.applyChannelMitigation),
    runDoctorRepair: Boolean(src.runDoctorRepair),
    applyAdvancedBypass,
    advancedBypass: {
      disableDeviceAuth,
      allowHostHeaderOriginFallback,
    },
    hasAdvancedBypass: applyAdvancedBypass,
    deviceHint: src.deviceHint ? String(src.deviceHint).trim() : "",
    forceCategory: src.forceCategory ? String(src.forceCategory).trim() : "",
  };
}

function createFixStep(steps, { title, status = "info", message = "", details = null }) {
  steps.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    title: String(title || "단계"),
    status,
    message: message ? String(message) : "",
    details: details && typeof details === "object" ? details : null,
    ts: Date.now(),
  });
}

function buildFixResult({
  status,
  category,
  summaryKo,
  steps,
  nextActions = [],
  confirmationRequest = null,
  dashboardUrl = null,
  meta = null,
}) {
  return {
    ok: true,
    status,
    category,
    summaryKo,
    steps,
    nextActions,
    confirmationRequest,
    dashboardUrl,
    meta,
  };
}

function buildFixStatePayload({ origin = "" } = {}) {
  const state = getFixStateSnapshot();
  const diagnosis = diagnoseFixCategory({
    closeCode: state?.lastClose?.code,
    closeReason: state?.lastClose?.reason,
    origin,
    lastErrorCode: lastOnboardingErrorCode,
    gatewayRunning: Boolean(openclawProcess),
  });

  return {
    ok: true,
    configured: isConfigured(),
    gatewayRunning: Boolean(openclawProcess),
    recovering: fixRecovering,
    lastCloseCode: state?.lastClose?.code ?? null,
    lastCloseReason: state?.lastClose?.reason || "",
    lastErrorCode: lastOnboardingErrorCode,
    lastCloseAt: state?.lastClose?.at ?? null,
    lastRecover: state?.lastRecover || null,
    advancedBypass: state?.advancedBypass || {
      disableDeviceAuth: false,
      allowHostHeaderOriginFallback: false,
      enabledAt: null,
      expiresAt: null,
    },
    diagnosisPreview: {
      category: diagnosis.category,
      categoryLabel: FIX_DIAGNOSIS_LABELS[diagnosis.category] || FIX_DIAGNOSIS_LABELS.unknown,
      hint: diagnosis.hint,
    },
    runtimeTransport: {
      clientId: "gateway-client",
      clientMode: "backend",
    },
    featureContract: gatewayRpcClient?.getExecutionFeatureContractState?.() || null,
    lastGatewayConnectedAt,
    ts: Date.now(),
  };
}

function extractDevicesFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.devices)) return payload.devices;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data?.devices)) return payload.data.devices;
  if (Array.isArray(payload.data?.items)) return payload.data.items;
  return [];
}

function normalizeDeviceRow(row) {
  if (!row || typeof row !== "object") return null;
  const status = String(row.status || row.state || "").toLowerCase();
  const role = String(row.role || row.deviceRole || "operator").toLowerCase();
  const id = String(row.id || row.deviceId || row.device || "").trim();
  const requestOrigin = row.origin || row.requestOrigin || row.request?.origin || null;
  const ip = row.ip || row.remoteIp || row.request?.ip || row.request?.remoteAddress || null;
  const userAgent = row.userAgent || row.ua || row.request?.userAgent || null;
  const createdAt = Number(row.createdAt || row.requestedAt || row.updatedAt || 0) || null;
  const paired =
    row.paired === true ||
    status.includes("approved") ||
    status.includes("paired") ||
    status.includes("active") ||
    status.includes("trusted");
  const pending = row.pending === true || status.includes("pending") || status.includes("requested");
  const name = String(row.name || row.label || "").trim() || null;

  if (!id && !name) return null;
  return {
    id: id || name,
    name,
    role: role || "operator",
    status: status || (paired ? "paired" : pending ? "pending" : "unknown"),
    paired,
    pending,
    origin: requestOrigin ? String(requestOrigin) : null,
    ip: ip ? String(ip) : null,
    userAgent: userAgent ? String(userAgent) : null,
    createdAt,
  };
}

function normalizePendingCandidates(rows) {
  return rows
    .map(normalizeDeviceRow)
    .filter(Boolean)
    .filter((entry) => entry.pending)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function isLocalAddress(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return false;
  if (v === "::1" || v === "[::1]" || v === "localhost") return true;
  if (v.startsWith("127")) return true;
  return false;
}

function isLoopbackPendingRequest(candidate) {
  if (!candidate) return false;
  const originHost = extractHostFromOrigin(candidate.origin || "");
  const ip = String(candidate.ip || "").trim();
  const originIsLocal = originHost ? isLoopbackHostname(originHost) : false;
  const ipIsLocal = ip ? isLocalAddress(ip) : true;
  return originIsLocal && ipIsLocal;
}

function parseDashboardUrlFromText(text) {
  if (!text) return null;
  const match = String(text).match(/https?:\/\/[^\s<>"'`]+/i);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/, "");
}

async function listDevicesViaCli() {
  const result = await runFixOpenclawCommand(["devices", "list", "--json"], { timeoutMs: 12_000 });
  if (!result.ok) {
    return {
      ok: false,
      result,
      devices: [],
    };
  }
  const parsed = parseJsonSafely(result.stdout);
  const devices = extractDevicesFromPayload(parsed).map(normalizeDeviceRow).filter(Boolean);
  return {
    ok: true,
    result,
    devices,
  };
}

function pickDeviceForMismatch(devices, { deviceHint = "", confirmation = null } = {}) {
  const rows = Array.isArray(devices) ? devices : [];
  const normalizedHint = String(deviceHint || "").trim().toLowerCase();
  const confirmationDeviceId = confirmation?.deviceId ? String(confirmation.deviceId).trim() : "";
  const confirmationRole = confirmation?.role ? String(confirmation.role).trim().toLowerCase() : "";

  if (confirmationDeviceId) {
    const selected = rows.find((row) => row.id === confirmationDeviceId);
    if (selected) {
      return {
        selected: {
          ...selected,
          role: confirmationRole || selected.role || "operator",
        },
        needsConfirmation: false,
      };
    }
  }

  if (normalizedHint) {
    const byHint = rows.find((row) => {
      const haystack = [row.id, row.name, row.role, row.origin, row.ip]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedHint);
    });
    if (byHint) {
      return { selected: byHint, needsConfirmation: false };
    }
  }

  const pairedOperators = rows.filter((row) => row.paired && row.role === "operator");
  if (pairedOperators.length === 1) {
    return {
      selected: pairedOperators[0],
      needsConfirmation: false,
    };
  }

  return {
    selected: null,
    needsConfirmation: true,
    candidates: pairedOperators.length > 0 ? pairedOperators : rows,
  };
}

function syncGatewayTokenToConfigPolicy() {
  const config = readConfig();
  if (!config) {
    return {
      ok: false,
      code: "not_configured",
      message: "설정 파일이 없어 토큰 동기화를 진행할 수 없어요",
    };
  }

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.auth) config.gateway.auth = {};

  const env = readEnv();
  const processToken = process.env.OPENCLAW_GATEWAY_TOKEN ? String(process.env.OPENCLAW_GATEWAY_TOKEN) : "";
  const envToken = env.OPENCLAW_GATEWAY_TOKEN ? String(env.OPENCLAW_GATEWAY_TOKEN) : processToken;
  const configToken = config.gateway.auth.token ? String(config.gateway.auth.token) : "";

  let changed = false;
  let chosenToken = configToken;

  if (!chosenToken && envToken) {
    chosenToken = envToken;
    config.gateway.auth.token = chosenToken;
    changed = true;
  }

  if (chosenToken && env.OPENCLAW_GATEWAY_TOKEN !== chosenToken) {
    env.OPENCLAW_GATEWAY_TOKEN = chosenToken;
    writeEnv(env);
    changed = true;
  }

  if (changed) writeConfig(config);
  return {
    ok: true,
    changed,
    tokenPreview: chosenToken ? `${chosenToken.slice(0, 4)}...${chosenToken.slice(-4)}` : "",
  };
}

async function maybeRunSystemdDaemonReload() {
  const which = await runCliCommand({
    command: "which",
    args: ["systemctl"],
    cwd: CONFIG_DIR,
    env: onboardingCliEnv(),
    timeoutMs: 4_000,
  });
  if (!which.ok) {
    return {
      ok: false,
      skipped: true,
      message: "systemctl 환경이 아니어서 daemon-reload를 건너뛰어요",
    };
  }

  const reload = await runCliCommand({
    command: "systemctl",
    args: ["--user", "daemon-reload"],
    cwd: CONFIG_DIR,
    env: onboardingCliEnv(),
    timeoutMs: 8_000,
  });

  if (!reload.ok) {
    return {
      ok: false,
      skipped: false,
      message: "systemd daemon-reload에 실패했어요",
      detail: tailStderr(reload.stderr || reload.stdout || ""),
    };
  }

  return {
    ok: true,
    skipped: false,
    message: "systemd daemon-reload를 완료했어요",
  };
}

async function runChannelsProbeLadder() {
  const attempts = [];

  const first = await runFixOpenclawCommand(["channels", "status", "--probe", "--json"], { timeoutMs: 12_000 });
  attempts.push({
    command: "channels status --probe --json",
    ok: first.ok,
    text: tailStderr(first.stderr || first.stdout || "", 8),
    json: first.ok ? parseJsonSafely(first.stdout) : null,
  });
  if (first.ok) return attempts;

  const second = await runFixOpenclawCommand(["channels", "status", "--probe"], { timeoutMs: 12_000 });
  attempts.push({
    command: "channels status --probe",
    ok: second.ok,
    text: tailStderr(second.stderr || second.stdout || "", 8),
    json: null,
  });

  const probe = await runFixOpenclawCommand(["gateway", "probe", "--json"], { timeoutMs: 10_000 });
  attempts.push({
    command: "gateway probe --json",
    ok: probe.ok,
    text: tailStderr(probe.stderr || probe.stdout || "", 8),
    json: probe.ok ? parseJsonSafely(probe.stdout) : null,
  });

  if (!probe.ok) {
    const status = await runFixOpenclawCommand(["gateway", "status", "--json"], { timeoutMs: 10_000 });
    attempts.push({
      command: "gateway status --json",
      ok: status.ok,
      text: tailStderr(status.stderr || status.stdout || "", 8),
      json: status.ok ? parseJsonSafely(status.stdout) : null,
    });
  }

  return attempts;
}

async function runFixOrchestrator({ origin = "", options = {}, confirmation = null } = {}) {
  const normalizedOrigin = normalizeOrigin(origin);
  const parsedOptions = parseFixOptions(options);
  const state = getFixStateSnapshot();
  const steps = [];
  let nextActions = [];

  const lastCloseCode = state?.lastClose?.code ?? null;
  const lastCloseReason = state?.lastClose?.reason || "";
  const diagnosis = diagnoseFixCategory({
    closeCode: lastCloseCode,
    closeReason: lastCloseReason,
    origin: normalizedOrigin,
    lastErrorCode: lastOnboardingErrorCode,
    gatewayRunning: Boolean(openclawProcess),
  });
  let category = parsedOptions.forceCategory || diagnosis.category;

  createFixStep(steps, {
    title: "진단",
    status: "info",
    message: `${FIX_DIAGNOSIS_LABELS[category] || FIX_DIAGNOSIS_LABELS.unknown} (${diagnosis.hint})`,
    details: {
      lastCloseCode,
      lastCloseReason,
      origin: normalizedOrigin || null,
    },
  });

  if (parsedOptions.hasAdvancedBypass) {
    createFixStep(steps, {
      title: "고급 임시 우회 적용",
      status: "info",
      message: "위험 옵션 임시 적용(30분)을 진행해요",
    });
    const bypassResult = await applyAdvancedBypass(parsedOptions.advancedBypass, { restartGateway: true });
    if (!bypassResult.ok) {
      createFixStep(steps, {
        title: "고급 임시 우회 적용",
        status: "error",
        message: bypassResult.error || "고급 임시 우회 적용에 실패했어요",
      });
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "임시 우회 적용에 실패했어요",
        steps,
        nextActions: ["설정 파일 권한과 OpenClaw 설정 상태를 확인한 뒤 다시 시도하세요"],
      });
    }
    createFixStep(steps, {
      title: "고급 임시 우회 적용",
      status: "ok",
      message: `임시 우회를 적용했고 자동 해제 시각은 ${bypassResult.expiresAt ? new Date(bypassResult.expiresAt).toLocaleString("ko-KR") : "없음"}`,
      details: {
        disableDeviceAuth: parsedOptions.advancedBypass.disableDeviceAuth,
        allowHostHeaderOriginFallback: parsedOptions.advancedBypass.allowHostHeaderOriginFallback,
      },
    });
  }

  const preHealth = await checkGatewayHealthSnapshot();
  createFixStep(steps, {
    title: "Gateway 상태 확인",
    status: preHealth.processRunning && preHealth.portOpen ? "ok" : "warn",
    message: preHealth.processRunning
      ? `프로세스 실행 중 (port ${preHealth.portOpen ? "열림" : "닫힘"})`
      : "프로세스가 중단되어 재시작을 시도해요",
    details: preHealth,
  });

  if (!preHealth.processRunning || !preHealth.portOpen) {
    const restarted = await restartOpenclawGateway();
    if (!restarted.ok) {
      createFixStep(steps, {
        title: "Gateway 재시작",
        status: "error",
        message: "게이트웨이 재시작 후 헬스체크가 실패했어요",
        details: restarted.snapshot || null,
      });
      return buildFixResult({
        status: "failed",
        category: "gateway_down",
        summaryKo: "게이트웨이 재시작에 실패했어요",
        steps,
        nextActions: ["서버 로그에서 gateway 프로세스 오류를 확인하고 수동으로 `openclaw gateway run`을 점검하세요"],
      });
    }
    category = category === "gateway_down" ? "gateway_down" : category;
    createFixStep(steps, {
      title: "Gateway 재시작",
      status: "ok",
      message: "게이트웨이 재시작과 헬스체크를 완료했어요",
    });
  }

  if (category === "insecure_http_device_identity_required") {
    nextActions = [
      "현재 주소가 HTTP라면 HTTPS(Serve/Funnel) 주소 또는 localhost/127.0.0.1로 접속하세요",
      "리버스 프록시 환경이면 브라우저 접속 Origin과 gateway 허용 Origin이 일치하는지 확인하세요",
    ];
    return buildFixResult({
      status: "route_change_required",
      category,
      summaryKo: "보안 컨텍스트(WebCrypto) 조건이 충족되지 않아 자동 수정 대신 접속 경로 변경이 필요해요",
      steps,
      nextActions,
    });
  }

  if (category === "pairing_required") {
    const listed = await listDevicesViaCli();
    if (!listed.ok) {
      createFixStep(steps, {
        title: "Pending 디바이스 조회",
        status: "error",
        message: "pending 디바이스 조회에 실패했어요",
        details: {
          stderr: tailStderr(listed.result?.stderr || listed.result?.stdout || ""),
        },
      });
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "페어링 요청을 확인하지 못했어요",
        steps,
        nextActions: ["`openclaw devices list`로 수동 확인 후 승인해 주세요"],
      });
    }

    const pending = normalizePendingCandidates(listed.devices);
    createFixStep(steps, {
      title: "Pending 디바이스 조회",
      status: "ok",
      message: `승인 대기 ${pending.length}건을 확인했어요`,
    });

    const hasApprovalConfirmation =
      confirmation &&
      confirmation.type === "pairing_approve" &&
      confirmation.approved === true;

    const localContext = isLocalOrigin(normalizedOrigin || confirmation?.origin || "");
    const canAutoApprove =
      localContext &&
      pending.length === 1 &&
      isLoopbackPendingRequest(pending[0]);

    if (!canAutoApprove && !hasApprovalConfirmation) {
      return buildFixResult({
        status: "needs_confirmation",
        category,
        summaryKo: "페어링 승인은 확인 후 진행해요",
        steps,
        confirmationRequest: {
          type: "pairing_approve",
          message: "승인 대기 디바이스를 확인한 뒤 승인할까요?",
          pending: pending.slice(0, 5),
        },
        nextActions: ["요청 origin/ip/user-agent를 확인한 뒤 승인하세요"],
      });
    }

    const approveResult = await runFixOpenclawCommand(["devices", "approve", "--latest"], { timeoutMs: 12_000 });
    if (!approveResult.ok) {
      createFixStep(steps, {
        title: "디바이스 승인",
        status: "error",
        message: "자동 승인에 실패했어요",
        details: {
          stderr: tailStderr(approveResult.stderr || approveResult.stdout || ""),
        },
      });
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "디바이스 승인 단계에서 실패했어요",
        steps,
        nextActions: ["`openclaw devices approve --latest`를 수동 실행해 주세요"],
      });
    }

    createFixStep(steps, {
      title: "디바이스 승인",
      status: "ok",
      message: "최신 pending 디바이스를 승인했으니 재연결을 시도하세요",
    });

    return buildFixResult({
      status: "recovered",
      category,
      summaryKo: "페어링 승인으로 연결 복구를 시도했어요",
      steps,
      nextActions: ["브라우저를 새로고침해 연결 상태를 확인하세요"],
    });
  }

  if (category === "origin_not_allowed") {
    const targetOrigin = normalizeOrigin(normalizedOrigin || confirmation?.origin || "");
    if (!targetOrigin) {
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "허용할 Origin을 확인하지 못했어요",
        steps,
        nextActions: ["설정 화면을 Origin 주소가 명확한 환경에서 다시 열어 시도하세요"],
      });
    }

    const allowConfirmed =
      confirmation &&
      confirmation.type === "origin_allow" &&
      confirmation.approved === true &&
      normalizeOrigin(confirmation.origin || targetOrigin) === targetOrigin;

    if (!allowConfirmed) {
      return buildFixResult({
        status: "needs_confirmation",
        category,
        summaryKo: "Origin 허용은 사용자 확인 후 진행돼요",
        steps,
        confirmationRequest: {
          type: "origin_allow",
          origin: targetOrigin,
          message: `이 주소를 허용 목록에 추가할까요? (${targetOrigin})`,
        },
        nextActions: ["Origin 허용 후 게이트웨이가 재시작돼요"],
      });
    }

    const config = readConfig();
    if (!config) {
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "설정 파일을 찾지 못해 Origin을 추가하지 못했어요",
        steps,
      });
    }
    if (!config.gateway) config.gateway = {};
    if (!config.gateway.controlUi) config.gateway.controlUi = {};

    const list = Array.isArray(config.gateway.controlUi.allowedOrigins) ? config.gateway.controlUi.allowedOrigins : [];
    const normalizedSet = new Set(
      list
        .map((entry) => normalizeOrigin(entry))
        .filter(Boolean)
    );
    const beforeSize = normalizedSet.size;
    normalizedSet.add(targetOrigin);
    config.gateway.controlUi.allowedOrigins = [...normalizedSet];
    writeConfig(config);

    createFixStep(steps, {
      title: "Origin 허용 목록 반영",
      status: normalizedSet.size > beforeSize ? "ok" : "info",
      message: normalizedSet.size > beforeSize ? "허용 목록에 Origin을 추가했어요" : "이미 허용 목록에 포함된 Origin예요",
      details: { origin: targetOrigin },
    });

    const restarted = await restartOpenclawGateway();
    if (!restarted.ok) {
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "Origin 반영 후 게이트웨이 재시작에 실패했어요",
        steps,
        nextActions: [
          "게이트웨이 로그를 확인하세요",
          "필요 시 고급 임시 우회(host header fallback)를 수동으로 사용하세요",
        ],
      });
    }

    return buildFixResult({
      status: "recovered",
      category,
      summaryKo: "Origin 허용 목록 반영 후 게이트웨이를 재시작했어요",
      steps,
      nextActions: ["브라우저를 새로고침하고 다시 연결을 확인하세요"],
    });
  }

  if (category === "device_token_mismatch") {
    const listed = await listDevicesViaCli();
    if (!listed.ok) {
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "디바이스 목록 조회에 실패해 토큰 불일치를 복구하지 못했어요",
        steps,
        nextActions: ["`openclaw devices list --json` 명령이 정상 동작하는지 확인하세요"],
      });
    }

    const selection = pickDeviceForMismatch(listed.devices, {
      deviceHint: parsedOptions.deviceHint,
      confirmation,
    });
    if (selection.needsConfirmation || !selection.selected) {
      return buildFixResult({
        status: "needs_confirmation",
        category,
        summaryKo: "토큰 회전 대상 디바이스 선택이 필요해요",
        steps,
        confirmationRequest: {
          type: "device_select",
          message: "토큰 회전/폐기할 디바이스를 선택하세요",
          candidates: (selection.candidates || []).slice(0, 8),
        },
      });
    }

    const target = selection.selected;
    const role = target.role || "operator";
    const rotate = await runFixOpenclawCommand(["devices", "rotate", "--device", target.id, "--role", role], {
      timeoutMs: 15_000,
    });
    if (rotate.ok) {
      createFixStep(steps, {
        title: "디바이스 토큰 회전",
        status: "ok",
        message: `디바이스(${target.id}) 토큰 회전을 완료했어요`,
      });
      const health = await waitForGatewayHealthy({ timeoutMs: 8_000 });
      if (health.ok) {
        return buildFixResult({
          status: "recovered",
          category,
          summaryKo: "디바이스 토큰 회전 후 연결 복구에 성공했어요",
          steps,
          nextActions: ["브라우저를 새로고침해 세션이 정상 복구됐는지 확인하세요"],
        });
      }
    }

    createFixStep(steps, {
      title: "디바이스 토큰 회전",
      status: "warn",
      message: "토큰 회전에 실패해 revoke + 재페어링 경로로 전환해요",
      details: {
        stderr: tailStderr(rotate.stderr || rotate.stdout || ""),
      },
    });

    const revoke = await runFixOpenclawCommand(["devices", "revoke", "--device", target.id, "--role", role], {
      timeoutMs: 15_000,
    });
    const dashboard = await runFixOpenclawCommand(["dashboard", "--no-open"], {
      timeoutMs: 12_000,
    });
    const dashboardUrl = parseDashboardUrlFromText(`${dashboard.stdout || ""}\n${dashboard.stderr || ""}`);

    if (!revoke.ok) {
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "rotate/revoke 모두 실패했어요",
        steps,
        nextActions: ["`openclaw devices revoke --device <id> --role <role>`를 수동 실행한 뒤 재페어링하세요"],
        dashboardUrl,
      });
    }

    createFixStep(steps, {
      title: "디바이스 revoke",
      status: "ok",
      message: "디바이스 토큰을 폐기해서 재페어링이 필요해요",
    });

    return buildFixResult({
      status: "reauth_required",
      category,
      summaryKo: "디바이스 토큰을 폐기했으니 재페어링을 진행해 주세요",
      steps,
      nextActions: [
        "브라우저 인증 화면에서 다시 승인/페어링하세요",
        "필요 시 dashboard --no-open으로 출력된 새 URL을 사용하세요",
      ],
      dashboardUrl,
    });
  }

  if (category === "gateway_token_mismatch") {
    const synced = syncGatewayTokenToConfigPolicy();
    if (!synced.ok) {
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: synced.message || "토큰 동기화에 실패했어요",
        steps,
      });
    }
    createFixStep(steps, {
      title: "게이트웨이 토큰 동기화",
      status: "ok",
      message: synced.changed ? "설정 기준으로 토큰을 동기화했어요" : "토큰 불일치가 감지되지 않았어요",
      details: { token: synced.tokenPreview || null },
    });

    const daemonReload = await maybeRunSystemdDaemonReload();
    createFixStep(steps, {
      title: "systemd 환경 동기화",
      status: daemonReload.ok ? "ok" : daemonReload.skipped ? "info" : "warn",
      message: daemonReload.message,
      details: daemonReload.detail ? { detail: daemonReload.detail } : null,
    });

    const restarted = await restartOpenclawGateway();
    if (!restarted.ok) {
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "토큰 동기화 후 게이트웨이 재시작에 실패했어요",
        steps,
        nextActions: ["실행 환경의 OPENCLAW_GATEWAY_TOKEN과 openclaw.json 값을 다시 확인하세요"],
      });
    }

    return buildFixResult({
      status: "recovered",
      category,
      summaryKo: "게이트웨이 토큰 정합화 후 재시작을 완료했어요",
      steps,
      nextActions: ["브라우저에서 다시 연결을 확인하세요"],
    });
  }

  if (category === "abnormal_closure") {
    const probeAttempts = await runChannelsProbeLadder();
    const anyProbeOk = probeAttempts.some((entry) => entry.ok);
    createFixStep(steps, {
      title: "채널 상태 점검",
      status: anyProbeOk ? "ok" : "warn",
      message: anyProbeOk
        ? "채널 점검 커맨드를 실행했어요"
        : "채널 점검 커맨드가 모두 실패했어요",
      details: { attempts: probeAttempts },
    });

    const doctor = await runFixOpenclawCommand(["doctor", "--non-interactive"], { timeoutMs: 20_000 });
    createFixStep(steps, {
      title: "Doctor 진단",
      status: doctor.ok ? "ok" : "warn",
      message: doctor.ok ? "기본 진단을 완료했어요" : "진단 명령이 실패했어요(자동 수리는 실행하지 않음)",
      details: {
        stderr: tailStderr(doctor.stderr || doctor.stdout || "", 8),
      },
    });

    if (parsedOptions.applyChannelMitigation) {
      const config = readConfig();
      if (config) {
        if (!config.gateway) config.gateway = {};
        if (!config.gateway.channelHealthCheckMinutes || Number(config.gateway.channelHealthCheckMinutes) < 10) {
          config.gateway.channelHealthCheckMinutes = 10;
          writeConfig(config);
          createFixStep(steps, {
            title: "채널 헬스체크 완화",
            status: "ok",
            message: "channelHealthCheckMinutes를 10으로 완화했어요",
          });
        } else {
          createFixStep(steps, {
            title: "채널 헬스체크 완화",
            status: "info",
            message: "이미 10분 이상으로 설정되어 있어요",
          });
        }
      }
    }

    const restarted = await restartOpenclawGateway();
    if (!restarted.ok) {
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: "채널 복구 후 게이트웨이 재시작에 실패했어요",
        steps,
        nextActions: ["gateway 로그에서 disconnect 원인을 확인하세요"],
      });
    }

    return buildFixResult({
      status: "recovered",
      category,
      summaryKo: "채널 점검과 게이트웨이 재시작을 완료했어요",
      steps,
      nextActions: parsedOptions.applyChannelMitigation
        ? ["완화 설정(10분)이 적용됐으니 안정화 여부를 모니터링하세요"]
        : ["필요하면 '채널 헬스체크 완화' 옵션을 켠 뒤 다시 실행하세요"],
    });
  }

  if (parsedOptions.runDoctorRepair) {
    const repairConfirmed = confirmation?.type === "doctor_repair" && confirmation?.approved === true;
    if (!repairConfirmed) {
      return buildFixResult({
        status: "needs_confirmation",
        category,
        summaryKo: "doctor --repair 실행 전 확인이 필요해요",
        steps,
        confirmationRequest: {
          type: "doctor_repair",
          message: "doctor --repair는 설정 키를 정리/삭제할 수 있으니 실행할까요?",
        },
      });
    }

    const repair = await runFixOpenclawCommand(["doctor", "--repair", "--yes", "--non-interactive"], {
      timeoutMs: FIX_DOCTOR_REPAIR_TIMEOUT_MS,
    });
    if (!repair.ok) {
      createFixStep(steps, {
        title: "고급 수리 실행",
        status: "error",
        message: repair.timedOut
          ? "복구 진단 수리 단계 시간 초과"
          : "doctor --repair 실행에 실패했어요",
        details: { stderr: tailStderr(repair.stderr || repair.stdout || "", 8), timedOut: repair.timedOut },
      });
      return buildFixResult({
        status: "failed",
        category,
        summaryKo: repair.timedOut
          ? "doctor --repair가 시간 초과로 중단됐어요"
          : "doctor --repair 실행에 실패했어요",
        steps,
        nextActions: ["백업 파일을 확인한 뒤 수동으로 doctor --repair를 점검하세요"],
      });
    }
    createFixStep(steps, {
      title: "고급 수리 실행",
      status: "ok",
      message: "doctor --repair를 완료했어요",
    });
  }

  const finalHealth = await waitForGatewayHealthy({ timeoutMs: 8_000 });
  if (finalHealth.ok) {
    return buildFixResult({
      status: "recovered",
      category: category || "unknown",
      summaryKo: "게이트웨이 상태가 정상으로 확인됐어요",
      steps,
      nextActions: ["문제가 다시 발생하면 최신 close code/reason과 함께 재실행하세요"],
    });
  }

  return buildFixResult({
    status: "failed",
    category: category || "unknown",
    summaryKo: "자동 복구 후에도 게이트웨이 상태가 정상으로 확인되지 않았어요",
    steps,
    nextActions: ["서버 로그를 확인하고 필요 시 수동 재시작을 진행하세요"],
  });
}

function getOnboardingStatePayload() {
  const active = getActiveInteractiveSnapshot();
  return {
    ok: true,
    configured: isConfigured(),
    onboardingInProgress: Boolean(terminalOnboardingPty || hasActiveInteractiveAuthSession()),
    interactiveAuthInProgress: hasActiveInteractiveAuthSession(),
    mode: terminalOnboardingPty ? "terminal" : "gui",
    lastErrorCode: lastOnboardingErrorCode,
    gatewayRunning: Boolean(openclawProcess),
    activeSessionId: active.activeSessionId,
    activeProviderId: active.activeProviderId,
    activeMethodId: active.activeMethodId,
    interactivePhase: active.interactivePhase,
    ts: Date.now(),
  };
}

function onboardingCliEnv() {
  const merged = {
    ...process.env,
    ...readEnv(),
  };
  merged.PATH = getEnvPath(merged);
  merged.OPENCLAW_HOME = OPENCLAW_HOME_DIR;
  merged.OPENCLAW_DATA_DIR = CONFIG_DIR;
  merged.OPENCLAW_CONFIG_PATH = CONFIG_FILE;
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
  const direct = interactiveAuthContexts.get(sessionId);
  if (direct) return direct;

  for (const candidate of interactiveAuthContexts.values()) {
    if (getInteractiveProcessSessionId(candidate) === sessionId) {
      return candidate;
    }
  }
  return null;
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b]8;;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/g, "$1 ")
    .replace(/\u001b]8;;(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function detectAuthUrl(buffer) {
  if (!buffer) return null;
  const text = String(buffer);
  const AUTH_URL_MIN_SCORE = 4;
  const contextualPatterns = [
    /Open this URL in your LOCAL browser:\s*(?:\r?\n|\s)*(https?:\/\/[^\s<>"'`]+)/i,
    /Open:\s*(https?:\/\/[^\s<>"'`]+)/i,
    /OAuth URL ready[\s\S]{0,600}?(https?:\/\/[^\s<>"'`]+)/i,
  ];

  const contextualCandidates = contextualPatterns
    .map((pattern) => text.match(pattern)?.[1] || null)
    .filter(Boolean)
    .map((url) => url.replace(/[),.;]+$/, ""));
  const allMatches = [...text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)].map((entry) => entry[0].replace(/[),.;]+$/, ""));
  const candidates = [...new Set([...contextualCandidates, ...allMatches])];

  if (candidates.length === 0) return null;

  let bestUrl = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const score = authUrlScore(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestUrl = candidate;
    }
  }

  if (!bestUrl || bestScore < AUTH_URL_MIN_SCORE) return null;
  return bestUrl;
}

function sendInteractiveSessionInput(sessionId, data) {
  if (!sessionId) return false;
  return authSessionManager.sendInput(sessionId, data);
}

function getInteractiveProcessSessionId(context, fallbackSessionId = "") {
  if (context && typeof context === "object") {
    const processSessionId =
      typeof context.processSessionId === "string" && context.processSessionId.trim()
        ? context.processSessionId.trim()
        : "";
    if (processSessionId) return processSessionId;
    const contextSessionId =
      typeof context.sessionId === "string" && context.sessionId.trim() ? context.sessionId.trim() : "";
    if (contextSessionId) return contextSessionId;
  }
  return typeof fallbackSessionId === "string" ? fallbackSessionId.trim() : "";
}

function shouldRetryInteractiveAuthWithQuickstart(context, failureMessage = "") {
  if (!context || context.commandMode !== "direct") return false;
  if (!context.fallbackCommand || context.fallbackCommand.commandMode !== "quickstart") return false;
  if (context.retryUsed) return false;
  if (context.authUrlReadyAt || context.authUrl || context.requiresRedirectInput) return false;

  return /(no provider plugins found|unknown provider|provider .*not found|unsupported provider|invalid provider)/i.test(
    String(failureMessage || "")
  );
}

function maybeAutoAdvanceInteractivePrompt(context) {
  if (!context || context.requiresRedirectInput || context.state === "awaiting_redirect_input") return;
  const buffer = String(context.outputBuffer || "");
  if (!buffer) return;

  if (!context.autoInputs || typeof context.autoInputs !== "object") {
    context.autoInputs = {};
  }

  if (
    !context.autoInputs.acceptRisk &&
    /personal-by-default/i.test(buffer) &&
    /Continue\?/i.test(buffer)
  ) {
    if (sendInteractiveSessionInput(getInteractiveProcessSessionId(context), "\r")) {
      context.autoInputs.acceptRisk = true;
      context.lastMessage = "기본 위험 확인 항목을 자동 승인했어요";
      return;
    }
  }

  if (!context.autoInputs.existingConfig && /Existing config detected/i.test(buffer)) {
    if (sendInteractiveSessionInput(getInteractiveProcessSessionId(context), "\r")) {
      context.autoInputs.existingConfig = true;
      context.lastMessage = "기존 설정을 감지해 기본값으로 계속 진행해요";
      return;
    }
  }

  if (
    !context.autoInputs.configHandling &&
    /Config handling/i.test(buffer) &&
    /(Use existing values|Update values|Keep values)/i.test(buffer)
  ) {
    if (sendInteractiveSessionInput(getInteractiveProcessSessionId(context), "\r")) {
      context.autoInputs.configHandling = true;
      context.lastMessage = "설정 처리 단계를 기본값으로 진행해요";
    }
  }

  if (
    !context.autoInputs.spaceSelectSubmit &&
    /press space to select,\s*enter to submit/i.test(buffer)
  ) {
    if (sendInteractiveSessionInput(getInteractiveProcessSessionId(context), " \r")) {
      context.autoInputs.spaceSelectSubmit = true;
      context.lastMessage = "선택 확인 단계를 기본값으로 자동 진행해요";
      return;
    }
  }

  if (!context.autoInputs.postAuthContinue && /press (enter|return) to continue/i.test(buffer)) {
    if (sendInteractiveSessionInput(getInteractiveProcessSessionId(context), "\r")) {
      context.autoInputs.postAuthContinue = true;
      context.lastMessage = "인증 완료 확인 단계를 자동 진행해요";
    }
  }
}

function authUrlScore(url) {
  if (!url) return 0;
  const normalized = String(url).toLowerCase();
  if (normalized.includes("localhost:1455") || normalized.includes("127.0.0.1:1455")) return -100;

  let score = 0;
  if (normalized.includes("auth.openai.com")) score += 7;
  if (normalized.includes("oauth/authorize") || normalized.includes("oauth2/authorize")) score += 6;
  if (normalized.includes("response_type=code")) score += 5;
  if (normalized.includes("code_challenge=")) score += 4;
  if (normalized.includes("redirect_uri=")) score += 3;
  if (normalized.includes("client_id=")) score += 2;
  if (normalized.includes("/login/device") || normalized.includes("/device/code") || normalized.includes("devicecode")) score += 4;
  if (normalized.includes("/consent")) score += 2;
  if (normalized.includes("/authorize")) score += 2;
  if (normalized.includes("/auth/")) score += 1;
  return score;
}

function updateInteractiveContextState(context, nextState, options = {}) {
  if (!context) return;
  context.state = nextState;
  if (Object.prototype.hasOwnProperty.call(options, "phase")) {
    context.lastPhase = options.phase ?? context.lastPhase;
  }
  if (Object.prototype.hasOwnProperty.call(options, "authUrl")) {
    context.authUrl = options.authUrl || context.authUrl || null;
  }
  if (Object.prototype.hasOwnProperty.call(options, "requiresRedirectInput")) {
    context.requiresRedirectInput = Boolean(options.requiresRedirectInput);
  }
  if (Object.prototype.hasOwnProperty.call(options, "lastMessage")) {
    context.lastMessage = options.lastMessage || context.lastMessage || null;
  }
  if (Object.prototype.hasOwnProperty.call(options, "lastErrorCode")) {
    context.lastErrorCode = options.lastErrorCode || null;
  }
}

function parseInteractiveOutput(context, data) {
  if (!context) return;

  const plain = stripAnsi(data);
  if (!plain) return;

  context.outputBuffer = `${context.outputBuffer || ""}${plain}`;
  if (context.outputBuffer.length > 60_000) {
    context.outputBuffer = context.outputBuffer.slice(-60_000);
  }

  const latestLine = plain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (latestLine) {
    context.lastMessage = latestLine;
  }

  maybeAutoAdvanceInteractivePrompt(context);

  const nextAuthUrl = detectAuthUrl(context.outputBuffer);
  if (nextAuthUrl) {
    const replaceAuthUrl = !context.authUrl || authUrlScore(nextAuthUrl) > authUrlScore(context.authUrl);
    if (replaceAuthUrl) {
      if (!context.authUrlReadyAt) {
        context.authUrlReadyAt = Date.now();
      }
      updateInteractiveContextState(context, "auth_url_ready", {
        authUrl: nextAuthUrl,
        requiresRedirectInput: false,
        lastMessage: "브라우저 인증 링크가 준비됐으니 로그인 후 돌아와 주세요",
      });
    }
  }

  const scanOffsetRaw = Number(context.redirectPromptScanOffset || 0);
  const scanOffset = Number.isFinite(scanOffsetRaw) && scanOffsetRaw > 0 ? Math.min(scanOffsetRaw, context.outputBuffer.length) : 0;
  const promptWindow = context.outputBuffer.slice(scanOffset);
  const redirectPromptDetected =
    /Paste the redirect URL/i.test(promptWindow) ||
    /paste.+redirect.+url/i.test(promptWindow) ||
    /paste.+callback.+url/i.test(promptWindow) ||
    /enter.+redirect.+url/i.test(promptWindow);

  if (redirectPromptDetected) {
    context.redirectPromptScanOffset = context.outputBuffer.length;
    updateInteractiveContextState(context, "awaiting_redirect_input", {
      requiresRedirectInput: true,
      lastMessage: "브라우저 로그인 완료 후 리디렉트 URL을 입력해 주세요",
    });
  }

  if (
    /OAuth complete/i.test(context.outputBuffer) ||
    /Auth profile:/i.test(context.outputBuffer) ||
    /authentication complete/i.test(context.outputBuffer) ||
    /logged in successfully/i.test(context.outputBuffer)
  ) {
    updateInteractiveContextState(context, "auth_completed", {
      lastMessage: "인증이 완료됐어요",
      requiresRedirectInput: false,
    });
  }
}

function buildInteractiveAuthStatusPayload(context) {
  const authUrlReadyLatencyMs =
    Number.isFinite(context?.authUrlReadyAt) && Number.isFinite(context?.createdAt)
      ? Math.max(0, context.authUrlReadyAt - context.createdAt)
      : undefined;

  return {
    ok: true,
    sessionId: context.sessionId,
    state: context.state || "starting",
    phase: context.lastPhase || null,
    authUrl: context.authUrl || null,
    requiresRedirectInput: Boolean(context.requiresRedirectInput),
    lastMessage: context.lastMessage || null,
    lastErrorCode: context.lastErrorCode || null,
    commandMode: context.commandMode || undefined,
    authUrlReadyLatencyMs,
    configured: isConfigured(),
    gatewayRunning: Boolean(openclawProcess),
    ts: Date.now(),
  };
}

function getMainAuthAgentDir() {
  return path.join(CONFIG_DIR, "agents", "main", "agent");
}

function settleDirectInteractiveContext(context, result) {
  if (!context || context.completed) return;
  const state = result?.state || "failed";
  const code = result?.code || (state === "timeout" ? "timeout" : state === "cancelled" ? "interactive_cancelled" : "cli_failed");
  const message = result?.message || "인증 세션을 완료하지 못했어요";

  updateInteractiveContextState(context, state, {
    lastErrorCode: state === "configured" ? null : code,
    lastMessage: message,
    requiresRedirectInput: false,
    phase:
      state === "configured"
        ? "configured"
        : state === "finalizing"
          ? "finalize_onboarding"
          : state === "auth_completed"
            ? "interactive_auth_completed"
            : context.lastPhase,
  });

  if (state === "configured") {
    broadcastContext(context, { type: "phase", phase: "configured" });
    broadcastContext(context, { type: "exit", code: 0, configured: true });
    lastOnboardingErrorCode = null;
  } else {
    if (result?.phase) {
      broadcastContext(context, { type: "phase", phase: result.phase });
    }
    broadcastContext(context, {
      type: "error",
      code,
      message,
    });
    broadcastContext(context, { type: "exit", code: 1, configured: false });
    lastOnboardingErrorCode = code;
  }

  context.completed = true;
  context.resolveManualInput = null;
  context.rejectManualInput = null;
  finalizeContextLater(context.sessionId);
}

function cancelDirectInteractiveContext(context, reason = "interactive_cancelled") {
  if (!context || context.strategy !== "openai_direct") return false;
  const code = reason === "timeout" ? "timeout" : "interactive_cancelled";
  const message = reason === "timeout" ? "인증 세션 시간이 초과됐어요" : "인증 세션이 취소됐어요";
  try {
    if (typeof context.rejectManualInput === "function") {
      const error = new Error(message);
      error.code = code;
      context.rejectManualInput(error);
    }
  } catch {}
  settleDirectInteractiveContext(context, {
    state: reason === "timeout" ? "timeout" : "cancelled",
    code,
    message,
  });
  return true;
}

async function startOpenAICodexDirectInteractiveFlow({ providerId, methodId, method, maskValues }) {
  const modules = await loadOpenAICodexDirectModules();
  ensureConfigDir();
  fs.mkdirSync(getMainAuthAgentDir(), { recursive: true });

  const sessionId = crypto.randomUUID();
  const context = {
    sessionId,
    processSessionId: sessionId,
    strategy: "openai_direct",
    providerId,
    methodId,
    method,
    clients: new Set(),
    lastPhase: "interactive_auth_started",
    lastEvent: null,
    createdAt: Date.now(),
    completed: false,
    state: "starting",
    authUrl: null,
    requiresRedirectInput: false,
    lastMessage: "인증 세션을 시작했어요",
    lastErrorCode: null,
    outputBuffer: "",
    autoInputs: {},
    commandMode: "quickstart",
    fallbackCommand: null,
    retryUsed: false,
    authUrlReadyAt: null,
    redirectPromptScanOffset: 0,
    resolveManualInput: null,
    rejectManualInput: null,
  };

  interactiveAuthContexts.set(sessionId, context);
  updateInteractiveContextState(context, "starting", {
    phase: "interactive_auth_started",
    lastMessage: "인증 세션을 시작했어요",
  });
  broadcastContext(context, { type: "phase", phase: "interactive_auth_started" });

  const manualInputPromise = new Promise((resolve, reject) => {
    context.resolveManualInput = resolve;
    context.rejectManualInput = reject;
  });

  context.runPromise = (async () => {
    try {
      const creds = await modules.loginOpenAICodex({
        onAuth: ({ url }) => {
          if (context.completed) return;
          if (!context.authUrlReadyAt) context.authUrlReadyAt = Date.now();
          updateInteractiveContextState(context, "auth_url_ready", {
            authUrl: url,
            requiresRedirectInput: false,
            lastMessage: "브라우저 인증 링크가 준비됐으니 로그인 후 돌아와 주세요",
          });
        },
        onPrompt: async () => {
          if (context.completed) {
            throw Object.assign(new Error("interactive auth session cancelled"), { code: "interactive_cancelled" });
          }
          updateInteractiveContextState(context, "awaiting_redirect_input", {
            requiresRedirectInput: true,
            lastMessage: "브라우저 로그인 완료 후 리디렉트 URL을 입력해 주세요",
          });
          return await manualInputPromise;
        },
        onProgress: (message) => {
          if (!context.completed && message) {
            context.lastMessage = maskSecrets(String(message), maskValues);
          }
        },
        onManualCodeInput: async () => {
          if (context.completed) {
            throw Object.assign(new Error("interactive auth session cancelled"), { code: "interactive_cancelled" });
          }
          updateInteractiveContextState(context, "awaiting_redirect_input", {
            requiresRedirectInput: true,
            lastMessage: "브라우저 로그인 완료 후 리디렉트 URL을 입력해 주세요",
          });
          return await manualInputPromise;
        },
      });

      if (context.completed) return;

      updateInteractiveContextState(context, "auth_completed", {
        phase: "interactive_auth_completed",
        lastMessage: "인증이 완료됐어요",
        requiresRedirectInput: false,
      });
      broadcastContext(context, { type: "phase", phase: "interactive_auth_completed" });
      updateInteractiveContextState(context, "finalizing", {
        phase: "finalize_onboarding",
        lastMessage: "설정을 마무리하고 있어요",
        requiresRedirectInput: false,
      });
      broadcastContext(context, { type: "phase", phase: "finalize_onboarding" });

      const profileId = await modules.writeOAuthCredentials("openai-codex", creds, getMainAuthAgentDir(), {
        syncSiblingAgents: true,
      });
      let config = applyOpenAICodexDirectDefaults(readConfig() || {}, providerId, methodId);
      config = modules.applyAuthProfileConfig(config, {
        profileId,
        provider: "openai-codex",
        mode: "oauth",
      });
      writeConfig(config);

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
        settleDirectInteractiveContext(context, {
          state: failure.code === "timeout" ? "timeout" : "failed",
          code: failure.code,
          message: failure.message,
        });
        return;
      }

      const finalizedConfig = applyOpenAICodexDirectDefaults(readConfig() || config, providerId, methodId);
      writeConfig(finalizedConfig);
      reconcileConfig();
      if (isConfigured()) startOpenclaw();

      settleDirectInteractiveContext(context, {
        state: "configured",
        message: "인증 및 설정이 완료됐어요",
      });
    } catch (error) {
      if (context.completed) return;
      const code = error?.code === "timeout" ? "timeout" : error?.code === "interactive_cancelled" ? "interactive_cancelled" : "cli_failed";
      settleDirectInteractiveContext(context, {
        state: code === "timeout" ? "timeout" : code === "interactive_cancelled" ? "cancelled" : "failed",
        code,
        message: maskSecrets(error?.message || "interactive auth command failed", maskValues),
      });
    }
  })();

  return context;
}

function sendWsMessage(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function broadcastContext(context, message) {
  if (!context) return;
  if (message.type === "phase") {
    context.lastPhase = message.phase || context.lastPhase;
  }
  if (message.type === "error" || message.type === "exit") {
    context.lastEvent = message;
  }
  if (message.type === "error") {
    context.lastErrorCode = message.code || context.lastErrorCode || "cli_failed";
    context.lastMessage = message.message || context.lastMessage || "인증 세션에서 문제가 생겼어요";
  }

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

function summarizeInteractiveFailure(context, maskValues = []) {
  const buffer = maskSecrets(String(context?.outputBuffer || ""), maskValues);
  const lines = tailStderr(buffer, 30)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "interactive auth command failed";

  const prioritized = lines.filter((line) =>
    /(error|failed|requires|not found|unauthorized|forbidden|timeout|invalid|no provider plugins found)/i.test(line)
  );
  return prioritized.at(-1) || lines.at(-1) || "interactive auth command failed";
}

function sendRuntimeError(res, result, fallbackStatus = 502) {
  const code = result?.code || "cli_failed";
  const message = result?.error || "runtime operation failed";
  const statusMap = {
    invalid_input: 422,
    not_configured: 409,
    gateway_unavailable: 503,
    feature_unavailable: 501,
    feature_contract_unsupported: 409,
    contract_unavailable: 409,
    feature_catalog_failed: 502,
    feature_catalog_invalid: 502,
    feature_toggle_failed: 502,
    feature_disabled: 409,
    feature_unsupported: 409,
    feature_state_mismatch: 409,
    feature_confirmation_missing: 409,
    model_auth_failed: 401,
    timeout: 504,
    cli_failed: 502,
  };
  const status = statusMap[code] || fallbackStatus;
  return sendJson(res, status, {
    ok: false,
    code,
    error: message,
    details: result?.details || null,
  });
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
    if (method.id === "openai-codex") {
      try {
        const context = await startOpenAICodexDirectInteractiveFlow({
          providerId,
          methodId,
          method,
          maskValues,
        });
        lastOnboardingErrorCode = null;
        return sendJson(res, 200, {
          ok: true,
          status: "interactive_required",
          sessionId: context.sessionId,
          auth: {
            state: context.state,
            authUrl: context.authUrl,
            commandMode: context.commandMode,
          },
        });
      } catch (error) {
        lastOnboardingErrorCode = "cli_failed";
        return sendJson(res, 502, {
          ok: false,
          code: "cli_failed",
          error: maskSecrets(error?.message || "failed to start interactive session", maskValues),
        });
      }
    }

    const interactiveCommand = buildInteractiveAuthCommand({
      openclawPort: OPENCLAW_PORT,
      method,
    });
    const startInteractiveProcess = (commandConfig) => {
      const invocation = resolveOpenclawInvocation(commandConfig.args, onboardingCliEnv());
      return authSessionManager.startSession({
        command: invocation.command,
        args: invocation.args,
        cwd: CONFIG_DIR,
        env: onboardingCliEnv(),
        cols: 220,
        rows: 40,
      });
    };

    let session;
    try {
      session = startInteractiveProcess(interactiveCommand);
    } catch (error) {
      lastOnboardingErrorCode = "cli_failed";
      let baseMessage = error?.message || "failed to start interactive session";
      if (error?.code === "SPAWN_FAILED") {
        if (/enoent|not found|no such file|command not found/i.test(String(error?.message || ""))) {
          baseMessage = "openclaw CLI executable not found. Install openclaw or set OPENCLAW_BIN.";
        }
      }
      return sendJson(res, 502, {
        ok: false,
        code: "cli_failed",
        error: maskSecrets(baseMessage, maskValues),
      });
    }

    const context = {
      sessionId: session.sessionId,
      processSessionId: session.sessionId,
      providerId,
      methodId,
      method,
      clients: new Set(),
      lastPhase: "interactive_auth_started",
      lastEvent: null,
      createdAt: Date.now(),
      completed: false,
      state: "starting",
      authUrl: null,
      requiresRedirectInput: false,
      lastMessage: "인증 세션을 시작했어요",
      lastErrorCode: null,
      outputBuffer: "",
      autoInputs: {},
      commandMode: interactiveCommand.commandMode === "direct" ? "direct" : "quickstart",
      fallbackCommand: interactiveCommand.fallback || null,
      retryUsed: false,
      authUrlReadyAt: null,
      redirectPromptScanOffset: 0,
    };

    interactiveAuthContexts.set(session.sessionId, context);
    const attachInteractiveSession = (sessionHandle, commandConfig) => {
      context.processSessionId = sessionHandle.sessionId;
      context.commandMode = commandConfig?.commandMode === "direct" ? "direct" : "quickstart";

      sessionHandle.events.on("output", (data) => {
        parseInteractiveOutput(context, data);
        broadcastContext(context, { type: "output", data });
      });

      sessionHandle.exitPromise
        .then(async ({ exitCode, reason }) => {
          const cancelled = reason === "interactive_cancelled" || reason === "interactive_replaced";
          const timeout = reason === "timeout";

          if (cancelled) {
            lastOnboardingErrorCode = "interactive_cancelled";
            updateInteractiveContextState(context, "cancelled", {
              lastErrorCode: "interactive_cancelled",
              lastMessage: "인증 세션이 취소됐어요",
            });
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
            updateInteractiveContextState(context, "timeout", {
              lastErrorCode: "timeout",
              lastMessage: "인증 세션 시간이 초과됐어요",
            });
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
            const summarized = summarizeInteractiveFailure(context, maskValues);
            const failureMessage =
              summarized && summarized !== "interactive auth command failed"
                ? summarized
                : `interactive auth command failed (exit ${exitCode ?? 1})`;

            if (shouldRetryInteractiveAuthWithQuickstart(context, failureMessage)) {
              context.retryUsed = true;
              context.outputBuffer = "";
              context.authUrl = null;
              context.authUrlReadyAt = null;
              context.requiresRedirectInput = false;
              context.redirectPromptScanOffset = 0;
              context.autoInputs = {};
              updateInteractiveContextState(context, "starting", {
                phase: "interactive_auth_retrying",
                authUrl: null,
                requiresRedirectInput: false,
                lastErrorCode: null,
                lastMessage: "현재 OpenClaw 설치와 direct 인증 경로가 호환되지 않아 quickstart 경로로 다시 시도해요",
              });
              broadcastContext(context, { type: "phase", phase: "interactive_auth_retrying" });

              try {
                const retrySession = startInteractiveProcess(context.fallbackCommand);
                attachInteractiveSession(retrySession, context.fallbackCommand);
                return;
              } catch (error) {
                lastOnboardingErrorCode = "cli_failed";
                const retryMessage = maskSecrets(error?.message || failureMessage, maskValues);
                updateInteractiveContextState(context, "failed", {
                  lastErrorCode: "cli_failed",
                  lastMessage: retryMessage,
                });
                broadcastContext(context, {
                  type: "error",
                  code: "cli_failed",
                  message: retryMessage,
                });
                broadcastContext(context, { type: "exit", code: exitCode ?? 1, configured: false });
                context.completed = true;
                finalizeContextLater(context.sessionId);
                return;
              }
            }

            lastOnboardingErrorCode = "cli_failed";
            updateInteractiveContextState(context, "failed", {
              lastErrorCode: "cli_failed",
              lastMessage: failureMessage,
            });
            broadcastContext(context, {
              type: "error",
              code: "cli_failed",
              message: failureMessage,
            });
            broadcastContext(context, { type: "exit", code: exitCode ?? 1, configured: false });
            context.completed = true;
            finalizeContextLater(context.sessionId);
            return;
          }

          updateInteractiveContextState(context, "auth_completed", {
            phase: "interactive_auth_completed",
            lastMessage: "인증이 완료됐어요",
            requiresRedirectInput: false,
          });
          broadcastContext(context, { type: "phase", phase: "interactive_auth_completed" });
          updateInteractiveContextState(context, "finalizing", {
            phase: "finalize_onboarding",
            lastMessage: "설정을 마무리하고 있어요",
          });
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
            updateInteractiveContextState(context, failure.code === "timeout" ? "timeout" : "failed", {
              lastErrorCode: failure.code,
              lastMessage: failure.message,
            });
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
          updateInteractiveContextState(context, "configured", {
            phase: "configured",
            lastMessage: "인증 및 설정이 완료됐어요",
            requiresRedirectInput: false,
            lastErrorCode: null,
          });
          broadcastContext(context, { type: "phase", phase: "configured" });
          broadcastContext(context, { type: "exit", code: 0, configured: true });
          context.completed = true;
          finalizeContextLater(context.sessionId);
        })
        .catch((error) => {
          lastOnboardingErrorCode = "cli_failed";
          updateInteractiveContextState(context, "failed", {
            lastErrorCode: "cli_failed",
            lastMessage: maskSecrets(error.message || "interactive flow failed", maskValues),
          });
          broadcastContext(context, {
            type: "error",
            code: "cli_failed",
            message: maskSecrets(error.message || "interactive flow failed", maskValues),
          });
          broadcastContext(context, { type: "exit", code: 1, configured: false });
          context.completed = true;
          finalizeContextLater(context.sessionId);
        });
    };

    attachInteractiveSession(session, interactiveCommand);

    updateInteractiveContextState(context, "starting", {
      phase: "interactive_auth_started",
      lastMessage: "인증 세션을 시작했어요",
    });
    broadcastContext(context, { type: "phase", phase: "interactive_auth_started" });

    lastOnboardingErrorCode = null;
    return sendJson(res, 200, {
      ok: true,
      status: "interactive_required",
      sessionId: session.sessionId,
      auth: {
        state: context.state,
        authUrl: context.authUrl,
        commandMode: context.commandMode,
      },
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
const runtimeRunsWss = new WebSocket.Server({ noServer: true });

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
        if (context.strategy === "openai_direct") {
          if (typeof context.resolveManualInput === "function") {
            const text = String(msg.data || "");
            context.resolveManualInput(text);
            context.resolveManualInput = null;
            context.rejectManualInput = null;
            updateInteractiveContextState(context, "finalizing", {
              requiresRedirectInput: false,
              lastMessage: "리디렉트 URL을 전달했고 인증 완료를 확인하고 있어요",
            });
          }
        } else {
          authSessionManager.sendInput(getInteractiveProcessSessionId(context, sessionId), String(msg.data || ""));
        }
      } else if (msg.type === "resize") {
        if (context.strategy !== "openai_direct") {
          authSessionManager.resizeSession(
            getInteractiveProcessSessionId(context, sessionId),
            Number(msg.cols) || 96,
            Number(msg.rows) || 30
          );
        }
      } else if (msg.type === "cancel") {
        if (context.strategy === "openai_direct") {
          cancelDirectInteractiveContext(context, "interactive_cancelled");
        } else {
          authSessionManager.cancelSession(getInteractiveProcessSessionId(context, sessionId), "interactive_cancelled");
        }
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

runtimeRunsWss.on("connection", async (ws, req) => {
  const url = parseRequestUrl(req);
  const runId = url.searchParams.get("runId");

  runtimeWsBroker.addClient(ws, { runId });

  const runsResult = await runtimeAdapter.listRuns();
  if (runsResult.ok) {
    let run = null;
    if (runId) {
      const detailResult = await runtimeAdapter.getRun(runId);
      if (detailResult.ok) run = detailResult.run;
    }
    sendWsMessage(ws, {
      type: "snapshot",
      items: canonicalizeRunItems(runsResult.items || []),
      run: run || null,
      ts: Date.now(),
    });
  } else {
    sendWsMessage(ws, {
      type: "error",
      code: runsResult.code || "cli_failed",
      message: runsResult.error || "failed to initialize runtime stream",
    });
  }
});

const server = http.createServer(async (req, res) => {
  const url = parseRequestUrl(req);
  const { pathname, search } = url;

  if (pathname === "/api/ui/health" && req.method === "GET") {
    const active = getActiveInteractiveSnapshot();
    return sendJson(res, 200, {
      ok: true,
      service: "openclaw-ui-gateway",
      configured: isConfigured(),
      gatewayRunning: Boolean(openclawProcess),
      onboardingInProgress: Boolean(terminalOnboardingPty || hasActiveInteractiveAuthSession()),
      interactiveAuthInProgress: hasActiveInteractiveAuthSession(),
      lastErrorCode: lastOnboardingErrorCode,
      activeSessionId: active.activeSessionId,
      activeProviderId: active.activeProviderId,
      activeMethodId: active.activeMethodId,
      interactivePhase: active.interactivePhase,
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

  if (pathname === "/api/ui/onboarding/validate-key" && req.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, { ok: false, code: "invalid_input", error: "invalid json body" });
    }

    const providerId = typeof payload?.providerId === "string" ? payload.providerId.trim() : "";
    const methodId = typeof payload?.methodId === "string" ? payload.methodId.trim() : "";
    const credentials = payload?.credentials && typeof payload.credentials === "object" ? payload.credentials : {};

    if (!providerId || !methodId) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "providerId and methodId are required",
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
    if (method.mode !== "non_interactive") {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "validate-key supports non_interactive methods only",
      });
    }

    try {
      const result = await validateApiKeySoft({
        providerId,
        method,
        credentials,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      const code = error?.code || "invalid_input";
      return sendJson(res, code === "invalid_input" ? 422 : 502, {
        ok: false,
        code,
        error: error.message || "failed to validate key",
      });
    }
  }

  if (pathname === "/api/ui/onboarding/apply" && req.method === "POST") {
    return handleOnboardingApply(req, res);
  }

  const authStatusMatch = pathname.match(/^\/api\/ui\/onboarding\/auth\/([A-Za-z0-9-]+)\/status$/);
  if (authStatusMatch && req.method === "GET") {
    const sessionId = authStatusMatch[1];
    const context = getInteractiveContext(sessionId);
    if (!context) {
      return sendJson(res, 404, {
        ok: false,
        code: "invalid_input",
        error: "interactive session not found",
      });
    }

    if (
      !context.completed &&
      context.state === "starting" &&
      !context.authUrl &&
      Date.now() - context.createdAt >= OAUTH_STATUS_AUTH_URL_TIMEOUT_MS
    ) {
      updateInteractiveContextState(context, "timeout", {
        lastErrorCode: "timeout",
        lastMessage: "인증 링크 준비 시간이 초과돼서 다시 시도해 주세요",
      });
      if (context.strategy === "openai_direct") {
        cancelDirectInteractiveContext(context, "timeout");
      } else {
        authSessionManager.cancelSession(getInteractiveProcessSessionId(context, sessionId), "timeout");
      }
    }

    return sendJson(res, 200, buildInteractiveAuthStatusPayload(context));
  }

  const authInputMatch = pathname.match(/^\/api\/ui\/onboarding\/auth\/([A-Za-z0-9-]+)\/input$/);
  if (authInputMatch && req.method === "POST") {
    const sessionId = authInputMatch[1];
    const context = getInteractiveContext(sessionId);
    if (!context) {
      return sendJson(res, 404, {
        ok: false,
        code: "invalid_input",
        error: "interactive session not found",
      });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, { ok: false, code: "invalid_input", error: "invalid json body" });
    }

    const preserveWhitespace = Boolean(payload?.preserveWhitespace);
    const rawText = typeof payload?.text === "string" ? payload.text : "";
    const text = preserveWhitespace ? rawText : rawText.trim();
    if (!text) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "text is required",
      });
    }

    let accepted = false;
    if (context.strategy === "openai_direct") {
      if (typeof context.resolveManualInput === "function") {
        context.resolveManualInput(text);
        context.resolveManualInput = null;
        context.rejectManualInput = null;
        accepted = true;
      }
    } else {
      accepted = authSessionManager.sendInput(getInteractiveProcessSessionId(context, sessionId), `${text}\r`);
    }
    if (!accepted) {
      return sendJson(res, 409, {
        ok: false,
        code: "gateway_unavailable",
        error: "interactive session is no longer active",
      });
    }

    if (preserveWhitespace) {
      updateInteractiveContextState(context, context.state || "finalizing", {
        requiresRedirectInput: false,
        lastMessage: "추가 확인 단계를 진행하고 있어요",
      });
    } else {
      context.redirectPromptScanOffset = String(context.outputBuffer || "").length;
      updateInteractiveContextState(context, "finalizing", {
        requiresRedirectInput: false,
        lastMessage: "리디렉트 URL을 전달했고 인증 완료를 확인하고 있어요",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      accepted: true,
    });
  }

  const authCancelMatch = pathname.match(/^\/api\/ui\/onboarding\/auth\/([A-Za-z0-9-]+)\/cancel$/);
  if (authCancelMatch && req.method === "POST") {
    const sessionId = authCancelMatch[1];
    const context = getInteractiveContext(sessionId);
    if (!context) {
      return sendJson(res, 404, {
        ok: false,
        code: "invalid_input",
        error: "interactive session not found",
      });
    }

    updateInteractiveContextState(context, "cancelled", {
      lastErrorCode: "interactive_cancelled",
      lastMessage: "인증 세션이 취소됐어요",
    });

    const cancelled =
      context.strategy === "openai_direct"
        ? cancelDirectInteractiveContext(context, "interactive_cancelled")
        : authSessionManager.cancelSession(getInteractiveProcessSessionId(context, sessionId), "interactive_cancelled");
    if (!cancelled) {
      return sendJson(res, 409, {
        ok: false,
        code: "gateway_unavailable",
        error: "interactive session is no longer active",
      });
    }

    lastOnboardingErrorCode = "interactive_cancelled";
    return sendJson(res, 200, {
      ok: true,
      status: "cancelled",
      sessionId,
    });
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
        : getActiveInteractiveSnapshot().activeSessionId;

    if (!sessionId) {
      return sendJson(res, 404, {
        ok: false,
        code: "invalid_input",
        error: "interactive session not found",
      });
    }

    const context = getInteractiveContext(sessionId);
    if (context) {
      updateInteractiveContextState(context, "cancelled", {
        lastErrorCode: "interactive_cancelled",
        lastMessage: "인증 세션이 취소됐어요",
      });
    }

    const cancelled =
      context?.strategy === "openai_direct"
        ? cancelDirectInteractiveContext(context, "interactive_cancelled")
        : authSessionManager.cancelSession(getInteractiveProcessSessionId(context, sessionId), "interactive_cancelled");
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

  if (pathname === "/api/ui/runtime/home" && req.method === "GET") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    if (!openclawProcess && !openclawStarting) startOpenclaw();

    const runsResult = await runtimeAdapter.listRuns();
    if (!runsResult.ok) return sendRuntimeError(res, runsResult);

    const usage = runtimeAdapter.queryUsage({
      from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      limit: 500,
    });
    return sendJson(res, 200, buildRuntimeHomePayload(canonicalizeRunItems(runsResult.items || []), usage.summary));
  }

  if (pathname === "/api/ui/runtime/conversations" && req.method === "GET") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }
    if (!openclawProcess && !openclawStarting) startOpenclaw();
    return sendJson(res, 200, {
      ok: true,
      items: generalConversationRuntime.listConversations(),
    });
  }

  const conversationAttachmentMatch = pathname.match(/^\/api\/ui\/runtime\/attachments\/([^/]+)$/);
  if (conversationAttachmentMatch && req.method === "GET") {
    const attachmentId = decodeURIComponent(conversationAttachmentMatch[1]);
    const meta = readAttachmentMeta(attachmentId);
    if (!meta) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("attachment not found");
      return;
    }
    const filePath = path.join(RUNTIME_ATTACHMENT_DIR, `${meta.id}.bin`);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("attachment not found");
      return;
    }
    const contentDisposition = `inline; filename*=UTF-8''${encodeURIComponent(meta.filename)}`;
    res.writeHead(200, {
      "Content-Type": meta.mime,
      "Content-Length": fs.statSync(filePath).size,
      "Content-Disposition": contentDisposition,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (pathname === "/api/ui/runtime/conversations" && req.method === "POST") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }
    if (!openclawProcess && !openclawStarting) startOpenclaw();

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const { prompt, title, sourceAction, attachments } = normalizeConversationPayload(payload);
    let normalizedAttachments = [];
    try {
      normalizedAttachments = persistConversationAttachments(attachments, req);
    } catch (error) {
      return sendJson(res, 422, {
        ok: false,
        code: error?.code || "invalid_attachment",
        error: error?.message || "첨부 파일을 처리하지 못했어요",
      });
    }
    if (!prompt && normalizedAttachments.length === 0) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "prompt or attachments are required",
      });
    }

    const created = await generalConversationRuntime.createConversation({
      prompt,
      title,
      sourceAction,
      attachments: normalizedAttachments,
    });
    if (!created.ok) {
      return sendJson(res, created.code === "invalid_input" ? 422 : 500, created);
    }
    return sendJson(res, 200, created);
  }

  const conversationDetailMatch = pathname.match(/^\/api\/ui\/runtime\/conversations\/([^/]+)$/);
  if (conversationDetailMatch && req.method === "GET") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }
    const conversationId = decodeURIComponent(conversationDetailMatch[1]);
    const existing = runtimeStore.getConversationRecord(conversationId);
    const conversation =
      String(existing?.kind || "") === "planning"
        ? planningConversationRuntime.getConversation(conversationId)
        : generalConversationRuntime.getConversation(conversationId);
    if (!conversation) {
      return sendJson(res, 404, {
        ok: false,
        code: "invalid_input",
        error: "conversation not found",
      });
    }
    return sendJson(res, 200, {
      ok: true,
      conversation,
    });
  }

  if (conversationDetailMatch && req.method === "PATCH") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const conversationId = decodeURIComponent(conversationDetailMatch[1]);
    const existing = runtimeStore.getConversationRecord(conversationId);
    const isPlanningConversation = String(existing?.kind || "") === "planning";
    const nextTitle = typeof payload?.title === "string" ? payload.title.trim() : "";
    if (nextTitle) {
      if (!existing) {
        return sendJson(res, 404, {
          ok: false,
          code: "invalid_input",
          error: "conversation not found",
        });
      }
      const renamed = runtimeStore.patchConversation(conversationId, {
        title: nextTitle.slice(0, 72),
      });
      if (!renamed) {
        return sendJson(res, 404, {
          ok: false,
          code: "invalid_input",
          error: "conversation not found",
        });
      }
      return sendJson(res, 200, {
        ok: true,
        conversation: renamed,
      });
    }
    const updated = isPlanningConversation
      ? planningConversationRuntime.updateConversation(conversationId, normalizeConversationPayload(payload))
      : generalConversationRuntime.updateConversation(conversationId, payload);
    if (!updated.ok) {
      return sendJson(res, updated.code === "invalid_input" ? 422 : 500, updated);
    }
    return sendJson(res, 200, updated);
  }

  const conversationMessageMatch = pathname.match(/^\/api\/ui\/runtime\/conversations\/([^/]+)\/messages$/);
  if (conversationMessageMatch && req.method === "POST") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }
    if (!openclawProcess && !openclawStarting) startOpenclaw();

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const conversationId = decodeURIComponent(conversationMessageMatch[1]);
    const existing = runtimeStore.getConversationRecord(conversationId);
    const isPlanningConversation = String(existing?.kind || "") === "planning";
    const { text, templateAnswers, followupAnswers, attachments } = normalizeConversationPayload(payload);
    let normalizedAttachments = [];
    try {
      normalizedAttachments = persistConversationAttachments(attachments, req);
    } catch (error) {
      return sendJson(res, 422, {
        ok: false,
        code: error?.code || "invalid_attachment",
        error: error?.message || "첨부 파일을 처리하지 못했어요",
      });
    }
    if (!text && normalizedAttachments.length === 0 && Object.keys(templateAnswers).length === 0 && Object.keys(followupAnswers).length === 0) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "text, attachments, or answers are required",
      });
    }

    const replied = isPlanningConversation
      ? await planningConversationRuntime.sendMessage(conversationId, {
          text,
          templateAnswers,
          followupAnswers,
        })
      : await generalConversationRuntime.sendMessage(conversationId, {
          text,
          attachments: normalizedAttachments,
        });
    if (!replied.ok) {
      return sendJson(res, replied.code === "invalid_input" ? 422 : 500, replied);
    }
    return sendJson(res, 200, replied);
  }

  const conversationCommitMatch = pathname.match(/^\/api\/ui\/runtime\/conversations\/([^/]+)\/commit$/);
  if (conversationCommitMatch && req.method === "POST") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }
    if (!openclawProcess && !openclawStarting) startOpenclaw();
    const conversationId = decodeURIComponent(conversationCommitMatch[1]);
    const existing = runtimeStore.getConversationRecord(conversationId);
    if (String(existing?.kind || "") !== "planning") {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "general chat conversation cannot commit",
      });
    }
    const committed = await planningConversationRuntime.commitConversation(conversationId);
    if (!committed.ok) {
      return sendJson(res, committed.code === "invalid_input" ? 422 : 500, committed);
    }
    return sendJson(res, 200, committed);
  }

  if (pathname === "/api/ui/runtime/runs" && req.method === "POST") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }
    if (!openclawProcess && !openclawStarting) startOpenclaw();

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const { prompt, sourceAction, parentRunId, usecaseId, createMode, formInput, attachments } = normalizeCreatePayload(payload);
    const isDraftCreate = createMode === "draft";
    if (isDraftCreate && (parentRunId || usecaseId)) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "draft create does not support parentRunId or usecaseId",
      });
    }
    let normalizedAttachments = [];
    try {
      normalizedAttachments = persistConversationAttachments(attachments, req);
    } catch (error) {
      return sendJson(res, 422, {
        ok: false,
        code: error?.code || "invalid_attachment",
        error: error?.message || "첨부 파일을 처리하지 못했어요",
      });
    }

    if (!isDraftCreate && !prompt && normalizedAttachments.length === 0) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "prompt or attachments are required",
      });
    }

    if (!parentRunId) {
      const expectedFeatureCount = featureToggleManager.captureExecutionFeatures().length;
      const featureRefresh = await refreshRuntimeFeaturesIfPossible();
      if (!featureRefresh.ok && expectedFeatureCount > 0 && featureRefresh.code !== "not_configured") {
        return sendRuntimeError(
          res,
          {
            code: featureRefresh.code || "feature_catalog_failed",
            error: featureRefresh.error || "failed to refresh feature catalog",
          },
          502
        );
      }
    }

    const executionFeatures = featureToggleManager.captureExecutionFeatures();

    if (isDraftCreate) {
      const createdRun = runtimeStore.createRun({
        prompt: "",
        sourceAction: sourceAction || "chat",
        sourceType: "gateway",
        sessionKey: createPerRunSessionKey(),
        sessionMode: RUN_SESSION_MODE_PER_RUN,
        executionFeatures,
        executionFeaturesLockedAt: Date.now(),
        executionFeaturesStatus: executionFeatures.length > 0 ? "locked" : "none",
        isDraft: true,
        hasSubmittedPrompt: false,
      });

      runtimeWsBroker.broadcast({
        type: "run_updated",
        run: buildRunSummary(createdRun),
        ts: Date.now(),
      });
      runtimeWsBroker.broadcastSnapshot({
        items: listVisibleRuns(),
        runById: {
          [createdRun.id]: createdRun,
        },
      });

      return sendJson(res, 200, {
        ok: true,
        runId: createdRun.id,
        status: createdRun.status || "queued",
        run: createdRun,
      });
    }

    if (usecaseId) {
      const created = usecaseDemoRuntime.createUsecaseRun({
        prompt,
        sourceAction: sourceAction || "home_usecase",
        usecaseId,
        formInput,
        executionFeatures,
        attachments: normalizedAttachments,
      });
      if (!created.ok) return sendRuntimeError(res, created, 422);
      return sendJson(res, 200, {
        ok: true,
        runId: created.runId,
        status: created.status || "running",
      });
    }

    let created;
    if (parentRunId) {
      const existing = runtimeStore.getRun(parentRunId);
      if (!existing) {
        return sendJson(res, 422, {
          ok: false,
          code: "invalid_input",
          error: "parent run not found",
        });
      }

      const updatedRun =
        existing.isDraft && !existing.hasSubmittedPrompt
          ? runtimeStore.activateDraftRun(parentRunId, {
              prompt,
              sourceAction,
              sourceType: String(existing.sourceType || "").toLowerCase() === "local" ? "local" : "gateway",
            })
          : runtimeStore.patchRun(parentRunId, {
              status: "running",
              sourceAction,
              sourceType: String(existing.sourceType || "").toLowerCase() === "local" ? "local" : "gateway",
              updatedAt: Date.now(),
            });
      const withUserLog = runtimeStore.appendRunLog(parentRunId, prompt, "user");
      const userLog = withUserLog?.logs?.[withUserLog.logs.length - 1] || null;

      created = await runtimeAdapter.sendMessage({
        runId: parentRunId,
        prompt,
        sourceAction,
        attachments: normalizedAttachments,
      });
      if (!created.ok) {
        const failedRun =
          runtimeStore.patchRun(parentRunId, {
            status: "failed",
            updatedAt: Date.now(),
            executionFeatures: Array.isArray(created.executionFeatures) ? created.executionFeatures : existing.executionFeatures || [],
            executionFeaturesLockedAt: existing.executionFeaturesLockedAt || Date.now(),
            executionFeaturesStatus:
              created.executionFeaturesStatus ||
              (Array.isArray(existing.executionFeatures) && existing.executionFeatures.length > 0 ? "failed" : "none"),
            executionFeaturesError: created.executionFeaturesError || existing.executionFeaturesError || null,
          }) ||
          runtimeStore.getRun(parentRunId) ||
          updatedRun ||
          existing;
        runtimeWsBroker.broadcastRun(parentRunId, {
          type: "run_updated",
          run: buildRunSummary(failedRun),
          ts: Date.now(),
        });
        runtimeWsBroker.broadcastSnapshot({
          items: listVisibleRuns(),
          runById: {
            [parentRunId]: failedRun,
          },
        });
        return sendRuntimeError(res, created);
      }

      if (created.gatewayRunId && created.gatewayRunId !== parentRunId) {
        bindGatewayRunAlias(created.gatewayRunId, parentRunId);
      }
      bindGatewayRunAlias(parentRunId, parentRunId);
      if (created.localFallback) {
        scheduleLocalRunSimulation(parentRunId);
      }

      runtimeWsBroker.broadcastRun(parentRunId, {
        type: "run_updated",
        run: buildRunSummary(runtimeStore.getRun(parentRunId) || updatedRun || existing),
        ts: Date.now(),
      });
      if (userLog) {
        runtimeWsBroker.broadcastRun(parentRunId, {
          type: "log_appended",
          runId: parentRunId,
          log: userLog,
          ts: Date.now(),
        });
      }
      runtimeWsBroker.broadcastSnapshot({
        items: listVisibleRuns(),
        runById: {
          [parentRunId]: runtimeStore.getRun(parentRunId),
        },
      });

      return sendJson(res, 200, {
        ok: true,
        runId: parentRunId,
        status: created.status || "running",
      });
    }

    created = await runtimeAdapter.createRun({ prompt, sourceAction, executionFeatures });
    if (!created.ok) return sendRuntimeError(res, created);
    if (created.runId) {
      runtimeStore.upsertRun({
        id: created.runId,
        title: prompt.slice(0, 72),
        prompt,
        status: created.status || "queued",
        sourceAction,
        sourceType: created.sourceType || (created.localFallback ? "local" : "gateway"),
        executionFeatures: created.executionFeatures || executionFeatures,
        executionFeaturesLockedAt: Date.now(),
        executionFeaturesStatus: created.executionFeaturesStatus || (executionFeatures.length > 0 ? "locked" : "none"),
        executionFeaturesError: created.executionFeaturesError || null,
        updatedAt: Date.now(),
      });
      bindGatewayRunAlias(created.runId, created.runId);
    }
    if (created.localFallback && created.runId) {
      scheduleLocalRunSimulation(created.runId);
    }

    const listResult = await runtimeAdapter.listRuns();
    if (listResult.ok) {
      const runById = {};
      if (created.run) runById[created.run.id] = created.run;
      runtimeWsBroker.broadcast({
        type: "run_updated",
        run: created.run || {
          id: created.runId,
          title: prompt.slice(0, 72),
          status: created.status || "queued",
          updatedAt: Date.now(),
        },
        ts: Date.now(),
      });
      runtimeWsBroker.broadcastSnapshot({
        items: canonicalizeRunItems(listResult.items || []),
        runById,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      runId: created.runId,
      status: created.status || "queued",
    });
  }

  if (pathname === "/api/ui/runtime/runs" && req.method === "GET") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    if (!openclawProcess && !openclawStarting) startOpenclaw();
    const listResult = await runtimeAdapter.listRuns();
    if (!listResult.ok) return sendRuntimeError(res, listResult);
    return sendJson(res, 200, {
      ok: true,
      items: canonicalizeRunItems(listResult.items || []),
    });
  }

  if (pathname === "/api/ui/runtime/usecases" && req.method === "GET") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      items: usecaseDemoRuntime.listUsecases(),
      skills: usecaseDemoRuntime.getCuratedSkillBundles(),
    });
  }

  const runDetailMatch = pathname.match(/^\/api\/ui\/runtime\/runs\/([^/]+)$/);
  if (runDetailMatch && req.method === "PATCH") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const runId = decodeURIComponent(runDetailMatch[1]);
    const nextTitle = typeof payload?.title === "string" ? payload.title.trim() : "";
    if (!nextTitle) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "title is required",
      });
    }
    if (nextTitle.length > 72) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "title must be 72 characters or fewer",
      });
    }

    const updatedRun = runtimeStore.renameRunTitle(runId, nextTitle);
    if (!updatedRun) {
      return sendJson(res, 404, {
        ok: false,
        code: "invalid_input",
        error: "run not found",
      });
    }

    runtimeWsBroker.broadcastRun(runId, {
      type: "run_updated",
      run: buildRunSummary(updatedRun),
      ts: Date.now(),
    });
    runtimeWsBroker.broadcastSnapshot({
      items: listVisibleRuns(),
      runById: { [runId]: updatedRun },
    });

    return sendJson(res, 200, {
      ok: true,
      runId,
      run: updatedRun,
    });
  }

  if (runDetailMatch && req.method === "GET") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    if (!openclawProcess && !openclawStarting) startOpenclaw();
    const runId = decodeURIComponent(runDetailMatch[1]);
    const detailResult = await runtimeAdapter.getRun(runId);
    if (!detailResult.ok) return sendRuntimeError(res, detailResult, 404);
    return sendJson(res, 200, {
      ok: true,
      run: detailResult.run,
    });
  }

  const runActionMatch = pathname.match(/^\/api\/ui\/runtime\/runs\/([^/]+)\/actions$/);
  if (runActionMatch && req.method === "POST") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const runId = decodeURIComponent(runActionMatch[1]);
    const handled = usecaseDemoRuntime.handleAction(runId, payload);
    if (!handled.ok) return sendRuntimeError(res, handled, 422);
    return sendJson(res, 200, {
      ok: true,
      runId,
      status: handled.run?.status || "running",
      run: handled.run || null,
    });
  }

  if (pathname === "/api/ui/runtime/skills" && req.method === "GET") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    await ensureDefaultSkillsProvisioned();
    if (!openclawProcess && !openclawStarting) startOpenclaw();
    const skillsResult = await runtimeAdapter.listSkills();
    if (!skillsResult.ok) return sendRuntimeError(res, skillsResult);
    return sendJson(res, 200, {
      ok: true,
      items: buildEnrichedSkillItems(skillsResult.items || []),
    });
  }

  const skillToggleMatch = pathname.match(/^\/api\/ui\/runtime\/skills\/([^/]+)\/toggle$/);
  if (skillToggleMatch && req.method === "POST") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const enabled = payload.enabled;
    if (typeof enabled !== "boolean") {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "enabled(boolean) is required",
      });
    }

    await ensureDefaultSkillsProvisioned();
    if (!openclawProcess && !openclawStarting) startOpenclaw();
    const skillId = decodeURIComponent(skillToggleMatch[1]);
    const currentSkills = await runtimeAdapter.listSkills();
    if (!currentSkills.ok) return sendRuntimeError(res, currentSkills);
    const currentItem = buildEnrichedSkillItems(currentSkills.items || []).find((row) => row.id === skillId) || null;
    if (enabled && currentItem?.setupState && currentItem.setupState !== "ready") {
      return sendJson(res, 409, {
        ok: false,
        code: "skill_not_ready",
        error: currentItem.setupHint || "스킬을 켜기 전에 필요한 설정을 먼저 완료해 주세요",
        item: currentItem,
      });
    }
    const toggleResult = await runtimeAdapter.toggleSkill(skillId, enabled);
    if (!toggleResult.ok) return sendRuntimeError(res, toggleResult);
    persistSkillEnabledInConfig(skillId, enabled);
    syncDefaultSkillsIntoRuntimeStore();
    const item = buildEnrichedSkillItems([toggleResult.item]).find((row) => row.id === skillId) || null;

    return sendJson(res, 200, {
      ok: true,
      id: toggleResult.item.id,
      enabled: Boolean(toggleResult.item.enabled),
      item,
    });
  }

  if (pathname === "/api/ui/runtime/usage" && req.method === "GET") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const limit = url.searchParams.get("limit");
    const usage = runtimeAdapter.queryUsage({
      from: from || undefined,
      to: to || undefined,
      limit: limit ? Number(limit) : undefined,
    });

    return sendJson(res, 200, {
      ok: true,
      rows: usage.rows,
      summary: usage.summary,
    });
  }

  if (pathname === "/api/ui/runtime/settings" && req.method === "GET") {
    const connected = detectConnectedProviderAndMethod();
    const runtimeModel = await detectRuntimeModelSnapshot();
    let featureRefresh = null;
    if (connected?.configured) {
      featureRefresh = await refreshRuntimeFeaturesIfPossible();
    }
    const featureContract = gatewayRpcClient?.getExecutionFeatureContractState?.() || null;
    return sendJson(res, 200, {
      ok: true,
      providers: listProviderCatalog(),
      connected,
      runtimeModel,
      defaults: {
        defaultModel: runtimeStore.getDefaultModel(),
      },
      features: {
        items: featureRefresh?.items || buildRuntimeFeatureRows(),
        ok: Boolean(featureRefresh?.ok),
        error: featureRefresh?.ok ? null : featureRefresh?.error || null,
        contract: featureContract,
      },
      skillEnvironment: {
        items: buildSkillEnvironmentItems(),
      },
    });
  }

  if (pathname === "/api/ui/runtime/settings/skill-env" && req.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const result = await applySkillEnvironmentUpdates(payload?.updates);
    if (!result.ok) {
      return sendJson(res, 422, result);
    }

    let restart = {
      requested: false,
      ok: null,
      error: null,
    };
    if (result.changedKeys.length > 0 && payload?.restartGateway !== false && isConfigured()) {
      restart.requested = true;
      try {
        const restarted = await restartOpenclawGateway();
        restart.ok = Boolean(restarted?.ok);
        restart.error = restarted?.ok ? null : "OpenClaw gateway restart could not be confirmed.";
      } catch (error) {
        restart.ok = false;
        restart.error = error.message || "OpenClaw gateway restart failed.";
      }
    }

    return sendJson(res, 200, {
      ok: true,
      changedKeys: result.changedKeys,
      sideEffects: result.sideEffects || [],
      restart,
      skillEnvironment: {
        items: buildSkillEnvironmentItems(),
      },
    });
  }

  if (pathname === "/api/ui/runtime/settings/skill-env/gog/oauth/start" && req.method === "POST") {
    await ensureDefaultSkillsProvisioned();
    const result = await startGogAccountConnection();
    if (!result.ok) {
      return sendJson(res, result.code === "invalid_input" ? 422 : 500, result);
    }
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/ui/runtime/settings/skill-env/gog/oauth/complete" && req.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    await ensureDefaultSkillsProvisioned();
    const result = await completeGogAccountConnection(payload?.redirectUrl);
    if (!result.ok) {
      return sendJson(res, result.code === "invalid_input" ? 422 : 500, result);
    }
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/ui/runtime/fix/state" && req.method === "GET") {
    const requestOrigin = url.searchParams.get("origin") || req.headers.origin || "";
    return sendJson(res, 200, buildFixStatePayload({ origin: requestOrigin }));
  }

  if (pathname === "/api/ui/runtime/fix/run" && req.method === "POST") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    if (fixRecovering) {
      return sendJson(res, 409, {
        ok: false,
        code: "fix_in_progress",
        error: "다른 복구 작업이 이미 실행 중이에요",
      });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    if (!openclawProcess && !openclawStarting) startOpenclaw();

    fixRecovering = true;
    try {
      const result = await runFixOrchestrator({
        origin: payload?.origin || req.headers.origin || "",
        options: payload?.options || {},
        confirmation: payload?.confirmation || null,
      });
      upsertFixLastRecover({
        status: result.status,
        category: result.category,
        summaryKo: result.summaryKo,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      console.error("fix orchestrator failed:", error.message);
      const failed = buildFixResult({
        status: "failed",
        category: "unknown",
        summaryKo: "자동 복구 실행 중 예기치 않은 오류가 발생했어요",
        steps: [
          {
            id: `fix-failed-${Date.now()}`,
            title: "실행 오류",
            status: "error",
            message: error.message || "unknown error",
            details: null,
            ts: Date.now(),
          },
        ],
        nextActions: ["서버 로그를 확인한 뒤 다시 시도하세요"],
      });
      upsertFixLastRecover({
        status: failed.status,
        category: failed.category,
        summaryKo: failed.summaryKo,
      });
      return sendJson(res, 500, failed);
    } finally {
      fixRecovering = false;
    }
  }

  const featureToggleMatch = pathname.match(/^\/api\/ui\/runtime\/features\/([^/]+)\/toggle$/);
  if (featureToggleMatch && req.method === "POST") {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "invalid json body",
      });
    }

    const enabled = payload.enabled;
    if (typeof enabled !== "boolean") {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "enabled(boolean) is required",
      });
    }

    const featureId = decodeURIComponent(featureToggleMatch[1]);
    if (!FEATURE_IDS.includes(featureId)) {
      return sendJson(res, 422, {
        ok: false,
        code: "invalid_input",
        error: "unsupported feature id",
      });
    }

    if (!openclawProcess && !openclawStarting) startOpenclaw();
    const applied = await featureToggleManager.toggleFeature(featureId, enabled);
    if (!applied.ok) {
      return sendRuntimeError(res, applied, 500);
    }

    const row = buildRuntimeFeatureRows().find((item) => item.id === featureId) || {
      id: featureId,
      enabled: Boolean(enabled),
      status: applied.status || normalizeFeatureStatusRow(null),
    };
    return sendJson(res, 200, {
      ok: true,
      feature: row,
    });
  }

  if (pathname === "/api/oc" || pathname.startsWith("/api/oc/")) {
    if (!isConfigured()) {
      return sendJson(res, 409, {
        ok: false,
        code: "not_configured",
        error: "openclaw is not configured yet",
      });
    }

    if (!openclawProcess) startOpenclaw();

    const rewrittenPath = `${pathname.replace(/^\/api\/oc/, "") || "/"}${search}`;
    return proxyHttpToOpenclaw(req, res, rewrittenPath);
  }

  return serveUi(req, res, pathname);
});

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {
    // Ignore transient socket resets from browser/ws proxy.
  });

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

  if (pathname === "/api/ui/runtime/runs/stream") {
    if (!isConfigured()) {
      socket.end("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\n\r\n");
      return;
    }
    runtimeRunsWss.handleUpgrade(req, socket, head, (ws) => {
      runtimeRunsWss.emit("connection", ws, req);
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

server.on("clientError", (error, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    // ignore client socket errors
  }
});

initializeHome();
ensureConfigDir();
ensureSemoWorkspaceBranding();
initializeFixBypassState();
startRuntimePoller();

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
  try {
    if (gatewayRpcClient) gatewayRpcClient.stop();
  } catch {}
  for (const runId of localRunSimulationTimers.keys()) {
    clearLocalRunSimulation(runId);
  }
  if (runtimePollTimer) {
    clearInterval(runtimePollTimer);
    runtimePollTimer = null;
  }
  clearFixBypassTimer();
  server.close();
});
