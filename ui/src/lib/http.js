function normalizeErrorMessage(status, payload) {
  if (payload && typeof payload === "object") {
    if (payload.code && payload.error) return `[${payload.code}] ${payload.error}`;
    if (payload.error) return payload.error;
    if (payload.message) return payload.message;
  }
  return `요청 실패 (HTTP ${status})`;
}

export async function fetchApiJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    const error = new Error("백엔드에 연결할 수 없습니다. Docker 백엔드가 실행 중인지 확인해 주세요.");
    error.code = "network_error";
    throw error;
  }

  const raw = await res.text();
  if (!raw) {
    const error = new Error(`백엔드가 빈 응답을 반환했습니다 (HTTP ${res.status}).`);
    error.code = "empty_response";
    error.status = res.status;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    const error = new Error(`백엔드 응답(JSON)을 해석할 수 없습니다 (HTTP ${res.status}).`);
    error.code = "invalid_json_response";
    error.status = res.status;
    throw error;
  }

  if (!res.ok) {
    const error = new Error(normalizeErrorMessage(res.status, payload));
    error.code = payload?.code || `http_${res.status}`;
    error.status = res.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}
