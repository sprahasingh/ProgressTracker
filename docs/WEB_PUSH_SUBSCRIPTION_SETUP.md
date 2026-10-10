# Web Push subscription setup

This change implements authenticated browser subscription registration, rotation, renewal, and revocation. It does not send scheduled reminders. No sender, cron job, or delivery worker is configured, so the Notifications page must continue to report **Background reminders: Setup required**.

## Security and storage

- The browser sends only the action and its Push API subscription to `manage-push-subscription`; it never sends an account ID.
- The Edge Function validates the caller's Supabase JWT with Auth and derives `user_id` from the verified user.
- `notification_devices` remains inaccessible to `anon` and `authenticated`. The Edge Function invokes a `service_role`-only SQL RPC, which does not return endpoints or encryption keys.
- The database RPC serializes endpoint registration, refuses endpoints already assigned to another account, updates a same-account subscription idempotently, and makes revocation idempotent.
- A private rate-limit table allows at most ten management calls per account per minute; active subscriptions are capped at twenty per account. Configure Supabase's platform/IP rate limits as an additional perimeter limit.
- The service worker records subscription-change events in a separate local IndexedDB queue and forwards them to an authenticated app page. The page acknowledges each change after it is saved server-side. The worker has no Supabase token or privileged key.
- Subscription ownership changes are serialized across same-origin tabs with the Web Locks API, as well as within each tab. Subscription operations fail closed in browsers without Web Locks. The app remembers the owning account ID and tags service-worker renewal events with that ID. On an identity change, it sends cleanup using the previous session's in-memory access token before allowing the new account to register. If that request fails, it unsubscribes locally, stores the pending owner and endpoint in origin-scoped IndexedDB, and blocks registration until that owner can retry. It never asks the replacement account to revoke the old endpoint.
- If the app starts with an account different from the locally remembered subscription owner, the former session token is unavailable. The app fails closed, removes the browser subscription locally, and requires a sign-in to the previous account to authorize server cleanup. This recovery is constrained by the normal owner check in the Edge Function and SQL RPC.
- The private VAPID key is not needed by this registration-only stage. It will be needed only by a future trusted sender.

## Build-time public key

Generate a VAPID pair in a private terminal using a trusted `web-push` CLI installation, for example:

```sh
npx --yes web-push generate-vapid-keys --json
```

The command prints both keys. Treat the private key as a secret immediately: do not paste it into chat, source control, browser configuration, build logs, or a `VITE_` variable. Store it in a password manager or other approved secret store. This stage does not use or request that private key.

Set the 87-character base64url **public** key as the GitHub Actions repository variable `VITE_VAPID_PUBLIC_KEY`. It is intentionally included in the public client bundle. `.env.example` documents the local variable. The Pages build checks its format and fails if it is missing.

## Supabase setup required before registration can work

1. Confirm the hosted migration ledger includes `20261014000100_notifications.sql` and migrations `20261015000100` and `20261016000100`.
2. Review and apply `20261017000100_manage_push_subscriptions.sql` to the hosted database using the project's normal reviewed migration process. This adds only a private rate-limit table and a service-role-only RPC; it does not modify the five notification domain tables or schedule delivery.
3. Set the Edge Function secret `ALLOWED_ORIGINS` to a comma-separated exact origin allowlist, for example:

   ```sh
   supabase secrets set --project-ref <project-ref> ALLOWED_ORIGINS="https://sprahasingh.github.io,http://localhost:5173"
   ```

   Origins do not include the GitHub Pages `/ProgressTracker/` path. Remove localhost from the production allowlist if local development does not need to call the hosted function.
4. Confirm the Edge Function runtime has its standard `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` variables. Never copy the service-role key into GitHub Actions or any `VITE_` variable.
5. Deploy the subscription function only after the database migration and origin secret are configured:

   ```sh
   supabase functions deploy manage-push-subscription --project-ref <project-ref>
   ```

   `supabase/config.toml` requires JWT verification, and the function additionally validates the bearer token with Supabase Auth.
6. Set `VITE_VAPID_PUBLIC_KEY` as a GitHub Actions repository variable, then deploy the frontend through the existing GitHub Pages workflow. This workspace change does not deploy either component.

The account-switch cleanup changes are frontend and service-worker changes only. They require a frontend deployment so the app can serialize identity changes and recover offline cleanup. They do not alter the SQL RPC or Edge Function contract, so no additional database migration or Edge Function deployment is required beyond the setup above.

## Still required for notifications while the app is closed

A future server sender must read eligible notification preferences and local progress, create idempotent delivery attempts, send encrypted Web Push using the private VAPID key, disable endpoints that return `404`/`410`, retry transient failures safely, and run from a monitored scheduler. Configure the sender's VAPID private key and subject only as trusted server secrets. Until that system is implemented, deployed, and verified, registering a device only stores its subscription; it does not mean reminders are delivered in the background.
