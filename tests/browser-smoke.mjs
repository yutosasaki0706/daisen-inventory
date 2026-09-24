import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const baseUrl = process.env.APP_URL || "http://127.0.0.1:8080/";
const userId = "11111111-1111-4111-8111-111111111111";
let quantity = 4;
let historyRows = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
const authenticatedHeaders = [];

page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(({ userId: id }) => {
  localStorage.setItem("daisen_inventory_session_v2", JSON.stringify({
    accessToken: "test-user-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    user: { id, email: "editor@example.test" },
  }));
}, { userId });

await page.route("https://earxbzdgjklewnsrcjsp.supabase.co/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  authenticatedHeaders.push(request.headers().authorization || "");
  const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

  if (url.pathname.endsWith("/app_users")) return json([{ user_id: userId, email: "editor@example.test", role: "editor", active: true }]);
  if (url.pathname.endsWith("/categories")) return json([{ name: "テスト分野", sort_order: 1 }]);
  if (url.pathname.endsWith("/inventory")) {
    return json([{
      id: "safe-item-id",
      ddk: "DDK-001",
      name: "<img id=xss-proof src=x onerror=window.__xss=true>",
      category: "テスト分野",
      qty: quantity,
      min: 3,
      unit: "個",
      version: 1,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    }]);
  }
  if (url.pathname.endsWith("/history")) return json(historyRows);
  if (url.pathname.endsWith("/rpc/adjust_inventory")) {
    const body = request.postDataJSON();
    quantity += body.p_delta;
    historyRows.unshift({
      id: 1,
      item_id: "safe-item-id",
      name: "<img id=xss-history src=x onerror=window.__xss=true>",
      ddk: "DDK-001",
      category: "テスト分野",
      delta: body.p_delta,
      unit: "個",
      action: body.p_delta > 0 ? "stock_in" : "stock_out",
      quantity_before: quantity - body.p_delta,
      quantity_after: quantity,
      actor_email: "editor@example.test",
      note: body.p_note,
      created_at: new Date().toISOString(),
    });
    return json({ id: "safe-item-id", name: "テスト商品", category: "テスト分野", qty: quantity, min: 3, unit: "個", version: 2 });
  }
  return json({ message: `Unhandled mocked endpoint: ${url.pathname}` }, 500);
});

await page.goto(baseUrl, { waitUntil: "networkidle" });
assert.equal(await page.title(), "ダイセン電子工業 在庫管理");
await page.locator("#app-shell").waitFor({ state: "visible" });
assert.equal(await page.locator("#auth-view").isHidden(), true);
assert.equal(await page.locator(".category-card").count(), 1);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
assert.ok(authenticatedHeaders.every((header) => header === "Bearer test-user-token"));

await page.locator(".category-card").click();
await page.locator(".item-row").waitFor({ state: "visible" });
assert.equal(await page.locator("#xss-proof").count(), 0);
assert.equal(await page.evaluate(() => Boolean(window.__xss)), false);
assert.match(await page.locator(".item-name").innerText(), /<img id=xss-proof/);

await page.locator(".item-row").click();
assert.equal(await page.locator("#stock-modal").getAttribute("aria-hidden"), "false");
await page.locator("#stock-in-button").click();
await page.locator("#stock-note").fill("テスト入庫");
await page.locator("#execute-stock-button").click();
await page.locator("#stock-modal").waitFor({ state: "hidden" });
assert.match(await page.locator(".item-quantity strong").innerText(), /^5$/);

await page.locator("#qr-list-button").click();
await page.locator(".qr-card img").waitFor({ state: "visible" });
assert.match(await page.locator(".qr-card img").getAttribute("src"), /^data:image\/gif;base64,/);
await page.locator('[data-close="qr-list-modal"]').click();

await page.locator("#history-tab").click();
await page.locator("#log-tab").click();
assert.equal(await page.locator("#xss-history").count(), 0);
assert.match(await page.locator(".history-row strong").innerText(), /<img id=xss-history/);

assert.deepEqual(errors, []);
await browser.close();
process.stdout.write("Browser smoke test passed.\n");
