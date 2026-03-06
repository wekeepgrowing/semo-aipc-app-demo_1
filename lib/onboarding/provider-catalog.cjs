const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    modelSummary: "GPT-5, o3, o4-mini 등",
    methods: [
      {
        id: "openai-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "openai-api-key",
        requiredFields: ["openaiApiKey"],
        fields: [{ id: "openaiApiKey", label: "OpenAI API Key", type: "password", placeholder: "sk-..." }],
        credentialFlags: {
          openaiApiKey: "--openai-api-key",
        },
      },
      {
        id: "openai-codex",
        label: "Codex OAuth",
        mode: "interactive_required",
        interactiveStrategy: "wizard_auth_choice",
        wizardAuthChoice: "openai-codex",
        requiredFields: [],
        fields: [],
        interactiveCommand: ["models", "auth", "login", "--provider", "openai-codex"],
        finalizeAuthChoice: "skip",
      },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    modelSummary: "Claude Sonnet 4.6, Opus 4.1, Haiku 3.5 등",
    methods: [
      {
        id: "anthropic-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "apiKey",
        requiredFields: ["anthropicApiKey"],
        fields: [{ id: "anthropicApiKey", label: "Anthropic API Key", type: "password", placeholder: "sk-ant-..." }],
        credentialFlags: {
          anthropicApiKey: "--anthropic-api-key",
        },
      },
      {
        id: "anthropic-setup-token",
        label: "Setup Token",
        mode: "interactive_required",
        interactiveStrategy: "legacy_cli",
        requiredFields: [],
        fields: [],
        interactiveCommand: ["models", "auth", "setup-token", "--provider", "anthropic"],
        finalizeAuthChoice: "skip",
      },
    ],
  },
  {
    id: "google",
    label: "Google AI",
    modelSummary: "Gemini 3.1 Pro, Gemini 3 Flash, Gemini 3.1 Flash-Lite 등",
    methods: [
      {
        id: "google-gemini-api-key",
        label: "Gemini API Key",
        mode: "non_interactive",
        authChoice: "gemini-api-key",
        requiredFields: ["geminiApiKey"],
        fields: [{ id: "geminiApiKey", label: "Gemini API Key", type: "password", placeholder: "AIza..." }],
        credentialFlags: {
          geminiApiKey: "--gemini-api-key",
        },
      },
    ],
  },
  {
    id: "chutes",
    label: "Chutes",
    modelSummary: "Qwen3-32B, DeepSeek-V3.2, GLM-5 등",
    methods: [
      {
        id: "chutes-oauth",
        label: "OAuth",
        mode: "interactive_required",
        interactiveStrategy: "wizard_auth_choice",
        wizardAuthChoice: "chutes",
        requiredFields: [],
        fields: [],
        interactiveCommand: ["models", "auth", "login", "--provider", "chutes"],
        finalizeAuthChoice: "skip",
      },
    ],
  },
  {
    id: "vllm",
    label: "vLLM",
    methods: [
      {
        id: "vllm-auth",
        label: "Interactive Setup",
        mode: "interactive_required",
        interactiveStrategy: "wizard_auth_choice",
        wizardAuthChoice: "vllm",
        requiredFields: [],
        fields: [],
        interactiveCommand: ["models", "auth", "login", "--provider", "vllm"],
        finalizeAuthChoice: "skip",
      },
    ],
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    methods: [
      {
        id: "xai-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "xai-api-key",
        requiredFields: ["xaiApiKey"],
        fields: [{ id: "xaiApiKey", label: "xAI API Key", type: "password", placeholder: "xai-..." }],
        credentialFlags: {
          xaiApiKey: "--xai-api-key",
        },
      },
    ],
  },
  {
    id: "mistral",
    label: "Mistral AI",
    methods: [
      {
        id: "mistral-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "mistral-api-key",
        requiredFields: ["mistralApiKey"],
        fields: [{ id: "mistralApiKey", label: "Mistral API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          mistralApiKey: "--mistral-api-key",
        },
      },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    methods: [
      {
        id: "openrouter-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "openrouter-api-key",
        requiredFields: ["openrouterApiKey"],
        fields: [{ id: "openrouterApiKey", label: "OpenRouter API Key", type: "password", placeholder: "sk-or-..." }],
        credentialFlags: {
          openrouterApiKey: "--openrouter-api-key",
        },
      },
    ],
  },
  {
    id: "kilocode",
    label: "Kilo Gateway",
    methods: [
      {
        id: "kilocode-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "kilocode-api-key",
        requiredFields: ["kilocodeApiKey"],
        fields: [{ id: "kilocodeApiKey", label: "Kilo API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          kilocodeApiKey: "--kilocode-api-key",
        },
      },
    ],
  },
  {
    id: "zai",
    label: "Z.AI",
    methods: [
      {
        id: "zai-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "zai-api-key",
        requiredFields: ["zaiApiKey"],
        fields: [{ id: "zaiApiKey", label: "Z.AI API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          zaiApiKey: "--zai-api-key",
        },
      },
    ],
  },
  {
    id: "qianfan",
    label: "Qianfan",
    methods: [
      {
        id: "qianfan-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "qianfan-api-key",
        requiredFields: ["qianfanApiKey"],
        fields: [{ id: "qianfanApiKey", label: "Qianfan API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          qianfanApiKey: "--qianfan-api-key",
        },
      },
    ],
  },
  {
    id: "minimax",
    label: "MiniMax",
    methods: [
      {
        id: "minimax-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "minimax-api",
        requiredFields: ["minimaxApiKey"],
        fields: [{ id: "minimaxApiKey", label: "MiniMax API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          minimaxApiKey: "--minimax-api-key",
        },
      },
    ],
  },
  {
    id: "moonshot",
    label: "Moonshot AI",
    methods: [
      {
        id: "moonshot-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "moonshot-api-key",
        requiredFields: ["moonshotApiKey"],
        fields: [{ id: "moonshotApiKey", label: "Moonshot API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          moonshotApiKey: "--moonshot-api-key",
        },
      },
    ],
  },
  {
    id: "volcengine",
    label: "Volcano Engine",
    methods: [
      {
        id: "volcengine-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "volcengine-api-key",
        requiredFields: ["volcengineApiKey"],
        fields: [{ id: "volcengineApiKey", label: "Volcano Engine API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          volcengineApiKey: "--volcengine-api-key",
        },
      },
    ],
  },
  {
    id: "byteplus",
    label: "BytePlus",
    methods: [
      {
        id: "byteplus-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "byteplus-api-key",
        requiredFields: ["byteplusApiKey"],
        fields: [{ id: "byteplusApiKey", label: "BytePlus API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          byteplusApiKey: "--byteplus-api-key",
        },
      },
    ],
  },
  {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    methods: [
      {
        id: "ai-gateway-api-key",
        label: "API Key",
        mode: "non_interactive",
        authChoice: "ai-gateway-api-key",
        requiredFields: ["aiGatewayApiKey"],
        fields: [{ id: "aiGatewayApiKey", label: "AI Gateway API Key", type: "password", placeholder: "..." }],
        credentialFlags: {
          aiGatewayApiKey: "--ai-gateway-api-key",
        },
      },
    ],
  },
  {
    id: "qwen",
    label: "Qwen",
    methods: [
      {
        id: "qwen-portal",
        label: "Portal OAuth",
        mode: "interactive_required",
        interactiveStrategy: "wizard_auth_choice",
        wizardAuthChoice: "qwen-portal",
        requiredFields: [],
        fields: [],
        interactiveCommand: ["models", "auth", "login", "--provider", "qwen-portal", "--set-default"],
        finalizeAuthChoice: "skip",
      },
    ],
  },
  {
    id: "github-copilot",
    label: "Copilot",
    methods: [
      {
        id: "github-copilot-device",
        label: "Device OAuth",
        mode: "interactive_required",
        interactiveStrategy: "wizard_auth_choice",
        wizardAuthChoice: "github-copilot",
        requiredFields: [],
        fields: [],
        interactiveCommand: ["models", "auth", "login-github-copilot"],
        finalizeAuthChoice: "skip",
      },
    ],
  },
];

function stripMethod(method) {
  return {
    id: method.id,
    label: method.label,
    mode: method.mode,
    requiredFields: [...method.requiredFields],
    fields: Array.isArray(method.fields) ? method.fields.map((field) => ({ ...field })) : [],
  };
}

function listProviderCatalog() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    modelSummary: typeof provider.modelSummary === "string" ? provider.modelSummary : "",
    methods: provider.methods.map(stripMethod),
  }));
}

function findProvider(providerId) {
  return PROVIDERS.find((provider) => provider.id === providerId) || null;
}

function findMethod(providerId, methodId) {
  const provider = findProvider(providerId);
  if (!provider) return null;
  const method = provider.methods.find((entry) => entry.id === methodId);
  if (!method) return null;
  return {
    provider,
    method,
  };
}

module.exports = {
  listProviderCatalog,
  findProvider,
  findMethod,
};
