# Send Money — evaluation guide

How to run the API, exercise every rule, and verify the result against the
database rather than trusting the API's own report.

## Quick start

```bash
docker compose up -d --build
./scripts/scenarios.sh all
```

Compose brings up Postgres, a one-shot `migrate` service that migrates and
seeds, the API, and DbGate. `scenarios.sh all` then runs every scenario and
exits non-zero if any diverges.

`all` skips `expired-token`, which costs ~2 minutes of waiting. Add `--slow`
to include it.

**Reset between full passes:** `docker compose down -v && docker compose up -d
--build`. The limit scenarios consume real headroom, so they only behave
predictably from a freshly seeded database.

## The two phases

Both endpoints need `Authorization: Bearer <token>`. Mint one at
`POST /v1/dev/token` with any seeded username — it stands in for Keycloak and
does not exist in a production build.

**`POST /v1/send-money/resolve`** validates everything at once: sender balance
and limits, recipient lookup, recipient status and receiving limits. Failures
come back as a 422 with an `errors` array holding *every* reason, so a
confirmation screen can show them all in one round trip.

```jsonc
// request
{ "recipient": { "type": "username", "value": "ethan.delrosario" },
  "amount": "1500.00", "note": "Lunch" }

// 200 data
{ "resolutionToken": "eyJhbGci…", "expiresAt": "2026-08-27T09:17:00.000Z",
  "recipient": { "displayName": "Ethan Del Rosario" },
  "amount": "1500.00", "amountMinor": 150000, "currency": "PHP", "note": "Lunch" }
```

**`POST /v1/send-money`** spends that token. Requires an `Idempotency-Key`
header. The token lives 120 seconds, and every rule is re-run against locked
balances before money moves — it is a confirmation, not an authorisation.

```jsonc
// request
{ "resolutionToken": "eyJhbGci…" }

// 201 data
{ "reference": "3f2a7c18-…", "recipient": { "name": "Ethan Del Rosario" },
  "amount": "1500.00", "amountMinor": 150000, "currency": "PHP",
  "note": "Lunch", "postedAt": "2026-08-27T09:16:12.000Z" }
```

Responses are wrapped in `{ statusCode, data, message, timestamp }`.

## Seeded identities

Every holder gets the product default limits: **PHP 50,000/day, PHP
500,000/month**, applied to sending and receiving independently.

| Username | Mobile | Balance | Status |
|---|---|---|---|
| `adelaida.magtalas` | 09170000101 | 85,000.75 | active |
| `ethan.delrosario` | 09170000102 | 62,500.05 | active |
| `joy.fabregas` | 09170000103 | 40,000.00 | active |
| `abigail.lim` | 09170000104 | 1,999.99 | active |
| `bobbie.salazar` | 09170000105 | 12,000.00 | **suspended** |
| `arturo.montenegro` | 09170000201 | 750,000.00 | active |
| `miggy.montenegro` | 09170000202 | 750,000.00 | active |
| `richard.lim` | 09170000203 | 500,000.00 | active |

`arturo.montenegro` and `miggy.montenegro` are two logins on the same
corporate holder, so they share one balance and one set of limits.

`bobbie.salazar` is suspended at both holder and account level, which lets one
fixture prove two things: a token is still minted for them (a real identity
provider knows nothing about account suspension) and the guard rejects it on
use, while naming them as a *recipient* fails resolution instead.

## Scenarios

| Subcommand | Proves | Expected |
|---|---|---|
| `happy` | The full round trip | 200 resolve → 201 execute |
| `insufficient-funds` | Balance is checked | 422 `INSUFFICIENT_FUNDS` |
| `daily-reset` | Usage is windowed to the Manila day | 200 — a backdated debit doesn't count |
| `sender-limit` | The daily cap is inclusive | boundary passes, +0.01 → 422 `SENDER_DAILY_LIMIT_EXCEEDED` |
| `recipient-limit` | Limits bound receiving too | 422 `RECIPIENT_DAILY_LIMIT_EXCEEDED` |
| `recipient-not-found` | Unknown recipient fails cleanly | 422 `RECIPIENT_NOT_FOUND` |
| `recipient-suspended` | A suspended payee can't receive | 422 `RECIPIENT_NOT_ACTIVE` |
| `sender-suspended` | The guard, not resolve, blocks it | 403 `IDENTITY_NOT_ACTIVE` |
| `self-transfer` | No sending to yourself | 422 `SELF_TRANSFER_NOT_ALLOWED` |
| `multi-error` | Every failure reported at once | 422 with ≥2 codes |
| `replay` | A repeated key moves money once | same `reference` twice |
| `expired-token` | A stale confirmation is refused | 403 `RESOLUTION_TOKEN_EXPIRED` |

Run one with `./scripts/scenarios.sh <subcommand>`.

**Order matters in `all`.** `daily-reset` runs before `sender-limit` because
`sender-limit` deliberately exhausts Arturo's daily cap; running them the
other way round leaves `daily-reset` with no headroom and it fails. Prefer
`all` over ad-hoc sequences.

Two scenarios deserve a note:

- **`daily-reset`** backdates a PHP 49,999 debit two days ago via
  `docker exec … psql`, then sends PHP 100 successfully — proving the
  backdated amount is outside today's window. It cleans up with a
  compensating reversal rather than a delete, because `ledger_entries` is
  append-only by trigger. The reversal is written with `transfer_id = NULL`
  so it stays invisible to usage sums.
- **`multi-error`** sends an oversized amount from a low-balance holder to a
  suspended one, and returns four codes in one response.

## Verifying against the database

Open DbGate at `http://localhost:${DBGATE_HOST_PORT}` (connection
pre-configured), or:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

**After `happy`** — the transfer, its ledger pair, and the event:

```sql
SELECT t.public_id, t.amount_minor, t.status, t.note,
       src.account_number AS from_acct, dst.account_number AS to_acct
  FROM transfers t
  JOIN accounts src ON src.id = t.source_account_id
  JOIN accounts dst ON dst.id = t.destination_account_id
 ORDER BY t.id DESC LIMIT 1;

SELECT direction, amount_minor, balance_after_minor
  FROM ledger_entries WHERE transfer_id = (SELECT max(id) FROM transfers);

SELECT event_type, payload FROM outbox_events ORDER BY id DESC LIMIT 1;
```

**After any limit scenario** — the same sum the limit check computes. Only
transfer-linked entries count, so opening balances never consume headroom:

```sql
SELECT le.direction, sum(le.amount_minor) AS used_minor
  FROM ledger_entries le
  JOIN accounts a ON a.id = le.account_id
  JOIN account_holders h ON h.id = a.account_holder_id
 WHERE h.display_name = 'Montenegro Industries'
   AND le.transfer_id IS NOT NULL
   AND le.posted_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Manila')
                       AT TIME ZONE 'Asia/Manila'
 GROUP BY le.direction;
```

Swap `date_trunc('day', …)` for `'month'` to see the monthly window — a
two-day-old entry is outside the day but inside the month, which is what
`daily-reset` demonstrates.

**After `replay`** — one row, however many times the key was sent:

```sql
SELECT count(*) FROM transfers WHERE idempotency_key = '<the key>';
```

## Swagger

`http://localhost:${API_HOST_PORT}/docs`. Mint a token at `/v1/dev/token`,
click **Authorize**, paste it in, and every example runs from the browser.
