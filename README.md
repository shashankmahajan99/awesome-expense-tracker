# Paisa — Daily Financial Inbox

Paisa turns unresolved transactions into one calm, useful daily review. The hosted app uses authenticated-user isolation and durable D1 storage; the Go repository provides the external/mobile API foundation.

## Included

- Prioritized daily review queue with explain, known, defer, and group actions.
- Batch explanations and merchant matching.
- Durable per-user preferences and review state.
- CSV import with validation and deduplication.
- Export and permanent account-data deletion.
- Timezone-aware reminder decision engine and exactly-once delivery records.
- Security headers, same-origin API enforcement, audit events, CI, and domain tests.

## Development

```sh
npm ci
npm test
npm run dev
```

The deployment build packages an Astro client and Cloudflare-compatible Worker. `.openai/hosting.json` declares the logical D1 binding; Sites owns the physical database and deployment wiring.

## External configuration

Actual push delivery requires `PUSH_WEBHOOK_URL` and `PUSH_WEBHOOK_SECRET` in the hosted runtime. Bank feeds, Account Aggregator access, APNs, and FCM require separate provider enrollment and credentials and are intentionally not stored in this repository.
