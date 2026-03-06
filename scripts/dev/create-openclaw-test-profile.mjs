#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const targetDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), ".tmp-openclaw-data", "feature-contract-test");

const configDir = path.join(targetDir, ".openclaw");
const configPath = path.join(configDir, "openclaw.json");
const envPath = path.join(configDir, ".env");
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || `semo-test-${crypto.randomUUID()}`;

fs.mkdirSync(configDir, { recursive: true });

const config = {
  wizard: {},
  update: {
    checkOnStart: false,
  },
  tools: {
    profile: "full",
  },
  gateway: {
    mode: "local",
    auth: {
      token: gatewayToken,
    },
    controlUi: {
      enabled: true,
      dangerouslyDisableDeviceAuth: false,
      dangerouslyAllowHostHeaderOriginFallback: false,
    },
  },
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
fs.writeFileSync(envPath, `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}\n`, "utf8");

console.log(`Created OpenClaw test profile at ${configDir}`);
console.log(`OPENCLAW_HOME=${targetDir}`);
console.log(`OPENCLAW_DATA_DIR=${configDir}`);
console.log(`OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`);
