# DAISEN在庫管理

社内向けの在庫管理Webアプリです。Supabase Auth、Row Level Security、Postgres RPCを使用し、認証・権限管理・原子的な在庫更新・監査履歴を実装しています。

## 主な安全対策

- 未ログイン利用者（`anon`）の在庫・履歴アクセスを全面禁止
- `viewer`、`editor`、`admin`の3権限
- 在庫数の更新と履歴追加を同じDBトランザクションで実行
- 行ロックと冪等リクエストIDによる二重更新・同時更新対策
- 商品の削除は復元可能な論理削除
- 操作者、サーバー時刻、変更前後の数量を履歴へ記録
- 動的データを`innerHTML`や`document.write`へ渡さないDOM描画
- Content Security Policyとローカル配置したQRライブラリ
- 外部QR生成サービスへ商品IDを送信しない
- 30秒間隔、画面復帰時、オンライン復帰時の自動同期
- 通信成功後にだけ画面を更新

## 初回適用手順

本番データを扱うため、次の順番を守ってください。

1. Supabase Dashboardでデータベースのバックアップを取得する。
2. 現行公開アプリを直ちに止める場合は、SQL Editorで`supabase/EMERGENCY_LOCKDOWN.sql`を実行する。この時点で旧アプリは使用不能になる。
3. SupabaseのAuthentication > Usersで最初の管理者ユーザーを作成する。
4. SQL Editorで`supabase/migrations/20260924012058_secure_inventory.sql`を実行する。
5. SQL Editorで次のSQLを実行し、作成したユーザーを管理者として登録する。

```sql
insert into public.app_users (user_id, email, role)
select id, email, 'admin'
from auth.users
where lower(email) = lower('管理者のメールアドレス')
on conflict (user_id) do update
set email = excluded.email, role = 'admin', active = true, updated_at = now();
```

6. SQL Editorで`supabase/verify_security.sql`を実行し、`Security verification passed.`を確認する。
7. Supabase DashboardのAuthentication設定で、一般利用者による新規登録を無効にする。
8. このリポジトリをGitHub Pagesへデプロイする。
9. 管理者でログインし、既存在庫・履歴・カテゴリを確認する。
10. 入庫と出庫を各1回テストし、在庫数と履歴の両方が一致することを確認する。

## 社員ユーザーの追加

Authentication > Usersでユーザーを作成した後、SQL Editorから登録します。

```sql
insert into public.app_users (user_id, email, role)
select id, email, 'editor'
from auth.users
where lower(email) = lower('社員のメールアドレス')
on conflict (user_id) do update
set email = excluded.email, role = excluded.role, active = true, updated_at = now();
```

権限は以下の通りです。

| 権限 | 閲覧 | 入出庫 | 商品編集 | 分野追加 | 商品・分野削除 |
|---|---:|---:|---:|---:|---:|
| `viewer` | 可 | 不可 | 不可 | 不可 | 不可 |
| `editor` | 可 | 可 | 可 | 可 | 不可 |
| `admin` | 可 | 可 | 可 | 可 | 可 |

## 無効化と復元

社員の利用を止める場合、Authユーザーを削除する前に`app_users.active`を`false`にします。

```sql
update public.app_users
set active = false, updated_at = now()
where lower(email) = lower('対象メールアドレス');
```

論理削除した商品は、管理者でログインし、設定画面の「削除済み商品」から復元できます。復元操作も監査履歴に記録されます。

## ローカル確認

```bash
python3 -m http.server 8080
```

`http://localhost:8080`を開きます。カメラはHTTPSまたはlocalhostでのみ利用できます。

構文・セキュリティの静的チェック：

```bash
node --check app.js
node --check service-worker.js
node tests/security-check.mjs
```

## 注意事項

- `sb_publishable_...`キーは公開クライアント用です。秘密情報ではなく、データ保護はAuth、RLS、権限剥奪、RPC内の権限検証で行います。
- GitHub Pages自体は公開されます。ログイン画面と静的コードは誰でも閲覧できますが、在庫と履歴はRLSで保護されます。
- 通知はWeb Pushではありません。アプリを開いている端末で検知した在庫低下だけを通知します。
- オフライン中は在庫を更新しません。失敗した操作を成功扱いすることもありません。

## 第三者ライブラリ

- `jsQR` 1.4.0 — Apache-2.0
- `qrcode-generator` 1.4.4 — MIT

ライブラリは`vendor/`に固定バージョンで保存しており、実行時に外部CDNへ接続しません。
