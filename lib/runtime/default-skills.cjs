const DEFAULT_SKILL_DEFINITIONS = [
  {
    id: "self-improving-agent",
    slug: "self-improving-agent",
    name: "자동 개선 루프",
    description: "실패와 수정 사례를 바탕으로 에이전트 동작을 점점 더 안정적으로 개선해요",
    pinnedVersion: "1.0.11",
    archiveFile: "self-improving-agent-1.0.11.zip",
    sha256: "eaa2f3b866770ad160c867c5826ef33cbb4dd9d4db7c2c5c06ae4672217eddb2",
    defaultEnabled: true,
    requiredBins: [],
    requiredEnv: [],
    requiresOAuth: false,
    setupHint: "선택적 hook은 자동으로 활성화되지 않아요",
    installCommands: [],
  },
  {
    id: "tavily-search",
    slug: "tavily-search",
    name: "웹 리서치",
    description: "웹에서 최신 정보를 검색하고, 핵심 근거를 정리해 제공해요",
    pinnedVersion: "1.0.0",
    archiveFile: "tavily-search-1.0.0.zip",
    sha256: "346f2630d0c7e85611e7b28c431481771b978b984cdc0b59ad0b7dd2c40c2f85",
    defaultEnabled: false,
    requiredBins: ["node"],
    requiredEnv: ["TAVILY_API_KEY"],
    requiresOAuth: false,
    setupHint: "TAVILY_API_KEY를 설정하면 바로 사용할 수 있어요",
    skillEnvironment: {
      mode: "all",
      fields: [
        {
          key: "TAVILY_API_KEY",
          label: "Tavily API Key",
          inputType: "password",
          placeholder: "tvly-...",
          required: true,
        },
      ],
    },
    installCommands: [],
  },
  {
    id: "find-skills",
    slug: "find-skills",
    name: "스킬 탐색",
    description: "필요한 작업에 맞는 스킬을 찾고 설치 대상을 추천해요",
    pinnedVersion: "0.1.0",
    archiveFile: "find-skills-0.1.0.zip",
    sha256: "5bbc5cadf869e23dedd8195e24af4891f5ea62b74ce31171f4c77bbfaf4cbebb",
    defaultEnabled: true,
    requiredBins: [],
    requiredEnv: [],
    requiresOAuth: false,
    setupHint: "서드파티 스킬 설치 전에는 ClawHub 출처와 코드를 검토해야 해요",
    installCommands: [],
  },
  {
    id: "gog",
    slug: "gog",
    name: "구글 워크스페이스 연동",
    description: "Gmail, Calendar, Drive, Docs, Sheets 같은 Google Workspace 작업을 연동해요",
    pinnedVersion: "1.0.0",
    archiveFile: "gog-1.0.0.zip",
    sha256: "f2917d0e1129a3c9442664669b3a4b6e92639a343eedaa266ffe4f896d00f3e5",
    defaultEnabled: false,
    requiredBins: ["gog"],
    requiredEnv: [],
    requiresOAuth: true,
    setupHint: "Google OAuth 자격증명을 저장한 뒤 계정 연결까지 완료해야 사용할 수 있어요",
    skillEnvironment: {
      mode: "all",
      fields: [
        {
          key: "GOG_CLIENT_ID",
          label: "Google OAuth Client ID",
          inputType: "text",
          placeholder: "....apps.googleusercontent.com",
          required: true,
        },
        {
          key: "GOG_CLIENT_SECRET",
          label: "Google OAuth Client Secret",
          inputType: "password",
          placeholder: "Google Cloud에서 발급된 Client Secret",
          required: true,
        },
        {
          key: "GOG_ACCOUNT",
          label: "연결할 Google 계정 이메일",
          inputType: "email",
          placeholder: "name@company.com",
          required: true,
        },
      ],
    },
    installCommands: [
      {
        id: "gog-brew",
        label: "Install gog (brew)",
        command: "brew",
        args: ["install", "steipete/tap/gogcli"],
        verifyBins: ["gog"],
        timeoutMs: 600000,
      },
    ],
  },
  {
    id: "summarize",
    slug: "summarize",
    name: "문서·링크 요약",
    description: "문서, 링크, PDF, 이미지, 오디오 같은 다양한 입력을 빠르게 요약해요",
    pinnedVersion: "1.0.0",
    archiveFile: "summarize-1.0.0.zip",
    sha256: "4d22716892c10ca837337b7e43afbb22e38b047570bcb39d46b122bc41aedbaf",
    defaultEnabled: false,
    requiredBins: ["summarize"],
    requiredEnv: [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "XAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
    ],
    requiresOAuth: false,
    setupHint: "요약 CLI가 사용할 모델 provider API 키를 하나 이상 설정해야 해요",
    skillEnvironment: {
      mode: "any",
      fields: [
        {
          key: "OPENAI_API_KEY",
          label: "OpenAI API Key",
          inputType: "password",
          placeholder: "sk-...",
          required: true,
        },
        {
          key: "ANTHROPIC_API_KEY",
          label: "Anthropic API Key",
          inputType: "password",
          placeholder: "sk-ant-...",
          required: true,
        },
        {
          key: "XAI_API_KEY",
          label: "xAI API Key",
          inputType: "password",
          placeholder: "xai-...",
          required: true,
        },
        {
          key: "GEMINI_API_KEY",
          label: "Gemini API Key",
          inputType: "password",
          placeholder: "AIza...",
          required: true,
        },
        {
          key: "GOOGLE_GENERATIVE_AI_API_KEY",
          label: "Google Generative AI API Key",
          inputType: "password",
          placeholder: "AIza...",
          required: true,
        },
        {
          key: "GOOGLE_API_KEY",
          label: "Google API Key",
          inputType: "password",
          placeholder: "AIza...",
          required: true,
        },
      ],
    },
    installCommands: [
      {
        id: "summarize-brew",
        label: "Install summarize (brew)",
        command: "brew",
        args: ["install", "steipete/tap/summarize"],
        verifyBins: ["summarize"],
        timeoutMs: 600000,
      },
    ],
  },
  {
    id: "agent-browser",
    slug: "agent-browser",
    name: "브라우저 자동화",
    description: "웹페이지를 열고 탐색하며 클릭, 입력, 스냅샷 작업을 자동으로 수행해요",
    pinnedVersion: "0.2.0",
    archiveFile: "agent-browser-0.2.0.zip",
    sha256: "29701aa09cb5e5e4ee1bed1fc35e1307b6a944cf35420b4e2c991abe1178bb53",
    defaultEnabled: false,
    requiredBins: ["node", "npm", "agent-browser"],
    requiredEnv: [],
    requiresOAuth: false,
    setupHint: "브라우저 CLI와 Playwright 의존성을 자동 설치해요",
    installCommands: [
      {
        id: "agent-browser-npm",
        label: "Install agent-browser CLI",
        command: "npm",
        args: ["install", "-g", "agent-browser"],
        verifyBins: ["agent-browser"],
        timeoutMs: 600000,
      },
      {
        id: "agent-browser-deps",
        label: "Install agent-browser browser deps",
        command: "agent-browser",
        args: ["install", "--with-deps"],
        oncePerVersion: true,
        timeoutMs: 600000,
      },
    ],
  },
];

const DEFAULT_SKILL_MAP = new Map(DEFAULT_SKILL_DEFINITIONS.map((skill) => [skill.id, skill]));
const LEGACY_SEEDED_SKILL_IDS = ["research-agent", "summary-agent", "planner-agent", "monitor-agent", "writer-agent", "review-agent"];

const USECASE_SKILL_IDS = {
  web_research: ["tavily-search", "summarize", "agent-browser"],
  doc_summary: ["summarize", "find-skills", "gog"],
};

function cloneInstallCommand(command) {
  return {
    ...command,
    args: Array.isArray(command?.args) ? [...command.args] : [],
    verifyBins: Array.isArray(command?.verifyBins) ? [...command.verifyBins] : [],
  };
}

function cloneSkillEnvironmentField(field) {
  return {
    ...field,
  };
}

function cloneSkillEnvironmentConfig(config) {
  if (!config || typeof config !== "object") return null;
  return {
    ...config,
    fields: Array.isArray(config?.fields) ? config.fields.map(cloneSkillEnvironmentField) : [],
  };
}

function cloneSkillDefinition(skill) {
  return {
    ...skill,
    requiredBins: Array.isArray(skill?.requiredBins) ? [...skill.requiredBins] : [],
    requiredEnv: Array.isArray(skill?.requiredEnv) ? [...skill.requiredEnv] : [],
    skillEnvironment: cloneSkillEnvironmentConfig(skill?.skillEnvironment),
    installCommands: Array.isArray(skill?.installCommands) ? skill.installCommands.map(cloneInstallCommand) : [],
  };
}

function toRuntimeSkillRow(skill) {
  return {
    id: String(skill.id),
    name: String(skill.name || skill.id),
    description: String(skill.description || ""),
    enabled: Boolean(skill.defaultEnabled),
  };
}

function getDefaultSkillDefinitions() {
  return DEFAULT_SKILL_DEFINITIONS.map(cloneSkillDefinition);
}

function getDefaultSkillDefinition(id) {
  const skill = DEFAULT_SKILL_MAP.get(String(id || ""));
  return skill ? cloneSkillDefinition(skill) : null;
}

function getDefaultSkillIds() {
  return DEFAULT_SKILL_DEFINITIONS.map((skill) => skill.id);
}

function getDefaultSkillRuntimeRows() {
  return getDefaultSkillDefinitions().map(toRuntimeSkillRow);
}

function pickDefaultSkills(ids = []) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const skill = DEFAULT_SKILL_MAP.get(String(id || ""));
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    out.push(toRuntimeSkillRow(skill));
  }
  return out;
}

function getUsecaseSkillRows(usecaseId) {
  return pickDefaultSkills(USECASE_SKILL_IDS[String(usecaseId || "")] || []);
}

function getAllUsecaseSkillRows() {
  const seen = new Set();
  const out = [];
  for (const ids of Object.values(USECASE_SKILL_IDS)) {
    for (const skill of pickDefaultSkills(ids)) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      out.push(skill);
    }
  }
  return out;
}

module.exports = {
  DEFAULT_SKILL_DEFINITIONS,
  LEGACY_SEEDED_SKILL_IDS,
  cloneSkillDefinition,
  getAllUsecaseSkillRows,
  getDefaultSkillDefinition,
  getDefaultSkillDefinitions,
  getDefaultSkillIds,
  getDefaultSkillRuntimeRows,
  getUsecaseSkillRows,
  pickDefaultSkills,
};
