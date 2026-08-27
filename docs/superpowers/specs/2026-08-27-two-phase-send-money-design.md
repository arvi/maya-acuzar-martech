# Two-Phase Send Money — Design

Date: 2026-08-27
Status: approved, ready for implementation planning

## Problem

`POST /v1/transfers` takes `sourceAccountId` and `destinationAccountId` as
account `public_id` UUIDs in the request body. Two things are wrong with that.

First, it is an enumeration surface. A `public_id` is opaque but it is still a
bearer-ish handle: anyone who learns one can name that account as a transfer
counterparty, and can probe which ids exist by watching 404 responses. Account
identity should never be an API *input*.

Second, it is a single-shot API for a flow the product runs in two steps. The
UI asks for a recipient and an amount, shows a confirmation screen, and only
then moves money. A one-call endpoint gives the client nothing to show on that
screen and no way to report several problems at once.

This design replaces the endpoint with a two-phase flow in which the caller
never names an account at all.

## Solution overview

```
POST /v1/dev/token          → access token for a seeded identity (non-prod only)

POST /v1/send-money/resolve → validates everything, returns a 120s resolution token
POST /v1/send-money         → spends the resolution token, moves the money
```

The sender is derived from the access token. The recipient is resolved from a
username or mobile number. Internal account ids travel only inside a signed,
short-lived token that the server issued to itself. No account identifier —
public or internal — is ever accepted from a client.

## 1. Response envelope

### Interceptor

`ResponseInterceptor` (global) wraps every successful response:

```json
{
  "statusCode": 200,
  "data": { },
  "message": "Recipient resolved.",
  "timestamp": "2026-08-27T09:15:00.000Z"
}
```

- `statusCode` is read from the actual `HttpResponse`, not hardcoded, so a
  `201` stays a `201`.
- `data` holds the handler's return value verbatim.
- `message` comes from a `@ResponseMessage('…')` decorator on the handler,
  defaulting to `'OK'` when absent.
- `timestamp` is ISO-8601 UTC.

**Exclusion:** any request whose route path is `/health` or starts with
`/health/` passes through untouched. Health probes are consumed by
infrastructure that expects the Terminus shape, and wrapping it would break
them. The check is on the route path rather than a substring match, so an
endpoint like `/v1/accounts/health-report` is not accidentally excluded.

### Exception filter

`AllExceptionsFilter` (global) shapes errors into the same four keys so a
client parses one shape always:

```json
{
  "statusCode": 422,
  "data": { "errors": [ { "code": "…", "message": "…", "details": { } } ] },
  "message": "Transfer cannot proceed.",
  "timestamp": "…"
}
```

For a `SendMoneyRuleViolation` the `data` is the accumulated `errors` array.
For every other `HttpException` the `data` is `{ code, details }` with a
single machine-readable code (`VALIDATION_FAILED`, `NOT_FOUND`,
`UNAUTHORIZED`, …). For an unrecognised throwable the filter logs the stack
and returns a `500` with code `INTERNAL_ERROR` and no internal detail in the
body.

The filter also honours the `/health` exclusion, so a failing health check
still returns the Terminus error shape.

## 2. Authentication

### Dependency

Adds `@nestjs/jwt`. No Passport: there is one token type from one issuer and a
guard reading a bearer header is less machinery than a strategy registry.

### Configuration

| Variable | Purpose | Default (non-prod) |
|---|---|---|
| `JWT_ACCESS_SECRET` | HS256 secret for access tokens | dev-only fallback |
| `JWT_ACCESS_TTL_SECONDS` | Access token lifetime | `3600` |
| `JWT_RESOLUTION_SECRET` | HS256 secret for resolution tokens | dev-only fallback |
| `JWT_RESOLUTION_TTL_SECONDS` | Resolution token lifetime | `120` |
| `JWT_ISSUER` | Mimicked Keycloak issuer | `http://localhost:8080/realms/send-money` |

The two secrets are deliberately distinct. A resolution token authorises a
specific movement of money; an access token authorises a session. Signing both
with one key would let either be presented where the other is expected.
Bootstrap fails fast if `NODE_ENV=production` and either secret is unset.

### `POST /v1/dev/token`

Registered only when `NODE_ENV !== 'production'` — the module is omitted from
the imports array entirely, so the route does not exist in production rather
than existing behind a guard.

Request: `{ "username": "adelaida.magtalas" }`

Looks up `auth_identities.username`. `404 IDENTITY_NOT_FOUND` if absent. Note
that it does **not** check holder status: minting a token for a suspended
holder is exactly how the `sender-suspended` scenario is exercised. The guard
rejects it later.

Response `data`:

```json
{
  "accessToken": "eyJ…",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "subject": "seed-adelaida-magtalas"
}
```

Claims mimic Keycloak:

```json
{
  "iss": "http://localhost:8080/realms/send-money",
  "sub": "seed-adelaida-magtalas",
  "preferred_username": "adelaida.magtalas",
  "email": "adelaida.magtalas@example.com",
  "realm_access": { "roles": ["user"] },
  "iat": 1772…, "exp": 1772…
}
```

`sub` carries the `auth_identities.subject` value, not the row id. The guard
resolves it to a row on every request, so a token stays valid only as long as
the identity behind it does.

### `JwtAuthGuard`

Global, with a `@Public()` decorator opting out `/health` and `/v1/dev/token`.

1. Reads `Authorization: Bearer …`; `401 MISSING_TOKEN` if absent.
2. Verifies signature, `exp`, and `iss`; `401 INVALID_TOKEN` / `TOKEN_EXPIRED`.
3. Loads the `auth_identity` by `subject`, joined to `account_holders`;
   `401 IDENTITY_NOT_FOUND` if the row is gone.
4. `403 IDENTITY_NOT_ACTIVE` if the holder's status is not `active`, with
   `details.status` naming the actual status.
5. Attaches `request.identity = { authIdentityId, accountHolderId, subject, username, displayName, holderStatus }`.

`@CurrentIdentity()` is a param decorator returning that object. Handlers never
touch `request.user`, and the type is exported so a handler signature documents
what it needs.

## 3. Phase one — `POST /v1/send-money/resolve`

### Request

```json
{
  "recipient": { "type": "username", "value": "ethan.delrosario" },
  "amount": "1500.00",
  "note": "Lunch"
}
```

- `recipient.type` is `username` or `mobileNumber`. The client already knows
  which, per the brief, so the server does not sniff the format — it trusts the
  discriminator and validates the value against it (`mobileNumber` must match
  `^09\d{9}$`).
- `amount` (pesos, ≤2dp, string preferred) or `amountMinor` (centavos, integer)
  — exactly one, reusing the existing `ExactlyOneAmountConstraint` and
  `IsPesoAmount` validators.
- `note` optional, `@MaxLength(100)`.
- `Idempotency-Key` header optional on this phase (it is read-only) but
  accepted so a client can use one key across both calls.

### Rules

`SendMoneyRulesService` evaluates every rule and **accumulates** violations
rather than throwing on the first. This is the core requirement of phase one:
the confirmation screen must be able to show every reason at once.

| Code | Condition | Details |
|---|---|---|
| `SENDER_NO_ACTIVE_ACCOUNT` | sender's holder has 0 active accounts | — |
| `SENDER_AMBIGUOUS_ACCOUNT` | sender's holder has >1 active account | `accountCount` |
| `INSUFFICIENT_FUNDS` | `amountMinor > sender balance` | `balanceMinor`, `requestedMinor` |
| `SENDER_DAILY_LIMIT_EXCEEDED` | outbound used + amount > daily limit | `limitMinor`, `usedMinor`, `requestedMinor` |
| `SENDER_MONTHLY_LIMIT_EXCEEDED` | outbound used + amount > monthly limit | same |
| `RECIPIENT_NOT_FOUND` | no `auth_identity` for that username/mobile | — |
| `RECIPIENT_NOT_ACTIVE` | recipient holder or account not `active` | `status` |
| `RECIPIENT_NO_ACTIVE_ACCOUNT` | recipient holder has 0 active accounts | — |
| `RECIPIENT_AMBIGUOUS_ACCOUNT` | recipient holder has >1 active account | `accountCount` |
| `RECIPIENT_DAILY_LIMIT_EXCEEDED` | inbound used + amount > daily limit | `limitMinor`, `usedMinor`, `requestedMinor` |
| `RECIPIENT_MONTHLY_LIMIT_EXCEEDED` | inbound used + amount > monthly limit | same |
| `SELF_TRANSFER_NOT_ALLOWED` | resolved source id = destination id | — |

Rules that depend on a resolution that failed are skipped, not reported as
extra failures: if `RECIPIENT_NOT_FOUND` fires, no recipient limit codes are
emitted. Sender-side and recipient-side rules are independent, so a request can
legitimately return `INSUFFICIENT_FUNDS` and `RECIPIENT_NOT_ACTIVE` together —
that is the `multi-error` scenario.

**Limits are inclusive:** the comparison is `used + amount > limit`, so a
transfer landing exactly on the limit is allowed. This is stated explicitly
because "not exceeding" admits both readings, and the boundary is a test case.

### Recipient resolution

`RecipientResolverService`: username or mobile → `auth_identities` →
`account_holder_id`. For a corporate signatory this is already the corporate
holder, because `auth_identities_signatory_holder_fk` forces the signatory to
belong to that same holder — so signatory logins resolve to the company's
account with no special case in the code. Then: the holder's accounts filtered
to `status = 'active'`; exactly one is required, else
`RECIPIENT_NO_ACTIVE_ACCOUNT` or `RECIPIENT_AMBIGUOUS_ACCOUNT`.

Ambiguity is an explicit failure rather than a silent pick. A wallet that
guesses which of your accounts to credit is a wallet that will eventually guess
wrong, and the sender has no way to tell.

The sender's source account resolves by the identical rule from the token's
holder, with `SENDER_*` codes. This is what keeps account identifiers out of
the API entirely.

### Inbound limits

`account_limits.daily_limit_minor` / `monthly_limit_minor` apply to **both**
directions independently, against the same holder: outbound debits for the
sender, inbound credits for the recipient. No new columns; the column comments
are updated to say so.

`AccountLimitsService.getUsage` gains a `direction: 'debit' | 'credit'`
parameter and, in both directions, counts only entries with
`transfer_id IS NOT NULL`.

That filter is not a seed workaround — it is the correct rule. Opening
balances and manual adjustments are not transfers, and letting an operational
credit consume a customer's receiving headroom would mean a bank correction
silently blocks their salary. It also happens to keep the seeded opening
balances (up to PHP 750,000, well over the 50,000 daily cap) from exhausting
every holder's inbound limit on a fresh database.

`evaluate()` is extended in the same way so `GET /v1/accounts/:id/limits` can
report both directions.

### Response

All rules pass → `200`:

```json
{
  "statusCode": 200,
  "data": {
    "resolutionToken": "eyJ…",
    "expiresAt": "2026-08-27T09:17:00.000Z",
    "recipient": { "displayName": "Ethan Del Rosario" },
    "amount": "1500.00",
    "amountMinor": 150000,
    "currency": "PHP",
    "note": "Lunch"
  },
  "message": "Recipient resolved.",
  "timestamp": "…"
}
```

Only `displayName` is returned for the recipient. No account id, no masked
number, no mobile — the client already knows what it typed, and echoing
anything more would reintroduce the leak this design removes.

Any rule fails → `422` with the `errors` array described in §1.

### Resolution token

HS256, `JWT_RESOLUTION_SECRET`, 120-second expiry:

```json
{
  "typ": "send_money_resolution",
  "aid": 1,
  "src": 1,
  "dst": 2,
  "amt": 150000,
  "note": "Lunch",
  "jti": "9f1c…",
  "iat": 1772…,
  "exp": 1772…
}
```

`src` and `dst` are internal sequential account ids. They are safe here — and
only here — because the token is signed by the server, opaque to the client,
and lives two minutes. `aid` binds the token to the identity that requested it.

The token is a **hint, not an authorisation**. Phase two re-runs every rule
inside the write transaction. The token saves a resolution round-trip and
carries the note; it never substitutes for a check. This is why no
`transfer_quotes` table is needed: the idempotency key is the replay guard, and
the rules are the authority.

## 4. Phase two — `POST /v1/send-money`

### Request

```
POST /v1/send-money
Authorization: Bearer <access token>
Idempotency-Key: 7c9e6679-…        ← required on this phase

{ "resolutionToken": "eyJ…" }
```

The idempotency key is required here, unlike the old endpoint where it was
optional. A phase-two call moves money; a retry without a key sends twice.

### Flow

1. Verify the resolution token: signature, `exp`, and `typ`.
   `403 RESOLUTION_TOKEN_EXPIRED` (distinct code, so the client knows to
   re-resolve rather than surface a generic failure) or
   `403 RESOLUTION_TOKEN_INVALID`.
2. Assert `claims.aid === identity.authIdentityId`; otherwise
   `403 RESOLUTION_TOKEN_IDENTITY_MISMATCH`. A token cannot be spent by whoever
   intercepts it.
3. Open one transaction:
   - Idempotency replay lookup on `(initiated_by_auth_identity_id,
     idempotency_key)` — returns the original transfer if found.
   - `SELECT … FOR UPDATE` on both accounts, **ordered by `id`**, so two
     opposing transfers cannot deadlock holding one row each.
   - Re-run every phase-one rule against the locked rows. The token is up to
     120 seconds stale, and balances move. A violation here throws `422` with
     the same `errors` shape, but with `message: 'Transfer no longer valid;
     please confirm again.'` rather than phase one's `'Transfer cannot
     proceed.'` — the codes are identical, so the message is what tells a
     client this was a stale confirmation rather than a request that was never
     valid.
   - Insert `transfers` directly as `posted` with `posted_at = now()` and the
     `note`, catching a unique violation on the idempotency index and returning
     the winner's transfer.
   - Insert the debit/credit `ledger_entries` pair with `balance_after_minor`.
   - `UPDATE accounts SET balance_minor = balance_minor ± $1` as relative
     deltas, leaving `accounts_balance_not_negative_chk` as the authority on
     overdrafts.
   - Insert the `outbox_events` row (`transfer.posted`).

Everything commits together or not at all, so the cached balance can never
drift from the ledger and no event is published for a transfer that did not
happen.

### Response

```json
{
  "statusCode": 201,
  "data": {
    "reference": "3f2a…",
    "recipient": { "name": "Ethan Del Rosario" },
    "amount": "1500.00",
    "amountMinor": 150000,
    "currency": "PHP",
    "note": "Lunch",
    "postedAt": "2026-08-27T09:16:12.000Z"
  },
  "message": "Transfer posted.",
  "timestamp": "…"
}
```

`reference` is the transfer's `public_id`. Returning it as an *output* is fine
— it is a receipt for something that happened, and it is not accepted as an
input to any write endpoint.

## 5. Schema and seed changes

### Migration `AddTransferNote`

```sql
ALTER TABLE transfers ADD COLUMN note TEXT;
ALTER TABLE transfers ADD CONSTRAINT transfers_note_len_chk
  CHECK (note IS NULL OR char_length(note) <= 100);
COMMENT ON COLUMN transfers.note IS
  'NULL = sender attached no note. Max 100 chars, enforced by transfers_note_len_chk.';
```

On `transfers` rather than `ledger_entries`: a note describes the transfer as a
whole, not one leg of the double-entry pair, and putting it on entries would
duplicate the same text across debit and credit.

The `account_limits` column comments are updated in the same migration to state
that the limits apply per direction.

`down()` drops the constraint and column and restores the comments.

### Seed

Adds **Bobbie Salazar**, an individual holder with:

- `account_holders.status = 'suspended'`
- `accounts.status = 'suspended'`, account number `1000000005`, opening
  balance PHP 12,000
- identity `bobbie.salazar` / `09170000105` / `seed-bobbie-salazar`
- default limits

Suspending both the holder and the account lets one fixture exercise two
different rejections: `/dev/token` mints a token for them, the guard rejects it
with `IDENTITY_NOT_ACTIVE` (sender path), and naming them as a recipient
returns `RECIPIENT_NOT_ACTIVE` (recipient path).

This requires the seed's holder and account inserts to accept an optional
`status`, defaulting to `active`.

## 6. Removals

Deleted outright:

- `POST /v1/transfers` and its controller method
- `CreateTransferDto` and `create-transfer.dto.spec.ts`
- `TransfersService.create`, `assertTransferable`, `assertWithinLimits`,
  `findReplay`, `post` — replaced by `SendMoneyService`
- the unreachable currency arm of `assertTransferable`: every account is pinned
  to PHP by `accounts_currency_chk`, so the branch cannot fire
- `ExactlyOneAmountConstraint`'s host-field comment about `sourceAccountId`,
  which moves to the new DTO

Kept:

- `GET /v1/transfers/:publicId` as a read model. A `public_id` handed back as a
  receipt is a reasonable thing to look up; the objection was to accepting one
  as a write input.
- `TransfersService.findByPublicId`, `TransferResponseDto`

## 7. Module layout

```
src/common/interceptors/response.interceptor.ts
src/common/filters/all-exceptions.filter.ts
src/common/decorators/response-message.decorator.ts
src/common/errors/send-money-error.ts        ← codes + SendMoneyRuleViolation

src/auth/auth.module.ts
src/auth/jwt-auth.guard.ts
src/auth/decorators/public.decorator.ts
src/auth/decorators/current-identity.decorator.ts
src/auth/identity.types.ts
src/auth/dev-token.controller.ts
src/auth/dev-token.service.ts
src/auth/dto/dev-token-request.dto.ts
src/auth/dto/dev-token-response.dto.ts

src/send-money/send-money.module.ts
src/send-money/send-money.controller.ts
src/send-money/send-money.service.ts          ← phase two, the write
src/send-money/recipient-resolver.service.ts  ← username/mobile → account
src/send-money/send-money-rules.service.ts    ← the accumulating rule engine
src/send-money/resolution-token.service.ts    ← sign + verify
src/send-money/dto/resolve-transfer.dto.ts
src/send-money/dto/resolution-response.dto.ts
src/send-money/dto/execute-transfer.dto.ts
src/send-money/dto/send-money-receipt.dto.ts

src/database/migrations/<ts>-AddTransferNote.ts
```

Each service has one job: the resolver answers "which account", the rules
service answers "may this proceed and why not", the token service answers "is
this token real", and `SendMoneyService` owns the transaction. They are
separately testable because none of them needs the others' internals.

Modified: `main.ts`, `app.module.ts`, `accounts/account-limits.service.ts`,
`database/seeds/seed-data.ts`, `transfers/*`, `.env.example`.

## 8. Testing

TDD throughout — test first, watch it fail, then implement.

**Unit**

- `send-money-rules.service.spec.ts` — one case per error code; the inclusive
  boundary (`used + amount === limit` passes, `+1` fails) in all four limit
  directions; accumulation of independent failures; suppression of dependent
  rules when resolution fails.
- `resolution-token.service.spec.ts` — round-trip; expired token; tampered
  signature; wrong `typ`; identity mismatch.
- `response.interceptor.spec.ts` — envelope shape; `statusCode` reflects a
  `201`; `/health` and `/health/db` untouched; `/v1/accounts/health-report`
  still wrapped.
- `all-exceptions.filter.spec.ts` — rule violation → `errors` array; generic
  `HttpException` → coded shape; unknown throwable → `500` with no internals.
- `recipient-resolver.service.spec.ts` — username and mobile paths; signatory →
  corporate holder; zero and multiple active accounts.
- `account-limits.service.spec.ts` — `direction` parameter; `transfer_id IS
  NOT NULL` filter excludes opening balances.

**E2E** (`test/send-money.e2e-spec.ts`, against a migrated + seeded database)

- happy path: resolve → execute → `GET /v1/transfers/:reference` agrees;
  balances moved by exactly the amount; one debit and one credit written; one
  outbox row.
- `422` carrying several codes in one response.
- expired resolution token → `RESOLUTION_TOKEN_EXPIRED` (fake timers).
- resolution token presented by a different identity → mismatch.
- double execute with the same `Idempotency-Key` → same `reference`, balances
  moved once.
- suspended holder's token → `403 IDENTITY_NOT_ACTIVE`.

## 9. Evaluation aids

The point of this section is that someone unfamiliar with the codebase can
verify the whole flow in one command, and cross-check the result in the
database rather than taking the API's word for it.

### `scripts/scenarios.sh`

A single `curl` + `jq` script with a subcommand per scenario. It mints its own
tokens via `/v1/dev/token`, so the evaluator never copies a token by hand —
which matters because the resolution token expires in 120 seconds and manual
paste between two calls is genuinely error-prone.

```
./scripts/scenarios.sh happy
./scripts/scenarios.sh insufficient-funds
./scripts/scenarios.sh sender-limit
./scripts/scenarios.sh recipient-limit
./scripts/scenarios.sh recipient-not-found
./scripts/scenarios.sh recipient-suspended
./scripts/scenarios.sh sender-suspended
./scripts/scenarios.sh self-transfer
./scripts/scenarios.sh multi-error
./scripts/scenarios.sh expired-token
./scripts/scenarios.sh replay
./scripts/scenarios.sh all
```

Each scenario prints the request it is about to make, the envelope it got
back, the expected status and error codes, and a `PASS` / `FAIL` line. It
**asserts** rather than merely demonstrating: `all` exits non-zero if anything
diverges, which makes the script an acceptance suite rather than a demo reel.

`all` runs every scenario except `expired-token`, and prints a closing summary
naming what it skipped and how to include it, so the exclusion is visible
rather than silent.

The script checks for `jq` up front and fails with an install hint. `BASE_URL`
defaults to `http://localhost:3000` and is overridable.

`sender-limit` and `recipient-limit` need usage that a fresh seed does not
have, so they first post smaller transfers to build it up, then assert the
boundary — one transfer landing exactly on the limit succeeds, the next
centavo fails.

`expired-token` resolves, sleeps past the 120-second TTL, then executes. It is
excluded from `all` by default (it costs two minutes of wall clock) and runs
under `./scripts/scenarios.sh all --slow`.

### `docs/SEND-MONEY.md`

Prose companion, not a substitute. For each scenario: what it proves, which
endpoints it calls in order, the request bodies, the expected response, the
matching subcommand, **and a SQL query to cross-check the database**. For
example, after `happy`:

```sql
-- the transfer, its ledger pair, and the resulting balances
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

and after `replay`, the query that matters is `SELECT count(*) FROM transfers
WHERE idempotency_key = '…'` returning `1`.

The document also lists the seeded identities in a table — username, mobile,
balance, limits, status — since every scenario refers to them.

### `npm run demo`

One command: `db:reset` → `migration:run` → `db:seed` → `start:dev`. A single
documented entry point beats a four-step preamble that an evaluator can get
half-right.

### Swagger

`/docs` gets worked examples on both endpoints using real seeded usernames, so
Try-It-Out works by pasting:

- `@ApiBody` example for resolve (`ethan.delrosario`, `"1500.00"`, a note) and
  for execute.
- `@ApiOkResponse` / `@ApiCreatedResponse` examples showing the full envelope,
  not the bare payload — the envelope is what clients actually receive.
- Named `@ApiUnprocessableEntityResponse` examples: `insufficientFunds`,
  `dailyLimitExceeded`, `recipientNotActive`, `multipleErrors`.
- `@ApiHeader` documenting `Idempotency-Key` as required on execute and
  optional on resolve.
- A description on resolve explaining the 120-second TTL and that the token is
  re-validated on execute, so a client author knows a stale token is expected
  to fail rather than being a bug.

## Open questions

None. All decisions are recorded above.
