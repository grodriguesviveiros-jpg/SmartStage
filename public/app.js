const loginScreen = document.querySelector("#loginScreen");
const appShell = document.querySelector("#appShell");
const pageContent = document.querySelector("#pageContent");
const toast = document.querySelector("#toast");
const viewTitles = {
  dashboard: "Visão geral",
  events: "Eventos",
  music: "Música",
  announcements: "Avisos",
  settings: "Configurações",
  history: "Histórico",
};

let csrfToken = "";
let currentUser = "";
let currentConfig = null;
let activeView = "dashboard";
let toastTimer;

function showToast(message, kind = "success") {
  toast.textContent = message;
  toast.className = `toast show${kind === "success" ? "" : ` ${kind}`}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 4000);
}

async function handleConfigFailure(error, view, overlay = null) {
  if (!error.persisted) {
    showToast(error.message, "error");
    return;
  }
  overlay?.remove();
  showToast(`Configuração salva, mas a notificação aos servidores falhou: ${error.message}`, "warning");
  await loadView(view);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body) headers["content-type"] = "application/json";
  if (options.method && options.method !== "GET") headers["x-csrf-token"] = csrfToken;
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") showLogin();
    const error = new Error(body.error ?? `Solicitação falhou (${response.status}).`);
    error.status = response.status;
    error.persisted = body.persisted === true;
    throw error;
  }
  const responseCsrf = response.headers.get("x-csrf-token");
  if (responseCsrf) csrfToken = responseCsrf;
  return body;
}

function showLogin() {
  loginScreen.hidden = false;
  appShell.hidden = true;
  csrfToken = "";
  currentUser = "";
}

function showApp(user) {
  loginScreen.hidden = true;
  appShell.hidden = false;
  currentUser = user;
  document.querySelector("#adminName").textContent = user;
  document.querySelector(".avatar").textContent = user.slice(0, 1).toUpperCase();
}

function formatDate(value, dateOnly = false) {
  if (!value) return "Sem data";
  const date = new Date(dateOnly ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", dateOnly
    ? { day: "2-digit", month: "short", year: "numeric" }
    : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function escapeText(text) {
  return String(text ?? "");
}

function escapeHtml(text) {
  return escapeText(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function pageHeader(kicker, title, description, action = "") {
  return `<div class="page-heading"><div><span class="page-kicker">${kicker}</span><h1>${title}</h1><p>${description}</p></div>${action ? `<div class="heading-actions">${action}</div>` : ""}</div>`;
}

function emptyState(icon, title, description) {
  const element = document.createElement("div");
  element.className = "empty-state";
  const graphic = document.createElement("div");
  graphic.className = "empty-graphic";
  graphic.textContent = icon;
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.className = "empty-state-copy";
  copy.textContent = description;
  element.append(graphic, heading, copy);
  return element;
}

function setConnectionStatus(roblox) {
  const dot = document.querySelector("#connectionDot");
  const label = document.querySelector("#connectionLabel");
  if (!roblox?.configured) {
    dot.classList.add("status-offline");
    label.textContent = "Integração não configurada";
    return;
  }
  if (roblox.lastResponse?.accepted) {
    dot.classList.remove("status-offline");
    label.textContent = "Roblox Open Cloud conectada";
  } else {
    dot.classList.add("status-offline");
    label.textContent = "Credenciais configuradas";
  }
}

function actionLabel(action) {
  const labels = {
    login: "Login administrativo",
    login_failed: "Tentativa de login recusada",
    event_created: "Evento adicionado",
    event_updated: "Evento editado",
    event_deleted: "Evento removido",
    events_reordered: "Ordem dos eventos atualizada",
    settings_updated: "Configurações editadas",
    music_play: "Música alterada",
    music_pause: "Música pausada",
    music_resume: "Música retomada",
    music_stop: "Música parada",
    music_restart: "Música reiniciada",
    music_volume: "Volume ajustado",
    announcement_sent: "Aviso enviado",
    roblox_connection_test: "Teste da integração",
  };
  return labels[action] ?? action;
}

function deliveryLabel(delivery) {
  return ({
    accepted: "Aceito pela Roblox",
    persisted_only: "Salvo · notificação falhou",
    pending: "Pendente",
    failed: "Falhou",
    local: "Registro local",
    not_sent: "Não enviado",
  })[delivery] ?? delivery;
}

function renderActivity(entries) {
  const list = document.createElement("div");
  list.className = "activity-list";
  if (!entries.length) return emptyState("↺", "Ainda sem atividade", "As alterações administrativas aparecerão aqui.");
  for (const entry of entries.slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "activity-item";
    const icon = document.createElement("span");
    icon.className = "activity-icon";
    icon.textContent = entry.action.includes("music") ? "♫" : entry.action.includes("event") ? "▤" : "↗";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = actionLabel(entry.action);
    const meta = document.createElement("small");
    meta.textContent = `${entry.actor} · ${formatDate(entry.created_at)}`;
    copy.append(title, meta);
    row.append(icon, copy);
    list.append(row);
  }
  return list;
}

function renderDashboard(dashboard, history) {
  const roblox = dashboard.roblox;
  const accepted = roblox.lastResponse?.accepted;
  pageContent.innerHTML = `${pageHeader("PAINEL DE OPERAÇÕES", "Visão geral", "Acompanhe e gerencie as configurações ao vivo do Smart Fountain Stage.")}<div class="stats-grid">
    <article class="card stat-card"><div class="stat-top"><span>Eventos publicados</span><span class="stat-icon">▤</span></div><strong class="stat-value">${dashboard.eventCount}</strong><div class="stat-subtitle">Exibidos no menu do jogo</div></article>
    <article class="card stat-card"><div class="stat-top"><span>Roblox Open Cloud</span><span class="stat-icon">⌁</span></div><strong class="stat-value stat-value-compact">${roblox.configured ? (accepted ? "Respondeu" : "Configurada") : "Pendente"}</strong><div class="stat-subtitle">${accepted ? "Resposta HTTP recebida" : "Aguardando configuração/teste"}</div></article>
    <article class="card stat-card"><div class="stat-top"><span>Revisão atual</span><span class="stat-icon">↻</span></div><strong class="stat-value">#${dashboard.config.revision}</strong><div class="stat-subtitle">Configuração persistente</div></article>
    <article class="card stat-card"><div class="stat-top"><span>Última alteração</span><span class="stat-icon">◷</span></div><strong class="stat-value stat-value-date">${dashboard.latestAction ? formatDate(dashboard.latestAction.created_at) : "—"}</strong><div class="stat-subtitle">${dashboard.latestAction ? actionLabel(dashboard.latestAction.action) : "Nenhuma alteração registrada"}</div></article>
  </div>
  <div class="dashboard-grid">
    <article class="card integration-card"><div class="card-header"><div><h2>Conexão com a Roblox</h2><p>Open Cloud · Messaging Service · DataStore</p></div><button id="testRoblox" class="button button-small">Testar conexão</button></div>
      <div class="integration-status"><div class="integration-orb">⌁</div><div><h3>${roblox.configured ? (accepted ? "Open Cloud respondeu" : "Aguardando validação") : "Integração não configurada"}</h3><p>${roblox.message}</p></div></div>
      <div class="integration-meta"><div><span class="meta-label">Messaging topic</span><span class="meta-value">${escapeHtml(roblox.topic)}</span></div><div><span class="meta-label">DataStore</span><span class="meta-value">${escapeHtml(roblox.dataStoreName)}</span></div></div>
    </article>
    <article class="card"><div class="card-header"><div><h2>Atividade recente</h2><p>Alterações administrativas</p></div><button class="button button-small" data-nav="history">Ver histórico</button></div><div class="card-body" id="recentActivity"></div></article>
  </div>`;
  setConnectionStatus(roblox);
  document.querySelector("#recentActivity").append(renderActivity(history.entries));
  document.querySelector("#testRoblox").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Testando...";
    try {
      const result = await request("/api/roblox/test", { method: "POST", body: "{}" });
      showToast(result.entryExists ? result.message : "Open Cloud respondeu. A chave do DataStore ainda não existe; salve uma configuração para criá-la.", result.entryExists ? "success" : "warning");
      await loadView("dashboard");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Testar conexão";
    }
  });
}

function renderEvents(config) {
  const action = '<button id="newEvent" class="button button-primary">＋ Novo evento</button>';
  pageContent.innerHTML = `${pageHeader("CONTEÚDO DO JOGO", "Eventos", "Organize os cards exibidos no menu inicial do jogo. A ordem abaixo é a ordem mostrada aos jogadores.", action)}<article class="card"><div class="card-header"><div><h2>Lista de eventos</h2><p>${config.events.length} evento(s) · use as setas para mudar a ordem</p></div></div><div class="card-body"><div id="eventList" class="event-list"></div></div></article>`;
  const list = document.querySelector("#eventList");
  if (!config.events.length) list.append(emptyState("▤", "Nenhum evento cadastrado", "Adicione seu primeiro evento para exibi-lo no menu do jogo."));
  for (const [index, item] of config.events.entries()) list.append(makeEventRow(item, index, config.events.length));
  document.querySelector("#newEvent").addEventListener("click", () => openEventForm());
}

function makeEventRow(item, index, count) {
  const row = document.createElement("div");
  row.className = "event-row";
  const image = document.createElement("div");
  image.className = "event-thumb";
  if (item.image && /^https:\/\//i.test(item.image)) {
    const img = document.createElement("img");
    img.src = item.image;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    image.append(img);
  } else image.textContent = "♫";
  const copy = document.createElement("div");
  copy.className = "event-copy";
  const title = document.createElement("strong");
  title.textContent = item.title;
  const description = document.createElement("p");
  description.textContent = item.description || "Sem descrição";
  const date = document.createElement("small");
  date.textContent = formatDate(item.date, true);
  copy.append(title, description, date);
  const actions = document.createElement("div");
  actions.className = "event-actions";
  const moveUp = actionButton("↑", "Mover para cima", () => reorderEvent(index, -1), index === 0);
  const moveDown = actionButton("↓", "Mover para baixo", () => reorderEvent(index, 1), index === count - 1);
  const edit = actionButton("✎", "Editar evento", () => openEventForm(item));
  const remove = actionButton("×", "Excluir evento", () => deleteEvent(item));
  actions.append(moveUp, moveDown, edit, remove);
  row.append(image, copy, actions);
  return row;
}

function actionButton(text, label, action, disabled = false) {
  const button = document.createElement("button");
  button.className = "icon-button";
  button.type = "button";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

function openEventForm(item = null) {
  const editing = Boolean(item);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<form class="modal-card" id="eventForm">
    <div class="card-header"><div><span class="page-kicker">MENU DO JOGO</span><h2 class="modal-title">${editing ? "Editar evento" : "Novo evento"}</h2><p>Os campos são sincronizados com o DataStore da experiência.</p></div><button class="icon-button" type="button" data-close aria-label="Fechar">×</button></div>
    <div class="card-body form-grid">
      <label class="full">Título *<input name="title" maxlength="80" required placeholder="Ex.: Noite de luzes" value="${editing ? item.title.replaceAll("&", "&amp;").replaceAll('"', "&quot;") : ""}"></label>
      <label class="full">Descrição<textarea name="description" maxlength="3000" placeholder="Conte aos jogadores sobre este evento">${editing ? item.description.replaceAll("&", "&amp;").replaceAll("<", "&lt;") : ""}</textarea></label>
      <label>Data<input name="date" type="date" value="${editing ? item.date : ""}"></label>
      <label>Imagem (HTTPS ou rbxassetid://)<input name="image" maxlength="500" placeholder="https://... ou rbxassetid://123" value="${editing ? item.image.replaceAll("&", "&amp;").replaceAll('"', "&quot;") : ""}"></label>
    </div>
    <div class="form-actions"><button class="button" type="button" data-close>Cancelar</button><button class="button button-primary" type="submit">${editing ? "Salvar alterações" : "Adicionar evento"}</button></div>
  </form>`;
  document.body.append(overlay);
  overlay.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => overlay.remove()));
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  overlay.querySelector("#eventForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const path = editing ? `/api/events/${item.id}` : "/api/events";
      await request(path, { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      overlay.remove();
      showToast("Evento salvo e publicado na configuração do jogo.");
      await loadView("events");
    } catch (error) {
      await handleConfigFailure(error, "events", overlay);
    } finally { button.disabled = false; }
  });
}

async function deleteEvent(item) {
  if (!window.confirm(`Excluir o evento "${item.title}"?`)) return;
  try {
    await request(`/api/events/${item.id}`, { method: "DELETE" });
    showToast("Evento excluído.");
    await loadView("events");
  } catch (error) { await handleConfigFailure(error, "events"); }
}

async function reorderEvent(index, offset) {
  const events = [...currentConfig.events];
  const target = index + offset;
  [events[index], events[target]] = [events[target], events[index]];
  try {
    await request("/api/events/reorder", { method: "POST", body: JSON.stringify({ ids: events.map((event) => event.id) }) });
    showToast("Ordem atualizada.");
    await loadView("events");
  } catch (error) { await handleConfigFailure(error, "events"); }
}

function renderMusic() {
  pageContent.innerHTML = `${pageHeader("CONTROLE AO VIVO", "Música", "Envie controles para os servidores ativos. O jogo precisa conectar seus scripts de áudio ao evento do painel.")}<div class="music-layout">
    <article class="card music-console"><span class="page-kicker">CONTROLE DE SERVIDOR</span><div class="now-playing music-now-playing"><div class="album-art">♫</div><div><small>SMART FOUNTAIN STAGE</small><strong>Comando de música</strong><p>Altera a reprodução nos servidores inscritos no tópico</p></div></div>
      <form id="musicForm"><label>ID do áudio Roblox<input name="soundId" inputmode="numeric" placeholder="Ex.: 1843529634" autocomplete="off"></label>
      <div class="music-controls"><button class="button button-primary" type="submit">▶ Tocar</button><button class="button" type="button" data-music="pause">Ⅱ Pausar</button><button class="button" type="button" data-music="resume">▶ Retomar</button><button class="button" type="button" data-music="stop">■ Parar</button><button class="button" type="button" data-music="restart">↻ Reiniciar</button></div>
      <div class="range-row"><span>Volume</span><input id="volumeSlider" type="range" min="0" max="100" value="65" aria-label="Volume"><span id="volumeValue" class="volume-value">65%</span><button id="sendVolume" class="button button-small" type="button">Aplicar</button></div></form>
    </article>
    <aside class="side-note"><strong>ⓘ Importante</strong>O painel publica comandos pelo Messaging Service. A Roblox confirma que recebeu o comando, mas não informa quantos servidores o processaram. Seu código de áudio no jogo precisa escutar <code>CommandReceived</code> (detalhes no README).</aside>
  </div>`;
  document.querySelector("#musicForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const soundId = new FormData(event.currentTarget).get("soundId");
    if (!soundId) return showToast("Informe o ID do áudio.", "error");
    await sendMusic({ action: "play", soundId });
  });
  document.querySelectorAll("[data-music]").forEach((button) => button.addEventListener("click", () => sendMusic({ action: button.dataset.music })));
  const slider = document.querySelector("#volumeSlider");
  slider.addEventListener("input", () => { document.querySelector("#volumeValue").textContent = `${slider.value}%`; });
  document.querySelector("#sendVolume").addEventListener("click", () => sendMusic({ action: "volume", volume: Number(slider.value) / 100 }));
}

async function sendMusic(payload) {
  try {
    await request("/api/music", { method: "POST", body: JSON.stringify(payload) });
    showToast("Comando publicado; a Open Cloud não confirma a execução no jogo.");
    await refreshConnection();
  } catch (error) { showToast(error.message, "error"); }
}

function renderAnnouncements() {
  pageContent.innerHTML = `${pageHeader("COMUNICAÇÃO AO VIVO", "Avisos", "Envie uma mensagem para os servidores que estiverem inscritos no tópico do jogo.")}<div class="dashboard-grid">
    <article class="card"><div class="card-header"><div><h2>Novo aviso global</h2><p>A mensagem é publicada agora para os servidores ativos.</p></div></div><div class="card-body">
      <form id="announcementForm" class="form-stack"><label>Mensagem<textarea name="message" maxlength="500" required placeholder="Escreva um aviso claro para os jogadores..."></textarea></label><div class="notice-box">Limite de 500 caracteres. O envio é imediato e não pode ser desfeito.</div><div class="form-actions"><button class="button button-primary" type="submit">Enviar para os servidores <span aria-hidden="true">↗</span></button></div></form>
    </div></article>
    <aside class="side-note"><strong>ⓘ Entrega do aviso</strong>A API confirma o recebimento do pedido de publicação. A Roblox Messaging Service não fornece confirmação individual por servidor nem lista de servidores online.</aside>
  </div>`;
  document.querySelector("#announcementForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = new FormData(form).get("message");
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await request("/api/announcements", { method: "POST", body: JSON.stringify({ message }) });
      form.reset();
      showToast("Publicação aceita pela Open Cloud; entrega não confirmada nos servidores.");
      await refreshConnection();
    } catch (error) { showToast(error.message, "error"); }
    finally { button.disabled = false; }
  });
}

function renderSettings(config) {
  pageContent.innerHTML = `${pageHeader("EXPERIÊNCIA", "Configurações", "Edite os textos que o jogo disponibiliza aos seus scripts. O formato persistido fica no DataStore Roblox.")}<article class="card"><div class="card-header"><div><h2>Textos do jogo</h2><p>Seus scripts Luau devem aplicar os campos recebidos da configuração.</p></div></div><div class="card-body">
    <form id="settingsForm" class="form-grid"><label class="full">Título do menu<input name="header" maxlength="250" required value="${escapeHtml(config.settings.header)}"></label>
      <label class="full">Subtítulo<textarea name="subtitle" maxlength="500" required>${escapeHtml(config.settings.subtitle)}</textarea></label>
      <label class="full">Rodapé<input name="footer" maxlength="250" value="${escapeHtml(config.settings.footer)}"></label>
      <label class="full">Título da seção de eventos<input name="eventsTitle" maxlength="100" required value="${escapeHtml(config.settings.eventsTitle)}"></label>
      <label class="full">Texto quando não houver eventos<textarea name="eventsEmpty" maxlength="250" required>${escapeHtml(config.settings.eventsEmpty)}</textarea></label>
      <label class="full">Subtítulo principal<textarea name="mainSubtitle" maxlength="500" required>${escapeHtml(config.settings.mainSubtitle)}</textarea></label>
      <div class="form-actions full"><button class="button button-primary" type="submit">Salvar configurações</button></div>
    </form></div></article>`;
  document.querySelector("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await request("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      showToast("Textos salvos e publicados com a ação config.set.");
      await loadView("settings");
    } catch (error) { await handleConfigFailure(error, "settings"); }
    finally { button.disabled = false; }
  });
}

function renderHistory(entries) {
  pageContent.innerHTML = `${pageHeader("AUDITORIA", "Histórico", "Registro das alterações administrativas e do resultado informado pela Roblox Open Cloud.")}<article class="card"><div class="card-header"><div><h2>Atividade administrativa</h2><p>Exibindo os últimos ${entries.length} registros.</p></div></div><div class="history-table-wrap"><table class="history-table"><thead><tr><th>Data e hora</th><th>Ação</th><th>Administrador</th><th>Resultado</th></tr></thead><tbody id="historyRows"></tbody></table></div></article>`;
  const rows = document.querySelector("#historyRows");
  if (!entries.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.append(emptyState("↺", "Histórico vazio", "As ações feitas no painel serão registradas aqui."));
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("tr");
    const date = document.createElement("td");
    date.textContent = formatDate(entry.created_at);
    const action = document.createElement("td");
    action.textContent = actionLabel(entry.action);
    const actor = document.createElement("td");
    actor.textContent = entry.actor;
    const delivery = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `delivery-pill ${entry.delivery}`;
    pill.textContent = deliveryLabel(entry.delivery);
    delivery.append(pill);
    row.append(date, action, actor, delivery);
    rows.append(row);
  }
}

async function refreshConnection() {
  const dashboard = await request("/api/dashboard");
  setConnectionStatus(dashboard.roblox);
}

async function loadView(view = activeView) {
  activeView = view;
  document.querySelector("#pageCrumb").textContent = viewTitles[view];
  document.querySelectorAll("[data-nav]").forEach((button) => {
    if (button.classList.contains("nav-item")) button.classList.toggle("active", button.dataset.nav === view);
  });
  pageContent.innerHTML = '<div class="empty-state">Carregando…</div>';
  try {
    if (view === "dashboard") {
      const [dashboard, history] = await Promise.all([request("/api/dashboard"), request("/api/history")]);
      currentConfig = dashboard.config;
      document.querySelector("#eventNavCount").textContent = dashboard.eventCount;
      renderDashboard(dashboard, history);
    } else if (view === "history") {
      const [dashboard, history] = await Promise.all([request("/api/dashboard"), request("/api/history")]);
      currentConfig = dashboard.config;
      document.querySelector("#eventNavCount").textContent = dashboard.eventCount;
      setConnectionStatus(dashboard.roblox);
      renderHistory(history.entries);
    } else {
      const dashboard = await request("/api/dashboard");
      currentConfig = dashboard.config;
      document.querySelector("#eventNavCount").textContent = dashboard.eventCount;
      setConnectionStatus(dashboard.roblox);
      if (view === "events") renderEvents(currentConfig);
      if (view === "music") renderMusic();
      if (view === "announcements") renderAnnouncements();
      if (view === "settings") renderSettings(currentConfig);
    }
  } catch (error) {
    pageContent.innerHTML = "";
    pageContent.append(emptyState("!", "Não foi possível carregar", error.message));
  }
}

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorLabel = document.querySelector("#loginError");
  errorLabel.textContent = "";
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const result = await request("/api/login", { method: "POST", body: JSON.stringify(values) });
    showApp(result.username);
    await loadView("dashboard");
  } catch (error) {
    errorLabel.textContent = error.message;
  } finally { button.disabled = false; }
});

document.querySelectorAll(".side-nav [data-nav], .brand[data-nav]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    loadView(button.dataset.nav);
  });
});

document.querySelector("#pageContent").addEventListener("click", (event) => {
  const button = event.target.closest("[data-nav]");
  if (button) loadView(button.dataset.nav);
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST", body: "{}" });
    showLogin();
  } catch (error) { showToast(error.message, "error"); }
});

async function initialize() {
  try {
    const session = await request("/api/session");
    csrfToken = session.csrfToken;
    showApp(session.username);
    await loadView("dashboard");
  } catch (error) {
    showLogin();
    if (error.status !== 401) showToast(error.message, "error");
  }
}

initialize();
