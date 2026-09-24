"use strict";

if (window.top !== window.self) {
  document.body.textContent = "この在庫管理アプリは埋め込み表示では使用できません。";
  throw new Error("Framed execution blocked.");
}

const CONFIG = Object.freeze({
  supabaseUrl: "https://earxbzdgjklewnsrcjsp.supabase.co",
  publishableKey: "sb_publishable_-0sWkrDunUF7Su1RYn5vTQ_5q1MMJ9k",
  pollIntervalMs: 30_000,
});

const SESSION_KEY = "daisen_inventory_session_v2";
const NOTIFICATION_KEY = "daisen_inventory_notifications_v2";
const MAX_STOCK_CHANGE = 1_000_000;
const ACTION_LABELS = Object.freeze({
  create: "商品追加",
  edit: "商品編集",
  archive: "商品削除",
  restore: "商品復元",
  stock_in: "入庫",
  stock_out: "出庫",
  stock_adjustment: "在庫調整",
});

const state = {
  session: null,
  profile: null,
  items: [],
  archivedItems: [],
  categories: [],
  history: [],
  currentCategory: null,
  currentItemId: null,
  stockDirection: null,
  editingItemId: null,
  graphRows: [],
  graphMonthIndex: 2,
  syncPromise: null,
  refreshPromise: null,
  pollTimer: null,
  notificationEnabled: localStorage.getItem(NOTIFICATION_KEY) === "true",
  initialized: false,
  cameraStream: null,
  scanFrame: null,
  lastScanAt: 0,
  modalFocus: new Map(),
};

const byId = (id) => document.getElementById(id);

function createNode(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.type) node.type = options.type;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== null && value !== undefined) node.setAttribute(name, String(value));
    }
  }
  return node;
}

function clearNode(node) {
  node.replaceChildren();
}

function parseInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, label = "数値" } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label}は${min}から${max}までの整数で入力してください。`);
  }
  return number;
}

function cleanText(value, { label, maxLength, required = true } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label}を入力してください。`);
  if (text.length > maxLength) throw new Error(`${label}は${maxLength}文字以内で入力してください。`);
  if(/[\u0000-\u001F\u007F]/u.test(text)) throw new Error(`${label}に使用できない文字が含まれています。`);
  return text;
}

function apiMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    return payload.message || payload.msg || payload.error_description || payload.error || fallback;
  }
  return fallback;
}

function showToast(message, kind = "") {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = `toast${kind ? ` ${kind}` : ""} show`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

async function readResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  return text || null;
}

async function authRequest(path, body, accessToken = null, method = "POST") {
  let response;
  try {
    response = await fetch(`${CONFIG.supabaseUrl}${path}`, {
      method,
      headers: {
        apikey: CONFIG.publishableKey,
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("認証サーバーに接続できません。通信状態を確認してください。");
  }
  const payload = await readResponse(response);
  if (!response.ok) throw new Error(apiMessage(payload, `認証に失敗しました（${response.status}）`));
  return payload;
}

function normalizeSession(payload) {
  if (!payload?.access_token || !payload?.refresh_token) throw new Error("有効なログイン情報を取得できませんでした。");
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000,
    user: payload.user || state.session?.user || null,
  };
}

function saveSession(session) {
  state.session = session;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadStoredSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (session?.accessToken && session?.refreshToken) return session;
  } catch {
    localStorage.removeItem(SESSION_KEY);
  }
  return null;
}

function clearSession() {
  state.session = null;
  state.profile = null;
  state.refreshPromise = null;
  localStorage.removeItem(SESSION_KEY);
  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function removeAuthFragment() {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function consumeAuthCallback() {
  const rawHash = window.location.hash.slice(1);
  if (!rawHash) return null;
  const parameters = new URLSearchParams(rawHash);
  const type = parameters.get("type");
  const hasAuthResult = parameters.has("access_token") || parameters.has("error") || parameters.has("error_code");
  if (!hasAuthResult) return null;

  removeAuthFragment();
  if (parameters.has("error") || parameters.has("error_code")) {
    return { error: "このパスワード設定リンクは無効か期限切れです。新しいメールを発行してください。" };
  }
  if (!["recovery", "invite"].includes(type)) return { error: "認証リンクの種類を確認できませんでした。" };

  try {
    return {
      type,
      session: normalizeSession({
        access_token: parameters.get("access_token"),
        refresh_token: parameters.get("refresh_token"),
        expires_in: parameters.get("expires_in"),
      }),
    };
  } catch {
    return { error: "このパスワード設定リンクは無効か期限切れです。新しいメールを発行してください。" };
  }
}

async function hydrateSessionUser() {
  const user = await authenticatedFetch("/auth/v1/user", { method: "GET" });
  if (!user?.id) throw new Error("利用者情報を確認できませんでした。新しいメールを発行してください。");
  saveSession({ ...state.session, user });
}

async function refreshSession() {
  if (state.refreshPromise) return state.refreshPromise;
  if (!state.session?.refreshToken) throw new Error("再ログインが必要です。");
  const refreshToken = state.session.refreshToken;
  const refreshPromise = (async () => {
    const payload = await authRequest("/auth/v1/token?grant_type=refresh_token", {
      refresh_token: refreshToken,
    });
    if (state.session?.refreshToken !== refreshToken) throw new Error("ログイン状態が変更されました。");
    const session = normalizeSession(payload);
    saveSession(session);
    return session;
  })();
  state.refreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (state.refreshPromise === refreshPromise) state.refreshPromise = null;
  }
}

async function ensureFreshSession() {
  if (!state.session) throw new Error("ログインが必要です。");
  if (state.session.expiresAt - Date.now() < 60_000) await refreshSession();
  return state.session;
}

async function authenticatedFetch(path, options = {}, canRetry = true) {
  await ensureFreshSession();
  const headers = new Headers(options.headers || {});
  headers.set("apikey", CONFIG.publishableKey);
  headers.set("Authorization", `Bearer ${state.session.accessToken}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let response;
  try {
    response = await fetch(`${CONFIG.supabaseUrl}${path}`, { ...options, headers });
  } catch {
    throw new Error("サーバーに接続できません。変更は保存されていません。");
  }

  if (response.status === 401 && canRetry) {
    await refreshSession();
    return authenticatedFetch(path, options, false);
  }

  const payload = await readResponse(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("この操作を行う権限がありません。");
    throw new Error(apiMessage(payload, `処理に失敗しました（${response.status}）`));
  }
  return payload;
}

function restGet(table, query) {
  return authenticatedFetch(`/rest/v1/${table}?${query}`, { method: "GET" });
}

function rpc(name, parameters) {
  return authenticatedFetch(`/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(parameters),
  });
}

async function fetchProfile() {
  const userId = state.session?.user?.id;
  if (!userId) throw new Error("利用者情報を取得できません。再ログインしてください。");
  const query = new URLSearchParams({
    select: "user_id,email,role,active",
    user_id: `eq.${userId}`,
    active: "eq.true",
    limit: "1",
  });
  const rows = await restGet("app_users", query.toString());
  if (!Array.isArray(rows) || !rows[0]) throw new Error("このアカウントは在庫管理の利用者として登録されていません。");
  if (!["viewer", "editor", "admin"].includes(rows[0].role)) throw new Error("利用者権限の設定が正しくありません。");
  state.profile = rows[0];
}

async function signIn(email, password) {
  const payload = await authRequest("/auth/v1/token?grant_type=password", { email, password });
  saveSession(normalizeSession(payload));
  try {
    await fetchProfile();
  } catch (error) {
    await signOut({ remote: true, showLogin: false });
    throw error;
  }
}

async function updateOwnPassword(password) {
  if (!state.session?.accessToken) throw new Error("パスワード設定リンクが無効です。");
  await authRequest("/auth/v1/user", { password }, state.session.accessToken, "PUT");
}

function validateNewPassword(password, confirmation) {
  if (password !== confirmation) throw new Error("確認用パスワードが一致しません。");
  if (password.length < 12 || password.length > 128) throw new Error("パスワードは12〜128文字で入力してください。");
  if (!/[a-z]/u.test(password) || !/[A-Z]/u.test(password) || !/[0-9]/u.test(password) || !/[^A-Za-z0-9]/u.test(password)) {
    throw new Error("英小文字・英大文字・数字・記号を各1文字以上含めてください。");
  }
}

async function signOut({ remote = true, showLogin = true } = {}) {
  const accessToken = state.session?.accessToken;
  if (remote && accessToken) {
    try {
      await authRequest("/auth/v1/logout", {}, accessToken);
    } catch {
      // The local session is cleared even when the network is unavailable.
    }
  }
  stopScanner();
  clearSession();
  state.items = [];
  state.archivedItems = [];
  state.categories = [];
  state.history = [];
  state.currentCategory = null;
  state.initialized = false;
  closeAllModals();
  if (showLogin) showAuthView();
}

function showAuthView() {
  byId("login-form").hidden = false;
  byId("reset-password-form").hidden = true;
  byId("auth-lead").textContent = "登録済みの社員アカウントでログインしてください。";
  byId("auth-status").textContent = "";
  byId("auth-view").hidden = false;
  byId("app-shell").hidden = true;
  byId("app-shell").setAttribute("aria-hidden", "true");
  byId("login-password").value = "";
  byId("new-password").value = "";
  byId("confirm-password").value = "";
  byId("reset-password-status").textContent = "";
  window.setTimeout(() => byId("login-email").focus(), 0);
}

function showPasswordSetupView(type) {
  byId("login-form").hidden = true;
  byId("auth-status").textContent = "";
  byId("reset-password-form").hidden = false;
  byId("auth-lead").textContent = type === "invite"
    ? "招待を受け付けました。ログインに使用するパスワードを設定してください。"
    : "新しいログインパスワードを設定してください。";
  byId("auth-view").hidden = false;
  byId("app-shell").hidden = true;
  byId("app-shell").setAttribute("aria-hidden", "true");
  window.setTimeout(() => byId("new-password").focus(), 0);
}

function showAppView() {
  byId("auth-view").hidden = true;
  byId("app-shell").hidden = false;
  byId("app-shell").setAttribute("aria-hidden", "false");
  byId("current-user").textContent = state.profile.email;
  byId("current-role").textContent = roleLabel(state.profile.role);
  applyRoleVisibility();
}

function roleLabel(role) {
  return { viewer: "閲覧", editor: "編集", admin: "管理者" }[role] || role;
}

function canEdit() {
  return state.profile && ["editor", "admin"].includes(state.profile.role);
}

function isAdmin() {
  return state.profile?.role === "admin";
}

function applyRoleVisibility() {
  const editable = canEdit();
  byId("add-item-button").hidden = !editable;
  byId("stock-editor-controls").hidden = !editable;
  byId("edit-item-button").hidden = !editable;
  byId("archive-item-button").hidden = !isAdmin();
  byId("item-admin-actions").hidden = !editable;
  byId("add-category-button").hidden = !editable;
  byId("archive-settings").hidden = !isAdmin();
}

function setSyncing(syncing) {
  byId("sync-indicator").classList.toggle("active", syncing);
}

function itemStatus(item) {
  const quantity = Number(item.qty) || 0;
  const minimum = Number(item.min) || 0;
  if (quantity <= 0) return "critical";
  if (quantity <= minimum) return "warning";
  return "normal";
}

function statusText(status) {
  return { normal: "正常", warning: "残り少", critical: "在庫切れ" }[status];
}

function makeStatusChip(status, customText = null) {
  const chip = createNode("span", { className: `status-chip${status === "normal" ? "" : ` ${status}`}`, text: customText || statusText(status) });
  return chip;
}

function normalizeRows(rows, name) {
  if (!Array.isArray(rows)) throw new Error(`${name}の形式が正しくありません。`);
  return rows;
}

async function loadData({ silent = false, detectAlerts = false, fresh = false } = {}) {
  if (state.syncPromise && !fresh) return state.syncPromise;
  if (state.syncPromise && fresh) {
    try {
      await state.syncPromise;
    } catch {
      // A fresh request below supersedes a failed or stale in-flight request.
    }
  }
  if (state.syncPromise) return state.syncPromise;
  state.syncPromise = (async () => {
    if (!silent) setSyncing(true);
    const previous = new Map(state.items.map((item) => [String(item.id), Number(item.qty)]));
    try {
      const itemQuery = new URLSearchParams({
        select: "id,ddk,name,category,qty,min,unit,version,updated_at,updated_by",
        deleted_at: "is.null",
        order: "category.asc,name.asc",
      });
      const categoryQuery = new URLSearchParams({ select: "name,sort_order", order: "sort_order.asc,name.asc" });
      const historyQuery = new URLSearchParams({
        select: "id,item_id,name,ddk,category,delta,unit,action,quantity_before,quantity_after,actor_email,note,created_at",
        order: "created_at.desc",
        limit: "200",
      });
      const archivedQuery = new URLSearchParams({
        select: "id,name,category,version,deleted_at",
        deleted_at: "not.is.null",
        order: "deleted_at.desc",
      });
      const [items, categories, history, archivedItems] = await Promise.all([
        restGet("inventory", itemQuery.toString()),
        restGet("categories", categoryQuery.toString()),
        restGet("history", historyQuery.toString()),
        isAdmin() ? restGet("inventory", archivedQuery.toString()) : Promise.resolve([]),
      ]);
      state.items = normalizeRows(items, "在庫");
      state.archivedItems = normalizeRows(archivedItems, "削除済み商品");
      state.categories = normalizeRows(categories, "分野");
      state.history = normalizeRows(history, "履歴");
      if (state.currentCategory && !state.categories.some((category) => category.name === state.currentCategory)) state.currentCategory = null;
      renderCurrentView();
      renderSettings();
      if (detectAlerts && state.initialized) notifyRemoteThresholdChanges(previous, state.items);
      state.initialized = true;
      const syncedAt = new Date();
      byId("last-sync").textContent = syncedAt.toLocaleString("ja-JP");
    } finally {
      setSyncing(false);
      state.syncPromise = null;
    }
  })();
  return state.syncPromise;
}

function renderCurrentView() {
  if (state.currentCategory) renderItemList();
  else renderCategories();
  updateHeader();
}

function updateHeader() {
  const category = state.categories.find((entry) => entry.name === state.currentCategory);
  byId("header-title").textContent = category?.name || "在庫管理システム";
  byId("qr-list-button").hidden = !state.currentCategory;
  byId("home-view").hidden = Boolean(state.currentCategory);
  byId("list-view").hidden = !state.currentCategory;
}

function renderCategories() {
  const grid = byId("category-grid");
  clearNode(grid);
  if (!state.categories.length) {
    grid.append(createNode("p", { className: "empty-state", text: canEdit() ? "分野がありません。設定から分野を追加してください。" : "表示できる分野がありません。" }));
    return;
  }
  state.categories.forEach((category, index) => {
    const categoryItems = state.items.filter((item) => item.category === category.name);
    const criticalCount = categoryItems.filter((item) => itemStatus(item) === "critical").length;
    const warningCount = categoryItems.filter((item) => itemStatus(item) === "warning").length;
    const button = createNode("button", { className: "category-card", type: "button" });
    button.append(
      createNode("span", { className: "category-index", text: `CATEGORY ${String(index + 1).padStart(2, "0")}` }),
      createNode("strong", { className: "category-name", text: category.name }),
    );
    const footer = createNode("span", { className: "category-footer" });
    footer.append(createNode("span", { className: "category-count", text: `${categoryItems.length} ITEMS` }));
    if (criticalCount) footer.append(makeStatusChip("critical", `在庫切れ ${criticalCount}`));
    else if (warningCount) footer.append(makeStatusChip("warning", `残り少 ${warningCount}`));
    button.append(footer);
    button.addEventListener("click", () => openCategory(category.name));
    grid.append(button);
  });
}

function openCategory(name) {
  if (!state.categories.some((category) => category.name === name)) return;
  state.currentCategory = name;
  setActiveMainTab("home");
  renderCurrentView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goHome() {
  state.currentCategory = null;
  setActiveMainTab("home");
  renderCurrentView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderItemList() {
  const list = byId("item-list");
  clearNode(list);
  const categoryItems = state.items.filter((item) => item.category === state.currentCategory);
  renderAlertBanners(categoryItems);
  if (!categoryItems.length) {
    list.append(createNode("p", { className: "empty-state", text: "この分野には商品がありません。" }));
    return;
  }
  for (const item of categoryItems) {
    const status = itemStatus(item);
    const button = createNode("button", { className: "item-row", type: "button" });
    button.append(createNode("span", { className: `item-dot${status === "normal" ? "" : ` ${status}`}`, attrs: { "aria-hidden": "true" } }));
    const information = createNode("span");
    information.append(
      createNode("span", { className: "item-ddk", text: item.ddk || "番号なし" }),
      createNode("span", { className: "item-name", text: item.name }),
      makeStatusChip(status),
    );
    const quantity = createNode("span", { className: `item-quantity${status === "normal" ? "" : ` ${status}`}` });
    quantity.append(createNode("strong", { text: item.qty }), createNode("span", { text: item.unit }));
    button.append(information, quantity);
    button.setAttribute("aria-label", `${item.name}、在庫${item.qty}${item.unit}、${statusText(status)}`);
    button.addEventListener("click", () => openStockModal(item.id));
    list.append(button);
  }
}

function renderAlertBanners(items) {
  const container = byId("alert-banners");
  clearNode(container);
  const critical = items.filter((item) => itemStatus(item) === "critical");
  const warning = items.filter((item) => itemStatus(item) === "warning");
  if (critical.length) container.append(createNode("div", { className: "alert-banner critical", text: `在庫切れ：${critical.map((item) => item.name).join("・")}` }));
  if (warning.length) container.append(createNode("div", { className: "alert-banner", text: `在庫少：${warning.map((item) => `${item.name}（${item.qty}${item.unit}）`).join("・")}` }));
}

function currentItem() {
  return state.items.find((item) => String(item.id) === String(state.currentItemId)) || null;
}

function openStockModal(itemId) {
  const item = state.items.find((entry) => String(entry.id) === String(itemId));
  if (!item) return;
  state.currentItemId = item.id;
  state.stockDirection = null;
  byId("stock-title").textContent = canEdit() ? "入出庫" : "在庫詳細";
  byId("stock-meta").textContent = [item.ddk, item.category].filter(Boolean).join(" · ");
  byId("stock-name").textContent = item.name;
  byId("stock-current").textContent = item.qty;
  byId("stock-unit").textContent = item.unit;
  const status = itemStatus(item);
  byId("stock-current").className = `stock-number${status === "normal" ? "" : ` ${status}`}`;
  byId("stock-status").replaceWith(makeStatusChip(status));
  const chip = document.querySelector("#stock-modal .status-chip");
  chip.id = "stock-status";
  byId("stock-quantity").value = "1";
  byId("stock-note").value = "";
  byId("stock-in-button").className = "direction-button";
  byId("stock-out-button").className = "direction-button";
  const execute = byId("execute-stock-button");
  execute.disabled = true;
  execute.className = "button wide";
  execute.textContent = "方向を選択してください";
  applyRoleVisibility();
  openModal("stock-modal");
}

function selectStockDirection(direction) {
  if (!canEdit()) return;
  state.stockDirection = direction;
  byId("stock-in-button").className = `direction-button${direction === "in" ? " selected-in" : ""}`;
  byId("stock-out-button").className = `direction-button${direction === "out" ? " selected-out" : ""}`;
  const execute = byId("execute-stock-button");
  execute.disabled = false;
  execute.className = `button ${direction === "in" ? "primary" : "danger"} wide`;
  execute.textContent = direction === "in" ? "入庫を確定する" : "出庫を確定する";
}

function adjustQuantity(amount) {
  const input = byId("stock-quantity");
  const current = Number.parseInt(input.value, 10) || 1;
  input.value = String(Math.min(MAX_STOCK_CHANGE, Math.max(1, current + amount)));
}

async function executeStockChange() {
  const item = currentItem();
  if (!item || !state.stockDirection || !canEdit()) return;
  let quantity;
  let note;
  try {
    quantity = parseInteger(byId("stock-quantity").value, { min: 1, max: MAX_STOCK_CHANGE, label: "数量" });
    note = cleanText(byId("stock-note").value, { label: "メモ", maxLength: 200, required: false });
    if (state.stockDirection === "out" && quantity > Number(item.qty)) throw new Error("現在の在庫数を超えて出庫できません。");
  } catch (error) {
    showToast(error.message, "error");
    return;
  }
  const button = byId("execute-stock-button");
  await withPending(button, async () => {
    const delta = state.stockDirection === "in" ? quantity : -quantity;
    const result = await rpc("adjust_inventory", {
      p_item_id: item.id,
      p_delta: delta,
      p_note: note || null,
      p_request_id: crypto.randomUUID(),
    });
    const updated = Array.isArray(result) ? result[0] : result;
    await loadData({ silent: true, fresh: true });
    closeModal("stock-modal");
    if (updated) notifyThreshold(updated);
    showToast(`${delta > 0 ? "入庫" : "出庫"}を保存しました`, "success");
  });
}

function populateCategorySelect(preferred = null) {
  const select = byId("item-category");
  clearNode(select);
  for (const category of state.categories) {
    const option = createNode("option", { text: category.name });
    option.value = category.name;
    select.append(option);
  }
  if (preferred && state.categories.some((category) => category.name === preferred)) select.value = preferred;
}

function openCreateItem() {
  if (!canEdit()) return;
  if (!state.categories.length) {
    showToast("先に分野を追加してください。", "error");
    openSettings();
    return;
  }
  state.editingItemId = null;
  byId("item-modal-title").textContent = "商品を追加";
  byId("item-form").reset();
  populateCategorySelect(state.currentCategory || state.categories[0].name);
  byId("item-quantity").value = "0";
  byId("item-minimum").value = "5";
  byId("item-unit").value = "個";
  byId("initial-quantity-field").hidden = false;
  byId("item-form-status").textContent = "";
  openModal("item-modal");
}

function openEditItem() {
  const item = currentItem();
  if (!item || !canEdit()) return;
  state.editingItemId = item.id;
  byId("item-modal-title").textContent = "商品を編集";
  populateCategorySelect(item.category);
  byId("item-ddk").value = item.ddk || "";
  byId("item-name").value = item.name;
  byId("item-quantity").value = item.qty;
  byId("item-minimum").value = item.min;
  byId("item-unit").value = item.unit;
  byId("initial-quantity-field").hidden = true;
  byId("item-form-status").textContent = "";
  closeModal("stock-modal", { restoreFocus: false });
  openModal("item-modal");
}

async function submitItemForm(event) {
  event.preventDefault();
  if (!canEdit()) return;
  const status = byId("item-form-status");
  status.textContent = "";
  try {
    const category = cleanText(byId("item-category").value, { label: "分野", maxLength: 50 });
    const ddk = cleanText(byId("item-ddk").value, { label: "DDK番号", maxLength: 80, required: false });
    const name = cleanText(byId("item-name").value, { label: "商品名", maxLength: 120 });
    const minimum = parseInteger(byId("item-minimum").value, { min: 0, max: 100_000_000, label: "警告ライン" });
    const unit = cleanText(byId("item-unit").value, { label: "単位", maxLength: 20 });
    const parameters = { p_ddk: ddk, p_name: name, p_category: category, p_min: minimum, p_unit: unit };
    const button = byId("save-item-button");
    await withPending(button, async () => {
      if (state.editingItemId) {
        const existing = state.items.find((item) => String(item.id) === String(state.editingItemId));
        if (!existing) throw new Error("編集対象が見つかりません。再読込してください。");
        await rpc("update_inventory_item", { ...parameters, p_item_id: existing.id, p_expected_version: existing.version });
      } else {
        const quantity = parseInteger(byId("item-quantity").value, { min: 0, max: 100_000_000, label: "初期数量" });
        await rpc("create_inventory_item", { ...parameters, p_qty: quantity, p_request_id: crypto.randomUUID() });
      }
      await loadData({ silent: true, fresh: true });
      closeModal("item-modal");
      showToast(state.editingItemId ? "商品情報を更新しました" : "商品を追加しました", "success");
      state.editingItemId = null;
    });
  } catch (error) {
    status.textContent = error.message;
  }
}

async function archiveCurrentItem() {
  const item = currentItem();
  if (!item || !isAdmin()) return;
  if (!window.confirm(`「${item.name}」を削除しますか？\n履歴は保持され、管理者がDBから復元できます。`)) return;
  await withPending(byId("archive-item-button"), async () => {
    await rpc("archive_inventory_item", { p_item_id: item.id, p_expected_version: item.version });
    await loadData({ silent: true, fresh: true });
    closeModal("stock-modal");
    showToast("商品を削除しました", "success");
  });
}

async function submitCategoryForm(event) {
  event.preventDefault();
  if (!canEdit()) return;
  const status = byId("category-form-status");
  status.textContent = "";
  try {
    const name = cleanText(byId("category-name").value, { label: "分野名", maxLength: 50 });
    await withPending(byId("save-category-button"), async () => {
      await rpc("create_inventory_category", { p_name: name });
      await loadData({ silent: true, fresh: true });
      byId("category-form").reset();
      closeModal("category-modal");
      showToast("分野を追加しました", "success");
    });
  } catch (error) {
    status.textContent = error.message;
  }
}

async function deleteCategory(name) {
  if (!isAdmin()) return;
  if (!window.confirm(`分野「${name}」を削除しますか？`)) return;
  try {
    await rpc("delete_inventory_category", { p_name: name });
    await loadData({ silent: true, fresh: true });
    showToast("分野を削除しました", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function restoreArchivedItem(item) {
  if (!isAdmin()) return;
  if (!window.confirm(`「${item.name}」を復元しますか？`)) return;
  try {
    await rpc("restore_inventory_item", { p_item_id: item.id });
    await loadData({ silent: true, fresh: true });
    showToast("商品を復元しました", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderSettings() {
  byId("notification-toggle").setAttribute("aria-checked", String(state.notificationEnabled));
  const container = byId("category-management");
  clearNode(container);
  for (const category of state.categories) {
    const activeCount = state.items.filter((item) => item.category === category.name).length;
    const archivedCount = state.archivedItems.filter((item) => item.category === category.name).length;
    const count = activeCount + archivedCount;
    const row = createNode("div", { className: "category-management-row" });
    row.append(createNode("strong", { text: category.name }), createNode("span", { text: `${count}件` }));
    const remove = createNode("button", { className: "text-button", text: "削除", type: "button" });
    remove.hidden = !isAdmin();
    remove.disabled = count > 0;
    remove.setAttribute("aria-label", `${category.name}を削除`);
    remove.addEventListener("click", () => deleteCategory(category.name));
    row.append(remove);
    container.append(row);
  }

  const archiveSection = byId("archive-settings");
  archiveSection.hidden = !isAdmin();
  const archivedContainer = byId("archived-management");
  clearNode(archivedContainer);
  if (isAdmin() && !state.archivedItems.length) {
    archivedContainer.append(createNode("p", { className: "muted", text: "削除済みの商品はありません。" }));
  }
  for (const item of state.archivedItems) {
    const row = createNode("div", { className: "category-management-row" });
    row.append(
      createNode("strong", { text: item.name }),
      createNode("span", { text: item.category }),
    );
    const restore = createNode("button", { className: "text-button restore-button", text: "復元", type: "button" });
    restore.setAttribute("aria-label", `${item.name}を復元`);
    restore.addEventListener("click", () => restoreArchivedItem(item));
    row.append(restore);
    archivedContainer.append(row);
  }
}

async function withPending(button, task) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "処理中…";
  try {
    return await task();
  } catch (error) {
    showToast(error.message || "処理に失敗しました。", "error");
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function makeItemUrl(itemId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = new URLSearchParams({ item: String(itemId) }).toString();
  return url.toString();
}

function makeQrDataUrl(value, scale = 5) {
  if (typeof window.qrcode !== "function") throw new Error("QRコード生成機能を読み込めませんでした。");
  const qr = window.qrcode(0, "M");
  qr.addData(value, "Byte");
  qr.make();
  return qr.createDataURL(scale, 0);
}

function openQrList() {
  const items = state.currentCategory ? state.items.filter((item) => item.category === state.currentCategory) : state.items;
  const grid = byId("qr-grid");
  clearNode(grid);
  for (const item of items) {
    const button = createNode("button", { className: "qr-card", type: "button" });
    const image = createNode("img", { attrs: { alt: `${item.name}のQRコード`, width: "148", height: "148", loading: "lazy" } });
    image.src = makeQrDataUrl(makeItemUrl(item.id), 4);
    button.append(createNode("strong", { text: item.name }), createNode("span", { text: item.ddk || item.id }), image);
    button.addEventListener("click", () => openQrDetail(item.id));
    grid.append(button);
  }
  openModal("qr-list-modal");
}

function openQrDetail(itemId) {
  const item = state.items.find((entry) => String(entry.id) === String(itemId));
  if (!item) return;
  byId("qr-detail-title").textContent = `${item.name} QRコード`;
  byId("qr-detail-category").textContent = item.category;
  byId("qr-detail-name").textContent = item.name;
  byId("qr-detail-ddk").textContent = item.ddk || item.id;
  const image = byId("qr-detail-image");
  image.src = makeQrDataUrl(makeItemUrl(item.id), 7);
  image.alt = `${item.name}のQRコード`;
  openModal("qr-detail-modal");
}

function extractItemCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, window.location.href);
    if (url.origin === window.location.origin && url.pathname === window.location.pathname) {
      const itemId = new URLSearchParams(url.hash.replace(/^#/, "")).get("item");
      if (itemId) return itemId;
    }
  } catch {
    // A raw item or DDK code is also accepted.
  }
  return raw;
}

function findItemByCode(value) {
  const code = extractItemCode(value).toLocaleLowerCase();
  if (!code) return null;
  return state.items.find((item) => String(item.id).toLocaleLowerCase() === code || String(item.ddk || "").toLocaleLowerCase() === code) || null;
}

function handleScannedCode(value) {
  const item = findItemByCode(value);
  if (!item) {
    showToast("該当する商品が見つかりません。", "error");
    return;
  }
  if (item.category !== state.currentCategory) openCategory(item.category);
  openStockModal(item.id);
  if (window.location.hash) history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

async function startScanner() {
  openModal("scan-modal");
  byId("camera-status").textContent = "カメラを起動しています…";
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
    const video = byId("qr-video");
    video.srcObject = state.cameraStream;
    await video.play();
    byId("camera-status").textContent = "QRコードを枠内に合わせてください。";
    state.lastScanAt = 0;
    state.scanFrame = window.requestAnimationFrame(scanCameraFrame);
  } catch {
    byId("camera-status").textContent = "カメラを使用できません。下の欄へ商品IDを入力してください。";
  }
}

function scanCameraFrame(timestamp) {
  if (!state.cameraStream) return;
  if (timestamp - state.lastScanAt >= 180) {
    state.lastScanAt = timestamp;
    const video = byId("qr-video");
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && typeof window.jsQR === "function") {
      const canvas = byId("qr-canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
      if (result?.data) {
        stopScanner();
        closeModal("scan-modal");
        handleScannedCode(result.data);
        return;
      }
    }
  }
  state.scanFrame = window.requestAnimationFrame(scanCameraFrame);
}

function stopScanner() {
  if (state.scanFrame) window.cancelAnimationFrame(state.scanFrame);
  state.scanFrame = null;
  if (state.cameraStream) state.cameraStream.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  byId("qr-video").srcObject = null;
}

function openHistory() {
  setActiveMainTab("history");
  openModal("history-modal");
  showHistoryPane("graph");
}

function showHistoryPane(pane) {
  const graph = pane === "graph";
  byId("graph-tab").classList.toggle("active", graph);
  byId("graph-tab").setAttribute("aria-selected", String(graph));
  byId("log-tab").classList.toggle("active", !graph);
  byId("log-tab").setAttribute("aria-selected", String(!graph));
  byId("graph-pane").hidden = !graph;
  byId("log-pane").hidden = graph;
  if (graph) loadGraph();
  else renderHistoryLog();
}

function renderHistoryLog() {
  const pane = byId("log-pane");
  clearNode(pane);
  if (!state.history.length) {
    pane.append(createNode("p", { className: "empty-state", text: "操作履歴がありません。" }));
    return;
  }
  for (const entry of state.history) {
    const row = createNode("article", { className: "history-row" });
    const content = createNode("div");
    content.append(createNode("strong", { text: entry.name || "商品" }));
    const date = entry.created_at ? new Date(entry.created_at).toLocaleString("ja-JP") : "日時不明";
    const actor = entry.actor_email || "旧履歴・操作者不明";
    const label = ACTION_LABELS[entry.action] || "操作";
    content.append(createNode("div", { className: "history-meta", text: `${label} · ${entry.category || "分野なし"} · ${actor} · ${date}` }));
    if (entry.note) content.append(createNode("div", { className: "history-meta", text: `メモ：${entry.note}` }));
    const delta = Number(entry.delta) || 0;
    const deltaNode = createNode("div", { className: `history-delta${delta < 0 ? " negative" : delta === 0 ? " neutral" : ""}` });
    deltaNode.textContent = delta === 0 ? "—" : `${delta > 0 ? "+" : ""}${delta} ${entry.unit || ""}`;
    row.append(content, deltaNode);
    pane.append(row);
  }
}

function recentMonths() {
  const months = [];
  const now = new Date();
  for (let offset = 2; offset >= 0; offset -= 1) {
    const value = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    months.push({ year: value.getFullYear(), month: value.getMonth() + 1, label: `${value.getMonth() + 1}月`, fullLabel: `${value.getFullYear()}年${value.getMonth() + 1}月` });
  }
  return months;
}

async function loadGraph() {
  const pane = byId("graph-pane");
  clearNode(pane);
  pane.append(createNode("p", { className: "loading-state", text: "読み込み中…" }));
  try {
    const months = recentMonths();
    const from = new Date(months[0].year, months[0].month - 1, 1).toISOString();
    const query = new URLSearchParams({
      select: "item_id,name,ddk,category,delta,unit,created_at",
      action: "eq.stock_out",
      created_at: `gte.${from}`,
      order: "created_at.asc",
      limit: "5000",
    });
    state.graphRows = normalizeRows(await restGet("history", query.toString()), "グラフ");
    renderGraph();
  } catch (error) {
    clearNode(pane);
    pane.append(createNode("p", { className: "empty-state", text: error.message }));
  }
}

function renderGraph() {
  const pane = byId("graph-pane");
  clearNode(pane);
  const months = recentMonths();
  const tabs = createNode("div", { className: "month-tabs", attrs: { "aria-label": "対象月" } });
  months.forEach((month, index) => {
    const button = createNode("button", { className: `month-button${index === state.graphMonthIndex ? " active" : ""}`, text: month.label, type: "button" });
    button.addEventListener("click", () => {
      state.graphMonthIndex = index;
      renderGraph();
    });
    tabs.append(button);
  });
  pane.append(tabs);
  const month = months[state.graphMonthIndex];
  const totals = new Map();
  for (const row of state.graphRows) {
    const date = new Date(row.created_at);
    if (date.getFullYear() === month.year && date.getMonth() + 1 === month.month) {
      const current = totals.get(String(row.item_id)) || { itemId: row.item_id, name: row.name, ddk: row.ddk || row.category, total: 0 };
      current.total += Math.abs(Number(row.delta) || 0);
      totals.set(String(row.item_id), current);
    }
  }
  const ranking = [...totals.values()].sort((a, b) => b.total - a.total);
  if (!ranking.length) {
    pane.append(createNode("p", { className: "empty-state", text: `${month.fullLabel}の出庫データはありません。` }));
    return;
  }
  const max = ranking[0].total;
  const list = createNode("div", { className: "ranking" });
  ranking.forEach((entry, index) => {
    const row = createNode("div", { className: "rank-row" });
    const label = createNode("div", { className: "rank-label" });
    label.append(createNode("strong", { text: entry.name }), createNode("span", { text: entry.ddk || "" }));
    const progress = createNode("progress", { attrs: { max, value: entry.total, "aria-label": `${entry.name} 出庫数${entry.total}` } });
    progress.className = "rank-progress";
    const track = createNode("div", { className: "rank-track" });
    track.append(progress, createNode("span", { className: "rank-value", text: entry.total }));
    row.append(createNode("span", { className: "rank-number", text: index === 0 ? "1" : index + 1 }), label, track);
    list.append(row);
  });
  pane.append(list);
}

function openSettings() {
  setActiveMainTab("settings");
  renderSettings();
  openModal("settings-modal");
}

function setActiveMainTab(tab) {
  for (const name of ["home", "history", "settings"]) {
    const button = byId(`${name}-tab`);
    const active = name === tab;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

async function toggleNotifications() {
  if (!state.notificationEnabled) {
    if (!("Notification" in window)) {
      showToast("この端末は通知に対応していません。", "error");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("通知が許可されませんでした。", "error");
      return;
    }
    state.notificationEnabled = true;
  } else {
    state.notificationEnabled = false;
  }
  localStorage.setItem(NOTIFICATION_KEY, String(state.notificationEnabled));
  renderSettings();
}

function notifyThreshold(item) {
  if (!state.notificationEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
  const status = itemStatus(item);
  if (status === "critical") new Notification("在庫切れ", { body: `${item.name}の在庫がなくなりました。` });
  else if (status === "warning") new Notification("在庫低下", { body: `${item.name}が残り${item.qty}${item.unit}です。` });
}

function notifyRemoteThresholdChanges(previous, items) {
  for (const item of items) {
    if (!previous.has(String(item.id))) continue;
    const oldQuantity = previous.get(String(item.id));
    if (Number(item.qty) < oldQuantity && Number(item.qty) <= Number(item.min)) notifyThreshold(item);
  }
}

function openModal(id) {
  const modal = byId(id);
  if (!modal) return;
  state.modalFocus.set(id, document.activeElement);
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  const target = modal.querySelector("button:not([hidden]):not(:disabled), input:not([hidden]):not(:disabled), select:not([hidden]):not(:disabled)");
  window.setTimeout(() => target?.focus(), 0);
}

function closeModal(id, { restoreFocus = true } = {}) {
  const modal = byId(id);
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (id === "scan-modal") stopScanner();
  if (id === "history-modal" || id === "settings-modal") setActiveMainTab("home");
  if (!document.querySelector(".overlay.open")) document.body.classList.remove("modal-open");
  if (restoreFocus) {
    const previous = state.modalFocus.get(id);
    if (previous instanceof HTMLElement) window.setTimeout(() => previous.focus(), 0);
  }
  state.modalFocus.delete(id);
}

function closeAllModals() {
  document.querySelectorAll(".overlay.open").forEach((modal) => closeModal(modal.id, { restoreFocus: false }));
}

function topOpenModal() {
  const open = [...document.querySelectorAll(".overlay.open")];
  return open.at(-1) || null;
}

function trapModalFocus(event) {
  if (event.key !== "Tab") return;
  const modal = topOpenModal();
  if (!modal) return;
  const focusable = [...modal.querySelectorAll("button:not([hidden]):not(:disabled), input:not([hidden]):not(:disabled), select:not([hidden]):not(:disabled), [tabindex]:not([tabindex='-1'])")];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function updateOnlineState() {
  const offline = !navigator.onLine;
  byId("offline-banner").hidden = !offline;
  byId("add-item-button").disabled = offline;
  byId("scan-button").disabled = false;
}

function startPolling() {
  window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(() => {
    if (navigator.onLine && !document.hidden) loadData({ silent: true, detectAlerts: true }).catch((error) => showToast(error.message, "error"));
  }, CONFIG.pollIntervalMs);
}

async function restoreLogin() {
  const authCallback = consumeAuthCallback();
  if (authCallback?.error) {
    clearSession();
    showAuthView();
    byId("auth-status").textContent = authCallback.error;
    return;
  }
  if (authCallback?.session) {
    try {
      saveSession(authCallback.session);
      await hydrateSessionUser();
      await fetchProfile();
      showPasswordSetupView(authCallback.type);
    } catch (error) {
      clearSession();
      showAuthView();
      byId("auth-status").textContent = error.message;
    }
    return;
  }

  state.session = loadStoredSession();
  if (!state.session) {
    showAuthView();
    return;
  }
  try {
    await ensureFreshSession();
    await fetchProfile();
    showAppView();
    await loadData();
    startPolling();
    processDeepLink();
  } catch (error) {
    clearSession();
    showAuthView();
    byId("auth-status").textContent = error.message;
  }
}

function processDeepLink() {
  if (!window.location.hash || !state.initialized) return;
  const item = findItemByCode(window.location.href);
  if (item) handleScannedCode(window.location.href);
  else showToast("QRコードの商品が見つかりません。", "error");
}

function wireEvents() {
  byId("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = byId("auth-status");
    status.textContent = "";
    const email = byId("login-email").value.trim();
    const password = byId("login-password").value;
    if (!email || !password) {
      status.textContent = "メールアドレスとパスワードを入力してください。";
      return;
    }
    const button = byId("login-button");
    try {
      await withPending(button, async () => {
        await signIn(email, password);
        showAppView();
        await loadData();
        startPolling();
        processDeepLink();
      });
    } catch (error) {
      status.textContent = error.message;
    }
  });

  byId("reset-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = byId("reset-password-status");
    status.textContent = "";
    const password = byId("new-password").value;
    const confirmation = byId("confirm-password").value;
    const button = byId("reset-password-button");
    try {
      validateNewPassword(password, confirmation);
      await withPending(button, async () => updateOwnPassword(password));
      await signOut({ remote: true, showLogin: false });
      showAuthView();
      byId("auth-status").textContent = "パスワードを設定しました。新しいパスワードでログインしてください。";
    } catch (error) {
      status.textContent = error.message;
    }
  });

  byId("home-tab").addEventListener("click", goHome);
  byId("history-tab").addEventListener("click", openHistory);
  byId("settings-tab").addEventListener("click", openSettings);
  byId("add-item-button").addEventListener("click", openCreateItem);
  byId("qr-list-button").addEventListener("click", openQrList);
  byId("scan-button").addEventListener("click", startScanner);
  byId("stock-in-button").addEventListener("click", () => selectStockDirection("in"));
  byId("stock-out-button").addEventListener("click", () => selectStockDirection("out"));
  byId("quantity-minus").addEventListener("click", () => adjustQuantity(-1));
  byId("quantity-plus").addEventListener("click", () => adjustQuantity(1));
  byId("execute-stock-button").addEventListener("click", () => executeStockChange().catch(() => {}));
  byId("edit-item-button").addEventListener("click", openEditItem);
  byId("archive-item-button").addEventListener("click", () => archiveCurrentItem().catch(() => {}));
  byId("item-form").addEventListener("submit", submitItemForm);
  byId("category-form").addEventListener("submit", submitCategoryForm);
  byId("add-category-button").addEventListener("click", () => {
    byId("category-form").reset();
    byId("category-form-status").textContent = "";
    openModal("category-modal");
  });
  byId("manual-code-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = byId("manual-code").value.trim();
    if (!value) return;
    stopScanner();
    closeModal("scan-modal");
    handleScannedCode(value);
    byId("manual-code").value = "";
  });
  byId("graph-tab").addEventListener("click", () => showHistoryPane("graph"));
  byId("log-tab").addEventListener("click", () => showHistoryPane("log"));
  byId("notification-toggle").addEventListener("click", () => toggleNotifications().catch((error) => showToast(error.message, "error")));
  byId("refresh-button").addEventListener("click", () => loadData({ detectAlerts: true }).catch((error) => showToast(error.message, "error")));
  byId("logout-button").addEventListener("click", () => signOut());
  byId("print-qr-button").addEventListener("click", () => window.print());

  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
  document.querySelectorAll(".overlay").forEach((overlay) => overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal(overlay.id);
  }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const modal = topOpenModal();
      if (modal) closeModal(modal.id);
    }
    trapModalFocus(event);
  });
  window.addEventListener("online", () => {
    updateOnlineState();
    if (state.session) loadData({ detectAlerts: true }).catch((error) => showToast(error.message, "error"));
  });
  window.addEventListener("offline", updateOnlineState);
  window.addEventListener("hashchange", processDeepLink);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && navigator.onLine && state.session) loadData({ silent: true, detectAlerts: true }).catch(() => {});
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || window.location.protocol !== "https:") return;
  try {
    await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
  } catch {
    // The app remains usable online if service-worker registration fails.
  }
}

wireEvents();
updateOnlineState();
restoreLogin();
registerServiceWorker();
