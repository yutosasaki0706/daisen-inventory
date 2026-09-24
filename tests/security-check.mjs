import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const index = read("index.html");
const app = read("app.js");
const migration = read("supabase/migrations/20260924012058_secure_inventory.sql");
const verification = read("supabase/verify_security.sql");
const failures = [];

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) failures.push(message);
}

function forbidMatch(source, pattern, message) {
  if (pattern.test(source)) failures.push(message);
}

forbidMatch(index, /\son(?:click|input|change|submit|load|error)\s*=/iu, "HTMLにインラインイベントハンドラーがあります。");
forbidMatch(app, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval|new Function)\b/u, "app.jsに危険なDOMまたはコード実行APIがあります。");
forbidMatch(index, /<script[^>]+src=["']https?:/iu, "外部ドメインからJavaScriptを読み込んでいます。");
forbidMatch(index, /api\.qrserver\.com|unpkg\.com|fonts\.googleapis\.com/iu, "廃止対象の外部サービス参照が残っています。");
forbidMatch(app, /Authorization["']?\s*:\s*[`"']Bearer\s+\$?\{?CONFIG\.publishableKey/iu, "公開鍵をユーザー認証トークンとして使用しています。");

requireMatch(index, /Content-Security-Policy/iu, "Content Security Policyがありません。");
requireMatch(index, /script-src 'self'/u, "CSPのscript-srcがselfに限定されていません。");
requireMatch(app, /grant_type=password/u, "パスワードログイン処理がありません。");
requireMatch(app, /state\.session\.accessToken/u, "認証済みアクセストークンを利用していません。");
requireMatch(app, /window\.top !== window\.self/u, "クリックジャッキング防止処理がありません。");
requireMatch(app, /rpc\("adjust_inventory"/u, "原子的な在庫更新RPCを呼んでいません。");
requireMatch(migration, /alter table public\.inventory enable row level security/iu, "inventoryのRLS有効化がありません。");
requireMatch(migration, /alter table public\.history enable row level security/iu, "historyのRLS有効化がありません。");
requireMatch(migration, /revoke all on table public\.inventory from public, anon/iu, "inventoryの匿名権限剥奪がありません。");
requireMatch(migration, /set qty = qty \+ p_delta/iu, "在庫数が原子的に更新されていません。");
requireMatch(migration, /pg_advisory_xact_lock/iu, "冪等処理用のトランザクションロックがありません。");
requireMatch(migration, /request_id/iu, "冪等リクエストIDがありません。");
requireMatch(migration, /security definer/iu, "権限検証付きDB関数がありません。");
requireMatch(migration, /function public\.adjust_inventory[\s\S]+?security invoker/iu, "公開RPCがRLSを迂回する設定です。");
requireMatch(migration, /create schema if not exists private/iu, "権限確認用の非公開スキーマがありません。");
requireMatch(migration, /set search_path = ''/iu, "SECURITY DEFINER関数のsearch_pathが固定されていません。");
forbidMatch(migration, /create or replace function public\.(?:is_inventory_user|assert_inventory_role|inventory_actor_email)/iu, "内部権限関数が公開スキーマにあります。");
forbidMatch(migration, /function public\.[^(]+\([^)]*\)[\s\S]{0,220}?security definer/giu, "公開RPCにSECURITY DEFINERが使われています。");
requireMatch(verification, /has_table_privilege\('anon', 'public\.inventory'/iu, "匿名権限のDB検証がありません。");
requireMatch(verification, /public RPC security invoker/iu, "公開RPC権限のDB検証がありません。");

for (const relative of [
  "styles.css",
  "app.js",
  "service-worker.js",
  "manifest.json",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "vendor/jsQR-1.4.0.js",
  "vendor/qrcode-generator-1.4.4.js",
]) {
  if (!fs.existsSync(path.join(root, relative))) failures.push(`参照ファイルがありません: ${relative}`);
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exit(1);
}

process.stdout.write("Security checks passed.\n");
