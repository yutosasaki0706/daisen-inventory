# DAISEN在庫管理

在庫管理はログインせず利用できます。設定の「管理者ログイン」からログインすると、管理者に限り商品の削除・復元、分野の削除ができます。

| 操作 | ログインなし | 管理者 |
|---|---|---|
| 在庫・履歴の閲覧、QR、通知 | 可 | 可 |
| 入出庫、商品追加・編集、分野追加 | 可 | 可 |
| 商品削除・復元、分野削除 | 不可 | 可 |

既存のログイン利用者には従来のviewer/editor/adminの権限が適用されます。ログアウトすると通常利用に戻ります。
URLを知る人が通常利用できる共有アプリです。ログインなしの操作は個人名を記録しません。

在庫の原子的更新、冪等リクエストID、同時更新検知、監査履歴、論理削除、入力検証、QR、通知、自動同期を維持しています。
在庫データ・既存履歴の書き換えや削除は行いません。

## データベース

`supabase/enable_login_free_inventory.sql` はログインなしの通常操作を許可する変更です。RLSを維持し、匿名での商品削除・復元、分野削除、履歴の直接改変、利用者情報の閲覧は禁止します。既存の管理者アカウントと管理者向けRPCは維持します。
過去の `verify_security.sql` は旧ログイン必須構成用です。新構成では `supabase/verify_guest_access.sql` を使用します（テスト変更はロールバックされます）。

## 確認

`node --check app.js`、`node --check service-worker.js`、`node tests/security-check.mjs`、`node tests/optional-login.mjs`。
ブラウザ確認にはHTTPサーバーとPlaywrightが必要です。`node tests/browser-smoke.mjs` を実行してください。
