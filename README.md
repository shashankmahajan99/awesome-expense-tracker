# Paisa — Daily Financial Inbox

Paisa is an inbox-first expense dashboard. It groups unresolved transactions into one useful daily review instead of asking users to categorise every payment as it happens.

## Run locally

```sh
npm install
npm run dev
```

Set `PUBLIC_API_URL` to the Go API gateway URL to load the authenticated user's expenses. Without it, the dashboard displays realistic preview data so the complete review flow can still be explored.

## Product principles

- Ask once, at the right time.
- Prioritise unusual and meaningful spending.
- Use voice as the fastest path to context.
- Stay silent when spending is already understood.
