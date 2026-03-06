const crypto = require("crypto");

const RUN_SESSION_MODE_PER_RUN = "per_run";
const RUN_SESSION_MODE_LEGACY_SHARED = "legacy_shared";

function createPerRunSessionKey() {
  return `agent:main:run:${crypto.randomUUID()}`;
}

function normalizeRunSessionMode(value, hasSessionKey = false) {
  if (value === RUN_SESSION_MODE_PER_RUN || value === RUN_SESSION_MODE_LEGACY_SHARED) {
    return value;
  }
  return hasSessionKey ? RUN_SESSION_MODE_PER_RUN : RUN_SESSION_MODE_LEGACY_SHARED;
}

module.exports = {
  RUN_SESSION_MODE_LEGACY_SHARED,
  RUN_SESSION_MODE_PER_RUN,
  createPerRunSessionKey,
  normalizeRunSessionMode,
};
