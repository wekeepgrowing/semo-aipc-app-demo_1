const CAPABILITY_CANDIDATES = {
  runsCreate: [
    { method: "POST", path: "/api/runs" },
    { method: "POST", path: "/runs" },
    { method: "POST", path: "/api/v1/runs" },
  ],
  runsList: [
    { method: "GET", path: "/api/runs" },
    { method: "GET", path: "/runs" },
    { method: "GET", path: "/api/v1/runs" },
  ],
  runDetail: [
    { method: "GET", path: "/api/runs/:id" },
    { method: "GET", path: "/runs/:id" },
    { method: "GET", path: "/api/v1/runs/:id" },
  ],
  skillsList: [
    { method: "GET", path: "/api/skills" },
    { method: "GET", path: "/skills" },
    { method: "GET", path: "/api/v1/skills" },
  ],
  skillsToggle: [
    { method: "POST", path: "/api/skills/:id/toggle" },
    { method: "PATCH", path: "/api/skills/:id" },
    { method: "POST", path: "/skills/:id/toggle" },
  ],
};

class CapabilityRegistry {
  constructor() {
    this.selected = {
      runsCreate: null,
      runsList: null,
      runDetail: null,
      skillsList: null,
      skillsToggle: null,
    };
    this.lastProbeAt = 0;
  }

  get(name) {
    return this.selected[name] || null;
  }

  set(name, candidate) {
    this.selected[name] = candidate || null;
  }

  snapshot() {
    return {
      ...this.selected,
      lastProbeAt: this.lastProbeAt,
    };
  }

  async probeAll({ requestRaw, sampleRunId = "sample-run", sampleSkillId = "sample-skill" }) {
    if (typeof requestRaw !== "function") {
      throw new Error("requestRaw is required");
    }

    const looksLikeApiPayload = (body) => {
      if (Array.isArray(body)) return true;
      if (body && typeof body === "object") return true;
      return false;
    };

    const isAcceptableStatus = (status) => [400, 401, 403, 405, 409, 422].includes(Number(status));

    const probeOne = async (name, candidates) => {
      for (const candidate of candidates) {
        const path = candidate.path
          .replace(":id", name === "skillsToggle" ? sampleSkillId : sampleRunId);

        try {
          const result = await requestRaw({
            method: candidate.method,
            path,
            body: candidate.method === "POST" || candidate.method === "PATCH" ? {} : undefined,
            timeoutMs: 1200,
          });

          if (!result || !Number.isFinite(result.status)) continue;
          const status = Number(result.status);

          if (status >= 200 && status < 300 && looksLikeApiPayload(result.body)) {
            return candidate;
          }

          if (isAcceptableStatus(status)) {
            return candidate;
          }
        } catch {
          // continue probing next candidate
        }
      }

      return null;
    };

    this.set("runsList", await probeOne("runsList", CAPABILITY_CANDIDATES.runsList));
    this.set("runsCreate", await probeOne("runsCreate", CAPABILITY_CANDIDATES.runsCreate));
    this.set("runDetail", await probeOne("runDetail", CAPABILITY_CANDIDATES.runDetail));
    this.set("skillsList", await probeOne("skillsList", CAPABILITY_CANDIDATES.skillsList));
    this.set("skillsToggle", await probeOne("skillsToggle", CAPABILITY_CANDIDATES.skillsToggle));

    this.lastProbeAt = Date.now();
    return this.snapshot();
  }
}

module.exports = {
  CAPABILITY_CANDIDATES,
  CapabilityRegistry,
};
