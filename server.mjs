import { createServer } from "node:http";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RobloxCloud, RobloxError } from "./src/roblox.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(ROOT, "public");
const DATA_DIR = resolve(ROOT, "data");
const DB_PATH = resolve(DATA_DIR, "smart-fountain.sqlite");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_CONFIG = {
  revision: 1,
  events: [],
  settings: {
    header: "Bem-vindo ao Smart Fountain Stage.",
    subtitle: "Uma experiência musical para curtir com amigos.",
    footer: "Aproveite o espetáculo!",
    eventsTitle: "Próximos eventos",
    eventsEmpty: "Nenhum evento disponível.",
    mainSubtitle: "Uma experiência musical para curtir com amigos.",
  },
};

loadEnv();

function loadEnv() {
  const envFile = resolve(ROOT, ".env");
  if (!existsSync(envFile)) return;
  for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

function requiredAdminConfig() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error("Configure ADMIN_USERNAME e ADMIN_PASSWORD no arquivo .env.");
  }
  return { username, password };
}

export function initializeDatabase(path = DB_PATH) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      username TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      delivery TEXT NOT NULL
    );
  `);
  const row = db.prepare("SELECT value FROM app_config WHERE id = 1").get();
  if (!row) {
    db.prepare("INSERT INTO app_config (id, value, updated_at) VALUES (1, ?, ?)").run(
      JSON.stringify(DEFAULT_CONFIG),
      new Date().toISOString(),
    );
  }
  return db;
}

function readConfig(db) {
  const config = JSON.parse(db.prepare("SELECT value FROM app_config WHERE id = 1").get().value);
  const settings = config.settings ?? {};
  config.settings = {
    header: settings.header ?? settings.welcomeText ?? DEFAULT_CONFIG.settings.header,
    subtitle: settings.subtitle ?? settings.gameDescription ?? DEFAULT_CONFIG.settings.subtitle,
    footer: settings.footer ?? DEFAULT_CONFIG.settings.footer,
    eventsTitle: settings.eventsTitle ?? DEFAULT_CONFIG.settings.eventsTitle,
    eventsEmpty: settings.eventsEmpty ?? DEFAULT_CONFIG.settings.eventsEmpty,
    mainSubtitle: settings.mainSubtitle ?? settings.gameDescription ?? DEFAULT_CONFIG.settings.mainSubtitle,
  };
  return config;
}

function saveConfigLocally(db, config, actor, action, details, delivery) {
  const now = new Date().toISOString();
  const transaction = db.prepare("UPDATE app_config SET value = ?, updated_at = ? WHERE id = 1");
  const audit = db.prepare("INSERT INTO audit_log (created_at, actor, action, details, delivery) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    transaction.run(JSON.stringify(config), now);
    const auditResult = audit.run(now, actor, action, JSON.stringify(details), delivery);
    db.exec("COMMIT");
    return Number(auditResult.lastInsertRowid);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function recordAudit(db, actor, action, details, delivery) {
  db.prepare("INSERT INTO audit_log (created_at, actor, action, details, delivery) VALUES (?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), actor, action, JSON.stringify(details), delivery);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkPassword(candidate, expected) {
  const salt = "smart-fountain-admin-v1";
  const actualHash = scryptSync(candidate, salt, 64);
  const expectedHash = scryptSync(expected, salt, 64);
  return timingSafeEqual(actualHash, expectedHash);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { return [key, decodeURIComponent(value)]; } catch { return [key, value]; }
  }).filter(([key]) => key));
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

async function readJson(req, maxBytes = 32_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("A solicitação excede o limite permitido."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("O corpo da solicitação não contém JSON válido."), { status: 400 });
  }
}

function validateEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Evento inválido."), { status: 400 });
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const date = typeof input.date === "string" ? input.date.trim() : "";
  const image = typeof input.image === "string" ? input.image.trim() : "";
  if (!title || title.length > 80) throw Object.assign(new Error("O título deve conter entre 1 e 80 caracteres."), { status: 400 });
  if (description.length > 3000) throw Object.assign(new Error("A descrição deve ter no máximo 3000 caracteres."), { status: 400 });
  if (date) {
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      throw Object.assign(new Error("Informe uma data válida."), { status: 400 });
    }
  }
  if (image && image.length > 500) throw Object.assign(new Error("O endereço da imagem é muito longo."), { status: 400 });
  if (image && !/^https:\/\/\S+$/i.test(image) && !/^rbxassetid:\/\/\d+$/i.test(image)) {
    throw Object.assign(new Error("A imagem deve usar HTTPS ou o formato rbxassetid://ID."), { status: 400 });
  }
  return { title, description, date, image };
}

function validateSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Configurações inválidas."), { status: 400 });
  const limits = { header: 250, subtitle: 500, footer: 250, eventsTitle: 100, eventsEmpty: 250, mainSubtitle: 500 };
  const settings = {};
  for (const [field, maxLength] of Object.entries(limits)) {
    const value = typeof input[field] === "string" ? input[field].trim() : "";
    if ((field !== "footer" && !value) || value.length > maxLength) {
      throw Object.assign(new Error(`O campo ${field} deve conter no máximo ${maxLength} caracteres e não pode ficar vazio.`), { status: 400 });
    }
    settings[field] = value;
  }
  return settings;
}

function validateMusic(input) {
  const action = input?.action;
  if (!["play", "pause", "resume", "stop", "restart", "volume"].includes(action)) {
    throw Object.assign(new Error("Ação musical inválida."), { status: 400 });
  }
  if (action === "play") {
    const soundId = typeof input.soundId === "string" ? input.soundId.trim() : "";
    if (!/^(rbxassetid:\/\/)?\d{1,20}$/.test(soundId)) throw Object.assign(new Error("Informe um ID de áudio Roblox válido."), { status: 400 });
    return { action: "music.play", id: soundId.replace(/^rbxassetid:\/\//, "") };
  }
  if (action === "volume") {
    if (typeof input.volume !== "number" || !Number.isFinite(input.volume) || input.volume < 0 || input.volume > 1) {
      throw Object.assign(new Error("O volume deve estar entre 0 e 1."), { status: 400 });
    }
    return { action: "music.volume", volume: input.volume };
  }
  return { action: `music.${action}` };
}

function messageEvent(event) {
  return { name: event.title, date: event.date, description: event.description };
}

function mimeType(path) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
  })[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function rateLimiter() {
  const buckets = new Map();
  return (key, limit, windowMs) => {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };
}

export function createApp({ db = initializeDatabase(), env = process.env, fetchImpl = fetch } = {}) {
  const cloud = new RobloxCloud({ env, fetchImpl });
  const allowRequest = rateLimiter();
  let configMutationQueue = Promise.resolve();
  const serializeConfigMutation = (operation) => {
    const result = configMutationQueue.then(operation);
    configMutationQueue = result.catch(() => {});
    return result;
  };
  const credentials = {
    username: env.ADMIN_USERNAME?.trim() ?? "",
    password: env.ADMIN_PASSWORD ?? "",
  };

  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    const address = req.socket.remoteAddress ?? "unknown";
    const url = new URL(req.url ?? "/", "http://localhost");
    const isApi = url.pathname.startsWith("/api/");
    if (isApi && !allowRequest(`api:${address}`, 120, 60_000)) return sendJson(res, 429, { error: "Muitas solicitações. Aguarde um minuto." });
    const cookies = parseCookies(req.headers.cookie);

    try {
      if (url.pathname === "/api/login" && req.method === "POST") {
        if (!allowRequest(`login:${address}`, 5, 15 * 60_000)) return sendJson(res, 429, { error: "Muitas tentativas de login. Aguarde 15 minutos." });
        const body = await readJson(req, 2_000);
        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!credentials.username || !credentials.password) return sendJson(res, 503, { error: "Configure o administrador no arquivo .env antes de entrar." });
        const passwordMatches = checkPassword(password, credentials.password);
        if (!secureEqual(username, credentials.username) || !passwordMatches) {
          recordAudit(db, username.slice(0, 100) || "desconhecido", "login_failed", {}, "not_sent");
          return sendJson(res, 401, { error: "Usuário ou senha incorretos." });
        }
        const token = randomBytes(32).toString("base64url");
        const csrf = randomBytes(24).toString("base64url");
        const expiresAt = Date.now() + SESSION_TTL_MS;
        db.prepare("INSERT INTO admin_sessions (token_hash, csrf_token, username, expires_at) VALUES (?, ?, ?, ?)")
          .run(hash(token), csrf, credentials.username, expiresAt);
        recordAudit(db, credentials.username, "login", {}, "local");
        const secure = env.NODE_ENV === "production" ? "; Secure" : "";
        return sendJson(res, 200, { username: credentials.username }, {
          "set-cookie": `sfc_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`,
          "x-csrf-token": csrf,
        });
      }

      if (url.pathname === "/api/logout" && req.method === "POST") {
        const session = getSession(db, cookies.sfc_session);
        if (!session) return sendJson(res, 401, { error: "Sessão expirada." });
        if (!secureEqual(req.headers["x-csrf-token"] ?? "", session.csrf_token)) return sendJson(res, 403, { error: "Token de segurança inválido." });
        db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hash(cookies.sfc_session));
        const secure = env.NODE_ENV === "production" ? "; Secure" : "";
        return sendJson(res, 200, { ok: true }, { "set-cookie": `sfc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
      }

      const session = getSession(db, cookies.sfc_session);
      if (url.pathname === "/api/session" && req.method === "GET") {
        if (!session) return sendJson(res, 401, { authenticated: false });
        return sendJson(res, 200, { authenticated: true, username: session.username, csrfToken: session.csrf_token });
      }

      if (isApi) {
        if (!session) return sendJson(res, 401, { error: "Entre como administrador para continuar." });
        if (!["GET", "HEAD"].includes(req.method ?? "")) {
          if (req.headers.origin) {
            let originHost;
            try { originHost = new URL(req.headers.origin).host; } catch { return sendJson(res, 403, { error: "Origem da solicitação não permitida." }); }
            if (originHost !== req.headers.host) return sendJson(res, 403, { error: "Origem da solicitação não permitida." });
          }
          if (!secureEqual(req.headers["x-csrf-token"] ?? "", session.csrf_token)) return sendJson(res, 403, { error: "Token de segurança inválido." });
        }

        if (url.pathname === "/api/dashboard" && req.method === "GET") {
          const config = readConfig(db);
          const latest = db.prepare("SELECT created_at, action, delivery FROM audit_log ORDER BY id DESC LIMIT 1").get();
          return sendJson(res, 200, {
            config,
            eventCount: config.events.length,
            roblox: cloud.status(),
            latestAction: latest ?? null,
          });
        }

        if (url.pathname === "/api/events" && req.method === "POST") {
          const event = validateEvent(await readJson(req));
          event.id = randomBytes(12).toString("hex");
          return await serializeConfigMutation(() => {
            const config = readConfig(db);
            if (config.events.length >= 100) return sendJson(res, 400, { error: "O limite é de 100 eventos." });
            config.events.push(event);
            return updateConfig(db, cloud, res, config, session.username, "event_created", { id: event.id, title: event.title }, {
              action: "events.add",
              event: messageEvent(event),
            });
          });
        }

        const eventRoute = url.pathname.match(/^\/api\/events\/([a-f0-9]{24})$/);
        if (eventRoute && req.method === "PUT") {
          const replacement = validateEvent(await readJson(req));
          return await serializeConfigMutation(() => {
            const config = readConfig(db);
            const index = config.events.findIndex((event) => event.id === eventRoute[1]);
            if (index < 0) return sendJson(res, 404, { error: "Evento não encontrado." });
            config.events[index] = { ...replacement, id: eventRoute[1] };
            return updateConfig(db, cloud, res, config, session.username, "event_updated", { id: eventRoute[1], title: config.events[index].title }, {
              action: "events.update",
              id: eventRoute[1],
              event: messageEvent(config.events[index]),
            });
          });
        }
        if (eventRoute && req.method === "DELETE") {
          return await serializeConfigMutation(() => {
            const config = readConfig(db);
            const event = config.events.find((item) => item.id === eventRoute[1]);
            if (!event) return sendJson(res, 404, { error: "Evento não encontrado." });
            config.events = config.events.filter((item) => item.id !== eventRoute[1]);
            return updateConfig(db, cloud, res, config, session.username, "event_deleted", { id: event.id, title: event.title }, {
              action: "events.remove",
              id: event.id,
            });
          });
        }

        if (url.pathname === "/api/events/reorder" && req.method === "POST") {
          const body = await readJson(req);
          const ids = body.ids;
          if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
            return sendJson(res, 400, { error: "A ordem dos eventos enviada não corresponde à lista atual." });
          }
          return await serializeConfigMutation(() => {
            const config = readConfig(db);
            if (ids.length !== config.events.length || new Set(ids).size !== ids.length
              || ids.some((id) => !config.events.some((event) => event.id === id))) {
              return sendJson(res, 400, { error: "A ordem dos eventos enviada não corresponde à lista atual." });
            }
            const byId = new Map(config.events.map((event) => [event.id, event]));
            config.events = ids.map((id) => byId.get(id));
            return updateConfig(db, cloud, res, config, session.username, "events_reordered", { count: ids.length }, {
              action: "events.set",
              events: config.events.map(messageEvent),
            });
          });
        }

        if (url.pathname === "/api/settings" && req.method === "PUT") {
          const settings = validateSettings(await readJson(req));
          return await serializeConfigMutation(() => {
            const config = readConfig(db);
            config.settings = settings;
            return updateConfig(db, cloud, res, config, session.username, "settings_updated", { fields: Object.keys(config.settings) }, {
              action: "config.set",
              texts: config.settings,
            });
          });
        }

        if (url.pathname === "/api/music" && req.method === "POST") {
          const command = validateMusic(await readJson(req));
          return await sendCommand(db, cloud, res, session.username, command, command.action.replace("music.", "music_"));
        }

        if (url.pathname === "/api/announcements" && req.method === "POST") {
          const body = await readJson(req);
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message || message.length > 500 || Buffer.byteLength(message, "utf8") > 500) {
            return sendJson(res, 400, { error: "O aviso deve conter de 1 a 500 caracteres e bytes UTF-8." });
          }
          return await sendCommand(db, cloud, res, session.username, {
            action: "notice",
            message,
          }, "announcement_sent");
        }

        if (url.pathname === "/api/history" && req.method === "GET") {
          const rows = db.prepare("SELECT id, created_at, actor, action, details, delivery FROM audit_log ORDER BY id DESC LIMIT 100").all();
          return sendJson(res, 200, { entries: rows.map((row) => ({ ...row, details: JSON.parse(row.details) })) });
        }

        if (url.pathname === "/api/roblox/test" && req.method === "POST") {
          try {
            const result = await cloud.testConnection();
            recordAudit(db, session.username, "roblox_connection_test", { entryExists: result.entryExists }, "accepted");
            return sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            recordAudit(db, session.username, "roblox_connection_test", {}, "failed");
            throw error;
          }
        }

        return sendJson(res, 404, { error: "Rota não encontrada." });
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        return res.end();
      }
      const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const filePath = resolve(PUBLIC_DIR, `.${requestedPath}`);
      const pathFromPublic = relative(PUBLIC_DIR, filePath);
      if (pathFromPublic.startsWith(`..${sep}`) || pathFromPublic === ".." || isAbsolute(pathFromPublic)) {
        return sendJson(res, 403, { error: "Acesso negado." });
      }
      let contents;
      try {
        contents = readFileSync(filePath);
      } catch {
        contents = readFileSync(join(PUBLIC_DIR, "index.html"));
      }
      res.writeHead(200, {
        "content-type": mimeType(filePath.endsWith("index.html") ? "index.html" : filePath),
        "cache-control": "no-cache",
        "content-length": contents.length,
      });
      return res.end(req.method === "HEAD" ? undefined : contents);
    } catch (error) {
      const status = error.status ?? (error instanceof RobloxError ? 502 : 500);
      const message = error instanceof RobloxError ? error.message : error.message ?? "Erro interno.";
      if (status >= 500) console.error(error);
      return sendJson(res, status, { error: message, ...(error.persisted ? { persisted: true } : {}) });
    }
  });
  return { server, db };
}

function getSession(db, token) {
  if (!token) return null;
  const now = Date.now();
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  return db.prepare("SELECT token_hash, csrf_token, username, expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
    .get(hash(token), now) ?? null;
}

async function updateConfig(db, cloud, res, config, actor, action, details, message) {
  if (Buffer.byteLength(JSON.stringify(message), "utf8") > 1024) {
    return sendJson(res, 413, { error: "O comando excede o limite de 1 KiB da Roblox Messaging Service. Reduza os textos ou a quantidade de eventos." });
  }
  config.revision += 1;
  const serializedSize = Buffer.byteLength(JSON.stringify(config), "utf8");
  if (serializedSize > 32_000) return sendJson(res, 413, { error: "As configurações excedem o limite de 32 KB para sincronização segura com os clientes do jogo." });
  try {
    await cloud.writeConfig(config);
  } catch (error) {
    recordAudit(db, actor, action, details, "failed");
    throw error;
  }
  const auditId = saveConfigLocally(db, config, actor, action, details, "pending");
  try {
    await cloud.publish(message);
    db.prepare("UPDATE audit_log SET delivery = 'accepted' WHERE id = ?").run(auditId);
    return sendJson(res, 200, { config, delivery: "accepted" });
  } catch (error) {
    db.prepare("UPDATE audit_log SET delivery = 'persisted_only' WHERE id = ?").run(auditId);
    error.persisted = true;
    throw error;
  }
}

async function sendCommand(db, cloud, res, actor, command, action) {
  try {
    const result = await cloud.publish(command);
    recordAudit(db, actor, action, command, "accepted");
    return sendJson(res, 200, { ok: true, delivery: "accepted", requestId: result.requestId ?? null });
  } catch (error) {
    recordAudit(db, actor, action, { action: command.action ?? null }, "failed");
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requiredAdminConfig();
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT deve ser uma porta válida.");
    const app = createApp();
    const host = process.env.HOST?.trim() || "127.0.0.1";
    app.server.listen(port, host, () => console.log(`Smart Fountain Control disponível em http://localhost:${port}`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
