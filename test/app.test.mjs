import test from "node:test";
import assert from "node:assert/strict";
import { createApp, initializeDatabase } from "../server.mjs";

async function setup(t, { publishStatus = 200, adminPassword = "a-very-strong-test-password" } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes(":publishMessage")) {
      return new Response(publishStatus === 200 ? "" : '{"message":"denied"}', {
        status: publishStatus,
        headers: { "x-request-id": "roblox-request-1" },
      });
    }
    if (options.method === "PATCH") return new Response("", { status: 200 });
    if (options.method === "POST") return new Response("", { status: 200 });
    if (options.method === "GET") return new Response("not found", { status: 404 });
    throw new Error(`Unexpected Roblox request: ${options.method} ${url}`);
  };
  const env = {
    ADMIN_USERNAME: "stage-admin",
    ADMIN_PASSWORD: adminPassword,
    ROBLOX_API_KEY: "test-key-not-a-real-credential",
    ROBLOX_UNIVERSE_ID: "123456",
    ROBLOX_MESSAGING_TOPIC: "SmartFountainControl",
    ROBLOX_DATASTORE_NAME: "SmartFountainControl",
    ROBLOX_DATASTORE_ENTRY_KEY: "Configuration",
  };
  const db = initializeDatabase(":memory:");
  const { server } = createApp({ db, env, fetchImpl });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const csrf = login.headers.get("x-csrf-token");
  const api = (path, method = "GET", body) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, "x-csrf-token": csrf, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const apiWithoutCsrf = (path, method, body) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { api, apiWithoutCsrf, calls, db, baseUrl };
}

test("the configured administrator can use a password shorter than 12 characters", async (t) => {
  const { api } = await setup(t, { adminPassword: "curta" });
  const response = await api("/api/dashboard");
  assert.equal(response.status, 200);
});

test("event changes persist in SQLite and sync through Open Cloud DataStores and Messaging Service", async (t) => {
  const { api, calls, db } = await setup(t);
  const response = await api("/api/events", "POST", {
    title: "Noite de luzes",
    description: "Evento especial no palco.",
    date: "2026-12-01",
    image: "rbxassetid://12345",
  });

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.delivery, "accepted");
  assert.equal(result.config.revision, 2);
  assert.equal(result.config.events[0].title, "Noite de luzes");
  assert.equal(JSON.stringify(result).includes("test-key-not-a-real-credential"), false);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM app_config WHERE id = 1").get().value).events.length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/data-stores\/SmartFountainControl\/entries\/Configuration\?allowMissing=true$/);
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(JSON.parse(calls[0].options.body).value.revision, 2);
  const publish = calls[1];
  assert.equal(publish.url, "https://apis.roblox.com/cloud/v2/universes/123456:publishMessage");
  assert.equal(publish.options.headers["x-api-key"], "test-key-not-a-real-credential");
  assert.equal(publish.options.headers["content-type"], "application/json");
  const publishBody = JSON.parse(publish.options.body);
  assert.equal(publishBody.topic, "SmartFountainControl");
  assert.deepEqual(JSON.parse(publishBody.message), {
    action: "events.add",
    event: { name: "Noite de luzes", date: "2026-12-01", description: "Evento especial no palco." },
  });
  const history = db.prepare("SELECT action, delivery FROM audit_log ORDER BY id DESC LIMIT 1").get();
  assert.equal(history.action, "event_created");
  assert.equal(history.delivery, "accepted");
});

test("invalid inputs and requests without CSRF are rejected before contacting Roblox", async (t) => {
  const { api, apiWithoutCsrf, calls, baseUrl } = await setup(t);
  const unauthorized = await fetch(`${baseUrl}/api/events`, { method: "POST" });
  assert.equal(unauthorized.status, 401);
  const missingCsrf = await apiWithoutCsrf("/api/announcements", "POST", { message: "Atualização!" });
  assert.equal(missingCsrf.status, 403);

  const invalid = await api("/api/events", "POST", {
    title: "Evento",
    description: "",
    date: "",
    image: "javascript:alert(1)",
  });
  assert.equal(invalid.status, 400);
  const impossibleDate = await api("/api/events", "POST", {
    title: "Evento",
    description: "",
    date: "2026-99-99",
    image: "",
  });
  assert.equal(impossibleDate.status, 400);
  assert.equal(calls.length, 0);
});

test("a successful DataStore write is retained and audited if notifying live servers fails", async (t) => {
  const { api, calls, db } = await setup(t, { publishStatus: 403 });
  const response = await api("/api/settings", "PUT", {
    header: "Bem-vindos!",
    subtitle: "Palco ao vivo.",
    footer: "Até breve.",
    eventsTitle: "Eventos",
    eventsEmpty: "Sem eventos.",
    mainSubtitle: "Música para todos.",
  });

  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.persisted, true);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM app_config WHERE id = 1").get().value).settings.header, "Bem-vindos!");
  assert.equal(calls.length, 2);
  const history = db.prepare("SELECT action, delivery FROM audit_log ORDER BY id DESC LIMIT 1").get();
  assert.equal(history.action, "settings_updated");
  assert.equal(history.delivery, "persisted_only");
});

test("music and notice commands use the exact action schema", async (t) => {
  const { api, calls } = await setup(t);
  const response = await api("/api/music", "POST", { action: "play", soundId: "123456789" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse(calls[0].options.body).message), { action: "music.play", id: "123456789" });

  for (const [action, expected] of [
    ["pause", { action: "music.pause" }],
    ["resume", { action: "music.resume" }],
    ["stop", { action: "music.stop" }],
    ["restart", { action: "music.restart" }],
    ["volume", { action: "music.volume", volume: 0.5 }],
  ]) {
    const body = action === "volume" ? { action, volume: 0.5 } : { action };
    const commandResponse = await api("/api/music", "POST", body);
    assert.equal(commandResponse.status, 200);
    assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).options.body).message), expected);
  }

  const notice = await api("/api/announcements", "POST", { message: "Bem-vindos!" });
  assert.equal(notice.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).options.body).message), {
    action: "notice",
    message: "Bem-vindos!",
  });

  const invalid = await api("/api/announcements", "POST", { message: "x".repeat(501) });
  assert.equal(invalid.status, 400);
  const invalidVolume = await api("/api/music", "POST", { action: "volume", volume: 1.1 });
  assert.equal(invalidVolume.status, 400);
  assert.equal(calls.length, 7);
});

test("event edits, ordering, and menu texts publish the documented action payloads", async (t) => {
  const { api, calls } = await setup(t);
  const event = { title: "Casamento", date: "2026-12-20", description: "Cerimônia", image: "" };
  const created = await api("/api/events", "POST", event);
  const createdResult = await created.json();
  const id = createdResult.config.events[0].id;
  assert.deepEqual(JSON.parse(JSON.parse(calls[1].options.body).message), {
    action: "events.add",
    event: { name: "Casamento", date: "2026-12-20", description: "Cerimônia" },
  });

  const updated = await api(`/api/events/${id}`, "PUT", { ...event, title: "Casamento atualizado" });
  assert.equal(updated.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse(calls[3].options.body).message), {
    action: "events.update",
    id,
    event: { name: "Casamento atualizado", date: "2026-12-20", description: "Cerimônia" },
  });

  const second = await api("/api/events", "POST", { ...event, title: "Festa" });
  assert.equal(second.status, 200);
  const reordered = await api("/api/events/reorder", "POST", { ids: [id, (await second.json()).config.events[1].id] });
  assert.equal(reordered.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse(calls[7].options.body).message), {
    action: "events.set",
    events: [
      { name: "Casamento atualizado", date: "2026-12-20", description: "Cerimônia" },
      { name: "Festa", date: "2026-12-20", description: "Cerimônia" },
    ],
  });

  const removed = await api(`/api/events/${id}`, "DELETE");
  assert.equal(removed.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse(calls[9].options.body).message), { action: "events.remove", id });

  const texts = {
    header: "Smart Fountain Stage",
    subtitle: "Subtitle",
    footer: "Footer",
    eventsTitle: "Events",
    eventsEmpty: "No events",
    mainSubtitle: "Main subtitle",
  };
  const settings = await api("/api/settings", "PUT", texts);
  assert.equal(settings.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse(calls[11].options.body).message), { action: "config.set", texts });
});

test("the integration check accepts a missing initial entry as an API response", async (t) => {
  const { api, calls } = await setup(t);
  const response = await api("/api/roblox/test", "POST", {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    message: "A Roblox Open Cloud aceitou a consulta ao DataStore.",
    entryExists: false,
  });
  assert.equal(calls[0].options.method, "GET");
});

test("oversized event commands are rejected before changing DataStore or local configuration", async (t) => {
  const { api, calls, db } = await setup(t);
  const response = await api("/api/events", "POST", {
    title: "Evento",
    description: "x".repeat(1500),
    date: "",
    image: "",
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /1 KiB/);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM app_config WHERE id = 1").get().value).events.length, 0);
});

test("legacy saved menu texts are mapped to the new protocol fields", async (t) => {
  const { api, db } = await setup(t);
  db.prepare("UPDATE app_config SET value = ? WHERE id = 1").run(JSON.stringify({
    revision: 1,
    events: [],
    settings: { welcomeText: "Old header", gameDescription: "Old description" },
  }));
  const response = await api("/api/dashboard");
  assert.equal(response.status, 200);
  const { config } = await response.json();
  assert.deepEqual(config.settings, {
    header: "Old header",
    subtitle: "Old description",
    footer: "Aproveite o espetáculo!",
    eventsTitle: "Próximos eventos",
    eventsEmpty: "Nenhum evento disponível.",
    mainSubtitle: "Old description",
  });
});
