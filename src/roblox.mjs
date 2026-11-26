export class RobloxError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "RobloxError";
    this.status = status;
  }
}

export class RobloxCloud {
  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    this.apiKey = env.ROBLOX_API_KEY?.trim() ?? "";
    this.universeId = env.ROBLOX_UNIVERSE_ID?.trim() ?? "";
    this.dataStoreName = env.ROBLOX_DATASTORE_NAME?.trim() || "SmartFountainControl";
    this.entryKey = env.ROBLOX_DATASTORE_ENTRY_KEY?.trim() || "Configuration";
    this.topic = env.ROBLOX_MESSAGING_TOPIC?.trim() || "SmartFountainControl";
    this.fetch = fetchImpl;
    this.lastResponse = null;
  }

  status() {
    const configured = Boolean(this.apiKey && this.universeId);
    return {
      configured,
      topic: this.topic,
      dataStoreName: this.dataStoreName,
      lastResponse: this.lastResponse,
      message: configured
        ? "Credenciais configuradas. Use o teste para validar as permissões e o universo."
        : "Preencha ROBLOX_API_KEY e ROBLOX_UNIVERSE_ID no servidor.",
    };
  }

  ensureConfigured() {
    if (!this.apiKey || !this.universeId) {
      throw new RobloxError("A integração Roblox não está configurada. Preencha ROBLOX_API_KEY e ROBLOX_UNIVERSE_ID.", 503);
    }
    if (!/^\d+$/.test(this.universeId)) throw new RobloxError("ROBLOX_UNIVERSE_ID deve conter apenas dígitos.", 503);
    if (!this.topic || this.topic.length > 80) throw new RobloxError("ROBLOX_MESSAGING_TOPIC deve conter de 1 a 80 caracteres.", 503);
    if (!this.dataStoreName || this.dataStoreName.length > 50 || !this.entryKey || this.entryKey.length > 50) {
      throw new RobloxError("O nome do DataStore e a chave devem conter de 1 a 50 caracteres.", 503);
    }
  }

  async request(url, options = {}, allowedStatuses = []) {
    this.ensureConfigured();
    let response;
    try {
      response = await this.fetch(url, {
        ...options,
        signal: AbortSignal.timeout(10_000),
        headers: {
          "x-api-key": this.apiKey,
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
      });
    } catch (error) {
      throw new RobloxError(`Não foi possível conectar à Roblox Open Cloud: ${error.message}`);
    }
    const body = await response.text();
    this.lastResponse = {
      at: new Date().toISOString(),
      status: response.status,
      accepted: response.ok || allowedStatuses.includes(response.status),
    };
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      let detail = body.slice(0, 500);
      try {
        const parsed = JSON.parse(body);
        detail = parsed.message ?? parsed.error ?? detail;
      } catch {}
      throw new RobloxError(`A Roblox Open Cloud respondeu ${response.status}: ${detail}`);
    }
    return { response, body };
  }

  entryUrl(allowMissing = false) {
    const datastore = encodeURIComponent(this.dataStoreName);
    const key = encodeURIComponent(this.entryKey);
    const query = allowMissing ? "?allowMissing=true" : "";
    return `https://apis.roblox.com/cloud/v2/universes/${encodeURIComponent(this.universeId)}/data-stores/${datastore}/entries/${key}${query}`;
  }

  async writeConfig(config) {
    const payload = JSON.stringify({ value: config });
    await this.request(this.entryUrl(true), {
      method: "PATCH",
      body: payload,
    });
  }

  async publish(message) {
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload, "utf8") > 1024) {
      throw new RobloxError("O comando excede o limite de 1 KiB da Roblox Messaging Service.", 400);
    }
    const url = `https://apis.roblox.com/cloud/v2/universes/${encodeURIComponent(this.universeId)}:publishMessage`;
    const { response } = await this.request(url, {
      method: "POST",
      body: JSON.stringify({ topic: this.topic, message: payload }),
    });
    return { requestId: response.headers.get("x-request-id") };
  }

  async testConnection() {
    const result = await this.request(this.entryUrl(), { method: "GET" }, [404]);
    return {
      message: "A Roblox Open Cloud aceitou a consulta ao DataStore.",
      entryExists: result.response.status !== 404,
    };
  }
}
