# Setu AA integration and launch gates

Paisa treats Setu as a replaceable Account Aggregator gateway, not as the product ledger. The gateway starts consent, sends lifecycle notifications, and delivers consented financial information. Paisa owns user isolation, canonical transactions, reconciliation, categories, monthly plans, insights, export, and deletion.

## Implemented flow

1. An authenticated user opens **Bank connections** and reviews the complete request summary.
2. The server validates the Indian mobile number, retains only the last four digits, and creates a Setu consent with purpose code `102`.
3. The browser navigates to the Setu-hosted URL. OTP, account discovery, selection, and approval remain in that journey.
4. Verified notifications update the local consent state. `FI_DATA_READY` payloads are normalised immediately; full webhook payloads and account-holder profile data are not retained.
5. Provider transaction references make delivery idempotent. Existing statement or mobile records are reconciled through the same canonical duplicate engine.
6. In-app revocation calls Setu before changing the local state. Account deletion first revokes every current consent. Transaction deletion is blocked while a live consent could restore records.

The defaults request only `DEPOSIT` summaries and transactions, not account-holder profile data. The request covers the previous year, permits at most one daily retrieval, uses a one-year consent duration and data life, and redirects back to `/accounts`.

## Runtime configuration

Configure the five `SETU_*` values shown in `.env.example` as hosted runtime secrets or variables. Do not commit credentials. Configure the Setu Bridge notification URL as:

`https://<site-host>/api/setu/webhook`

Set a unique high-entropy `SETU_WEBHOOK_SECRET` on both sides. The endpoint accepts HMAC-SHA256 in `x-setu-signature` or the shared secret in a bearer/custom header so the final Bridge configuration can use the strongest supported scheme. Confirm the exact AA notification-auth option with Setu during onboarding; Setu's AA notification documentation currently defines payloads but does not document an AA-specific signature header.

Enable Setu Auto-Fetch for this implementation. It consumes `FI_DATA_READY` notifications directly. If Auto-Fetch is not enabled, add the data-session create/fetch scheduler before production.

## Product and legal launch gates

- Complete Setu production KYC, FIU/Sahamati onboarding, product review, and agreements with Setu and every selected licensed AA.
- Confirm the FIU legal entity, approved purpose `102`, consent text, data life, fetch frequency, and supported FIPs. Use Setu's current active-FIP data rather than a hard-coded bank list.
- Insert the operator's legal name, address, privacy contact, grievance contact, governing law, hosting locations, and final retention schedule in the public notices.
- Execute processor/security terms for hosting, authentication, Setu, AAs, and notification providers; document sub-processors and cross-border transfers.
- Complete a data-flow inventory, retention/deletion schedule, access controls, key rotation, incident runbook, breach-notification process, recovery test, vulnerability review, and audit-log access policy.
- Test approve, reject, cancel, pause, expire, partial data, duplicate webhook, delayed webhook, provider outage, revocation, export, transaction deletion, and account deletion in sandbox.
- Have Indian privacy and financial-regulatory counsel review the full journey before public onboarding. The code deliberately does not claim that implementation alone establishes compliance.

## UX rules

- Bank connection is optional; statement import remains available.
- Never describe AA as real-time or promise universal bank coverage.
- Show purpose, data, range, frequency, processing life, expiry, status, last sync, errors, and revocation in plain language.
- Never collect or proxy an OTP, PIN, password, or full bank account number.
- Prefer redirect to the provider-hosted consent journey over embedding it in an app-owned frame.
- Keep budget reflection short: income, planned saving, fixed costs, one intention, and an optional reflection. The ledger should reduce effort; it should not create guilt.

## Primary references

- [Setu AA quickstart](https://docs.setu.co/data/account-aggregator/quickstart)
- [Setu consent object](https://docs.setu.co/data/account-aggregator/consent-object)
- [Setu consent and revocation APIs](https://docs.setu.co/data/account-aggregator/api-integration/consent-flow)
- [Setu AA notifications](https://docs.setu.co/data/account-aggregator/api-integration/notifications)
- [Setu Auto-Fetch data flow](https://docs.setu.co/data/account-aggregator/api-integration/data-apis)
- [RBI NBFC-AA Master Directions](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10598)
- [ReBIT AA API specifications](https://api.rebit.org.in/)
- [MeitY DPDP Rules, 2025 and enforcement material](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa)
