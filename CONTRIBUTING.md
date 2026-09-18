# Contributing

Run the complete local gate before opening a pull request:

```bash
npm ci
npm run check
npm run build
git diff --check
```

Changes that add an Agent action, Google API call, authorization path, token field, or audit field require an explicit capability-boundary review. Sending mail is outside the project contract; do not add a Gmail send route or provider call.

Never commit `.env` files, OAuth clients, tokens, mailbox data, draft receipts, database dumps, or local audit state.
