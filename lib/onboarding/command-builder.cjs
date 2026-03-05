const DEFAULT_OPENCLAW_PORT = 18790;
const RESET_SCOPES = new Set(["none", "config", "config+creds+sessions", "full"]);

function normalizeResetScope(value) {
  if (typeof value !== "string") return "none";
  const normalized = value.trim().toLowerCase();
  return RESET_SCOPES.has(normalized) ? normalized : null;
}

function quickstartBaseArgs(openclawPort) {
  return [
    "onboard",
    "--non-interactive",
    "--json",
    "--accept-risk",
    "--flow",
    "quickstart",
    "--skip-channels",
    "--skip-skills",
    "--skip-daemon",
    "--skip-ui",
    "--skip-health",
    "--mode",
    "local",
    "--gateway-port",
    String(openclawPort || DEFAULT_OPENCLAW_PORT),
  ];
}

function buildResetCommand(resetScope) {
  const normalized = normalizeResetScope(resetScope);
  if (!normalized || normalized === "none") return null;

  return {
    command: "openclaw",
    args: ["reset", "--non-interactive", "--scope", normalized, "--yes"],
    maskValues: [],
  };
}

function buildNonInteractiveOnboardCommand({ openclawPort, method, credentials }) {
  if (!method || method.mode !== "non_interactive") {
    throw new Error("non_interactive method is required");
  }

  const args = quickstartBaseArgs(openclawPort);
  if (method.authChoice) {
    args.push("--auth-choice", method.authChoice);
  }

  const maskValues = [];
  const flags = method.credentialFlags || {};
  for (const [fieldId, flag] of Object.entries(flags)) {
    const rawValue = credentials?.[fieldId];
    if (typeof rawValue === "string" && rawValue.trim()) {
      const value = rawValue.trim();
      args.push(flag, value);
      maskValues.push(value);
    }
  }

  if (Array.isArray(method.extraArgs) && method.extraArgs.length > 0) {
    args.push(...method.extraArgs);
  }

  return {
    command: "openclaw",
    args,
    maskValues,
  };
}

function buildInteractiveAuthCommand({ method }) {
  if (!method || method.mode !== "interactive_required") {
    throw new Error("interactive_required method is required");
  }

  if (!Array.isArray(method.interactiveCommand) || method.interactiveCommand.length === 0) {
    throw new Error("interactive command is missing");
  }

  return {
    command: "openclaw",
    args: [...method.interactiveCommand],
    maskValues: [],
  };
}

function buildFinalizeOnboardCommand({ openclawPort, method }) {
  const args = quickstartBaseArgs(openclawPort);
  args.push("--auth-choice", method?.finalizeAuthChoice || "skip");

  return {
    command: "openclaw",
    args,
    maskValues: [],
  };
}

module.exports = {
  normalizeResetScope,
  buildResetCommand,
  buildNonInteractiveOnboardCommand,
  buildInteractiveAuthCommand,
  buildFinalizeOnboardCommand,
};
