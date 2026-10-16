# DAISEN在庫管理

ログインなしで在庫・履歴の閲覧、QR読取ができます。
商品追加・編集、入出庫、分野追加・削除、商品削除・復元は管理者のみです。
設定の「管理者ログイン」で既存の管理者アカウントを利用してください。
editor、viewer、未ログイン利用者はデータ変更できません。

データベースには既存変更に続けて `supabase/admin_only_writes.sql` を適用します。
RLS、RPC、書込トリガーで管理者権限を確認します。既存の在庫・履歴は維持します。
過去のSQLは適用順の記録です。旧匿名書込テスト `verify_guest_access.sql` は旧構成向けです。

確認: `node --check app.js`、`node tests/security-check.mjs`、`node tests/optional-login.mjs`。
