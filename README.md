# Paisa — Daily Financial Inbox

Paisa turns unresolved transactions into one calm, useful daily review. The hosted app uses authenticated-user isolation and durable D1 storage; the Go repository provides the external/mobile API foundation.

## Included

- Prioritized daily review queue with explain, known, defer, and group actions.
- Batch explanations and merchant matching.
- Durable per-user preferences and review state.
- Private in-browser PDF statement extraction plus CSV import, validation, and deduplication.
- Full transaction ledger with create, search, filter, edit, categorise, review, and delete controls.
- Dedicated dashboard, Transactions, and Insights screens with working navigation.
- Dismissible review sheets, save-and-return behavior, and speech start/stop/loading feedback.
- Export and permanent account-data deletion.
- Optional Setu AA bank connection with explicit purpose, status, refresh, revocation, verified webhooks, and idempotent ledger reconciliation.
- A Kakeibo-inspired monthly plan for income, saving, fixed costs, one intention, and reflection.
- Timezone-aware reminder decision engine and exactly-once delivery records.
- Security headers, same-origin API enforcement, audit events, CI, and domain tests.

## Development

```sh
npm ci
npm test
npm run dev
```

Node.js 22.12 or newer is required. `npm audit` currently reports zero known vulnerabilities.

The deployment build packages an Astro client and Cloudflare-compatible Worker. `.openai/hosting.json` declares the logical D1 binding; Sites owns the physical database and deployment wiring.

## External configuration

Actual push delivery requires `PUSH_WEBHOOK_URL` and `PUSH_WEBHOOK_SECRET` in the hosted runtime. Bank feeds, Account Aggregator access, APNs, and FCM require separate provider enrollment and credentials and are intentionally not stored in this repository.

Setu AA uses the variables documented in `.env.example`. The integration, data boundaries, sandbox checks, and legal launch gates are documented in [`docs/SETU_AA_ARCHITECTURE.md`](docs/SETU_AA_ARCHITECTURE.md). Production onboarding and legal review remain required; code completion does not itself establish FIU approval or regulatory compliance.

## iOS app

The native SwiftUI app is in [`ios/Paisa`](ios/Paisa). Its generated Xcode project includes local-first SwiftData storage, daily review, explicit speech stop/loading states, full transaction management, insights, and on-device PDF/CSV import. Select an Apple signing team in Xcode before running on a device. Mobile cloud sync remains intentionally disabled until a dedicated mobile authentication endpoint is deployed; browser session headers must not be reused as app credentials.
