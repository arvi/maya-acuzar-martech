# `/me` Limit Usage and Transaction History — Design

Date: 2026-08-27
Status: approved, ready for implementation
Branch: `worktree-send-money`
Scope: trimmed — unit tests only; no scenario-runner subcommands, no e2e

## Problem

Two capabilities are missing, and one addressing model needs to go.

A user cannot ask how much of their sending limit is left, and cannot see
what they have sent or received. Both are answerable from data the ledger
already holds; neither has an endpoint.

Meanwhile `GET /v1/accounts/:publicId` and `GET /v1/accounts/:publicId/limits`
still address an account by `public_id` in the URL. The send-money design
removed account identifiers from write inputs on the grounds that an opaque
handle is still a bearer-ish one; leaving them on reads keeps the same
enumeration surface open. These endpoints are replaced, not merely
supplemented.

## Solution overview

```
GET /v1/me               → profile, balance, and a limits summary
GET /v1/me/limits        → flat per-direction limit usage
GET /v1/me/transactions  → transfer history, optional PHT date range
```

Every route derives the holder from the access token. No account identifier —
public or internal — is accepted as input by any of them. This is the same
property the send-money flow established, extended to the read surface.

## 1. Module layout

```
src/me/me.module.ts
src/me/me.controller.ts
src/me/me.service.ts                       ← profile + balance + limits summary
src/me/limit-usage.service.ts              ← reusable holder-keyed usage
src/me/transaction-history.service.ts
src/me/dto/me-response.dto.ts
src/me/dto/limit-usage-response.dto.ts
src/me/dto/transaction-history-query.dto.ts
src/me/dto/transaction-history-response.dto.ts
```

A new module rather than an extension of `AccountsModule`. `AccountsModule` is
organised around an account named by `publicId` — precisely the addressing this
design removes. Separating them means deleting `AccountsController` does not
disturb the new code, and no `/me` service takes an account identifier as a
parameter.

`AccountsModule` keeps `AccountsService` and `AccountLimitsService`, which the
send-money path depends on, and loses its controller.

Authorisation needs no new code. `JwtAuthGuard` is already global, so every
`/me` route is authenticated by default, and `@CurrentIdentity()` supplies
`accountHolderId`.

## 2. `LimitUsageService` — the reusable primitive

```ts
forHolder(accountHolderId: number, manager: EntityManager): Promise<LimitUsageResponseDto>
```

Keyed by **holder id**, not by a token and not by a `publicId`. `/me/limits`
passes the id from the token; the future service-to-service endpoint is a
different caller passing an id it resolved its own way. No refactor is needed
when that lands — that is the whole reason the signature takes an id.

It composes the existing `AccountLimitsService.evaluate(limit, manager,
direction)`, calling it once per direction. That method already exists and is
already tested, so this is composition, not new query logic.

Throws `404 LIMITS_NOT_CONFIGURED` when the holder has no `account_limits`
row. A holder with no configured limits is a data problem, not a user with
unlimited headroom; returning zeros or nulls would be a fiction a client
cannot distinguish from a real zero.

### Response — flat

Deliberately flat, with direction encoded in the key name rather than in a
nested array. A client reads one property; it never filters a list to find the
figure it wants.

```json
{
  "currency": "PHP",
  "periodTimezone": "Asia/Manila",
  "dailyLimit": "50000.00",             "dailyLimitMinor": 5000000,
  "monthlyLimit": "500000.00",          "monthlyLimitMinor": 50000000,
  "dailyDebitUsed": "1500.00",          "dailyDebitUsedMinor": 150000,
  "dailyDebitRemaining": "48500.00",    "dailyDebitRemainingMinor": 4850000,
  "monthlyDebitUsed": "1500.00",        "monthlyDebitUsedMinor": 150000,
  "monthlyDebitRemaining": "498500.00", "monthlyDebitRemainingMinor": 49850000,
  "dailyCreditUsed": "0.00",            "dailyCreditUsedMinor": 0,
  "dailyCreditRemaining": "50000.00",   "dailyCreditRemainingMinor": 5000000,
  "monthlyCreditUsed": "0.00",          "monthlyCreditUsedMinor": 0,
  "monthlyCreditRemaining": "500000.00","monthlyCreditRemainingMinor": 50000000
}
```

Every money figure appears twice — a fixed 2-decimal peso string for display
and the exact centavo integer to compute with — following the convention
`AccountLimitResponseDto` established. The centavo integers are what make the
response "flat for arithmetic": comparing decimal strings is not arithmetic.

`AccountLimitResponseDto` is single-direction and tied to the removed
endpoint. It is deleted, not extended.

## 3. `GET /v1/me` — profile, balance, limits summary

```json
{
  "displayName": "Adelaida Magtalas",
  "username": "adelaida.magtalas",
  "balance": "748500.00",
  "balanceMinor": 74850000,
  "currency": "PHP",
  "limits": {
    "dailyRemaining": "48500.00",      "dailyRemainingMinor": 4850000,
    "monthlyRemaining": "498500.00",   "monthlyRemainingMinor": 49850000
  }
}
```

This endpoint exists because deleting `GET /v1/accounts/:publicId` would
otherwise remove the only way to read a balance. Balance is not secret — a
failed resolve already returns `details.balanceMinor` — so withholding it
under `/me` would protect nothing while removing a capability.

The embedded `limits` block is a **summary**: the two remaining-headroom
figures a home screen shows. The full per-direction breakdown stays at
`/me/limits`. Both are produced by `LimitUsageService`, so they cannot
disagree.

Balance resolution reuses the send-money rule: the holder's single `active`
account. A holder with zero or several active accounts is the
`SENDER_NO_ACTIVE_ACCOUNT` / `SENDER_AMBIGUOUS_ACCOUNT` condition the resolver
already names, and `/me` reports it the same way rather than guessing which
account to report.

## 4. `GET /v1/me/transactions`

### Source

`ledger_entries` joined to `transfers`, filtered to the holder's accounts with
`transfer_id IS NOT NULL`.

One row per ledger entry means the user's own perspective comes for free:
their debit leg is a send, their credit leg is a receive. A self-transfer
correctly appears twice, once in each direction.

The `transfer_id IS NOT NULL` filter matches how limit usage is counted, so
the two endpoints tell a consistent story. Opening balances and manual
adjustments are not transfers and do not appear.

### Counterparty

The counterparty is the *other* leg's holder: join `transfers` back to
whichever of `source_account_id` / `destination_account_id` is not the user's
account, then to `account_holders.display_name`.

`display_name` covers individuals and corporates alike, so no subtype joins
are needed.

### Date range

`from` and `to` are optional, independent, and take the form `YYYY-MM-DD`.

They are interpreted as **Manila calendar days**, in Postgres, never in JS:

```
from → $1::date AT TIME ZONE 'Asia/Manila'                    (inclusive)
to   → ($2::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Manila' (exclusive)
```

`to` is exclusive-of-next-midnight so the named day is fully included — a
transfer at 23:30 PHT on the `to` date is in range. Computing this in Node
would mean reimplementing DST-aware boundaries against the server's clock,
which is a different clock from the one the product promises; the existing
limit windows already delegate to Postgres for exactly this reason.

Validation: `@Matches(/^\d{4}-\d{2}-\d{2}$/)` plus a real-date check, so
`2026-02-30` is rejected rather than silently rolled over. `from > to` is a
`400`.

### Ordering and size

Ordered `posted_at DESC, id DESC`. The `id` tiebreak keeps rows posted in the
same instant deterministic — without it, paging or repeated calls can
interleave differently.

- No range → the latest **5**.
- With a range → capped at **100**. An unbounded scan over a wide range is the
  one way this endpoint misbehaves under load. The cap is applied with `DESC`
  ordering, so what a client loses is the oldest rows, not the newest.

### Response

Mirrors the phase-two receipt for consistency, adding `direction` and
`counterpartyName`:

```json
[
  {
    "reference": "3f2a7c18-9d4e-4c1b-9f7a-2b8e5d6c1a90",
    "direction": "debit",
    "counterpartyName": "Ethan Del Rosario",
    "amount": "1500.00",
    "amountMinor": 150000,
    "currency": "PHP",
    "note": "Lunch",
    "postedAt": "2026-08-27T09:16:12.000Z"
  }
]
```

`reference` is the transfer's `public_id` — an output-only receipt, which the
send-money design explicitly permits: the objection was to accepting one as a
write input.

An empty array means no transactions. Never a `404`: the absence of history is
a fact about an existing user, not a missing resource.

## 5. Removals

- `AccountsController` entirely — `GET /v1/accounts/:publicId` and
  `GET /v1/accounts/:publicId/limits`
- `AccountResponseDto`, `AccountLimitResponseDto`
- `AccountsService.getAccount`, `AccountsService.getLimits`
- `AccountsService.findByPublicId` — verified unreferenced outside
  `src/accounts/`, so it goes with the rest

Kept: `AccountLimitsService` (send-money depends on it), and `AccountsModule`
itself as a provider-only module.

The `POST /v1/transfers` cleanup named in the original request is already done
on this branch: `c79d15b` removed the transfers controller and service,
leaving only the entity.

## 6. Testing

TDD throughout — test first, watch it fail, then implement. Unit tests only in
this slice; the scenario runner and e2e are deliberately out of scope.

`limit-usage.service.spec.ts`
- both directions returned, keyed correctly
- the `transfer_id IS NOT NULL` exclusion — an opening balance does not consume
  headroom
- remaining floored at zero when usage exceeds the limit
- missing `account_limits` row → `LIMITS_NOT_CONFIGURED`

`transaction-history.service.spec.ts`
- a debit leg reports `direction: 'debit'`; a credit leg `'credit'`
- counterparty resolves to the other party in both directions
- corporate counterparty resolves via `display_name`
- no range → latest 5, ordered `posted_at DESC, id DESC`
- PHT boundary: a transfer at 23:30 PHT on the `to` date is included
- empty history → `[]`

`transaction-history-query.dto.spec.ts`
- malformed date, impossible date (`2026-02-30`), inverted range
- both bounds absent, and each present alone

`me.service.spec.ts`
- profile and balance from the single active account
- the `limits` summary agrees with `/me/limits` for the same holder

## 7. Out of scope

- **Inspecting any user's limit usage.** Deferred deliberately: the schema has
  no `internalUserId` on users for a service-to-service caller to name a
  holder by, and `public_id` is not to be used for it. `LimitUsageService.
  forHolder` takes a holder id so that endpoint can be added without a
  refactor when that identifier exists.
- Scenario-runner subcommands and e2e coverage for these endpoints.
- Pagination beyond the 100-row cap.

## Open questions

None.
