# Two-Phase Send Money Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `POST /v1/transfers` with a two-phase send-money flow in which the client never names an account, and every rejection reason is reported at once.

**Architecture:** Phase one (`POST /v1/send-money/resolve`) resolves sender and recipient from the access token and a username/mobile number, accumulates every rule violation into a `422` array, and on success returns a 120-second signed resolution token carrying internal account ids and the note. Phase two (`POST /v1/send-money`) verifies that token, then re-runs every rule inside one write transaction before posting the transfer, its ledger pair, both balances and an outbox event. A global interceptor wraps all responses in `{ statusCode, data, message, timestamp }`.

**Tech Stack:** NestJS 11, TypeORM 1.1, PostgreSQL 16, `@nestjs/jwt` (new), class-validator, Jest, Biome, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-27-two-phase-send-money-design.md`

## Global Constraints

- **Money is centavos.** Every internal amount is an integer minor unit. Never multiply pesos by 100 — use `pesosToMinor()` / `minorToPesos()` from `src/common/money.ts`.
- **Limits are inclusive.** The comparison is `used + amount > limit` → violation. A transfer landing exactly on the limit is allowed.
- **Usage counts only transfer-linked entries.** Every usage query filters `transfer_id IS NOT NULL`. Opening balances and manual adjustments never consume headroom.
- **Limits apply per direction against the same columns.** `daily_limit_minor` / `monthly_limit_minor` bound outbound debits for the sender and inbound credits for the recipient, independently.
- **No account identifier is ever a client input.** Not `public_id`, not sequential id. Sender comes from the access token; recipient from username/mobile. Internal ids appear only inside the signed resolution token.
- **Production hardening keys off `NODE_ENV === 'production'` exactly.** Any other value (including `demo`) is a non-production build.
- **Two distinct JWT secrets.** `JWT_ACCESS_SECRET` and `JWT_RESOLUTION_SECRET` are never the same key.
- **Note max length is 100 characters**, enforced by both `@MaxLength(100)` and `transfers_note_len_chk`.
- **Resolution token TTL is 120 seconds** (`JWT_RESOLUTION_TTL_SECONDS`), access token 3600 (`JWT_ACCESS_TTL_SECONDS`).
- **Timezone for limit windows is `Asia/Manila`** via `CALENDAR_BOUNDARY_TIMEZONE`; windows are computed in Postgres, never in JS.
- **Currency is always `PHP`** (`SUPPORTED_CURRENCY`). Do not write currency-mismatch branches — `accounts_currency_chk` makes them unreachable.
- **Lock ordering:** when locking two accounts, always `ORDER BY id` to make deadlock impossible.
- **Run `npm run lint:fix` and `npm run lint:spell` before every commit.** New proper nouns go in `cspell.json`.

## File Structure

| File | Responsibility |
|---|---|
| `src/common/errors/send-money-error.ts` | `SendMoneyErrorCode` enum, `SendMoneyRuleViolation` exception carrying an `errors[]` array |
| `src/common/decorators/response-message.decorator.ts` | `@ResponseMessage('…')` metadata for the envelope |
| `src/common/interceptors/response.interceptor.ts` | Wraps success responses; excludes `/health` |
| `src/common/filters/all-exceptions.filter.ts` | Shapes every error into the same envelope |
| `src/auth/identity.types.ts` | `AuthenticatedIdentity` shape attached to the request |
| `src/auth/jwt.config.ts` | Reads + validates JWT env vars; fails fast in production |
| `src/auth/decorators/public.decorator.ts` | `@Public()` guard opt-out |
| `src/auth/decorators/current-identity.decorator.ts` | `@CurrentIdentity()` param decorator |
| `src/auth/jwt-auth.guard.ts` | Verifies bearer token, loads identity, rejects non-active holders |
| `src/auth/dev-token.service.ts` | Mints Keycloak-shaped access tokens for seeded identities |
| `src/auth/dev-token.controller.ts` | `POST /v1/dev/token` |
| `src/auth/auth.module.ts` | Wires the guard globally; registers dev-token only outside production |
| `src/send-money/resolution-token.service.ts` | Signs and verifies the 120s resolution token |
| `src/send-money/recipient-resolver.service.ts` | username/mobile → holder → single active account |
| `src/send-money/send-money-rules.service.ts` | Accumulating rule engine |
| `src/send-money/send-money.service.ts` | Phase-two transaction: transfer, ledger pair, balances, outbox |
| `src/send-money/send-money.controller.ts` | Both endpoints + Swagger examples |
| `src/database/migrate-and-seed.ts` | Compiled entrypoint for the one-shot `migrate` compose service |
| `scripts/scenarios.sh` | Self-asserting scenario runner |
| `docs/SEND-MONEY.md` | Scenario walkthrough + SQL cross-checks |

## Task Overview

| # | Task | Deliverable |
|---|---|---|
| 1 | Response envelope | Interceptor + filter + error codes, wired globally |
| 2 | Note migration + suspended seed | Schema and fixture ready |
| 3 | Per-direction limit usage | `getUsage(holderId, manager, direction)` |
| 4 | JWT config + dev token | `POST /v1/dev/token` mints tokens |
| 5 | Auth guard | Global bearer auth with active-holder check |
| 6 | Resolution token service | Sign/verify with all failure modes |
| 7 | Recipient resolver | username/mobile → account, incl. signatories |
| 8 | Rules engine | All 12 codes, accumulating |
| 9 | Phase one endpoint | `POST /v1/send-money/resolve` |
| 10 | Phase two endpoint | `POST /v1/send-money` |
| 11 | Remove old transfer write path | Dead code gone |
| 12 | Compose: migrate service + demo mode | `docker compose up` works |
| 13 | Scenario script + docs | `./scripts/scenarios.sh all` |

---

### Task 1: Response envelope

**Files:**
- Create: `src/common/errors/send-money-error.ts`
- Create: `src/common/decorators/response-message.decorator.ts`
- Create: `src/common/interceptors/response.interceptor.ts`
- Create: `src/common/filters/all-exceptions.filter.ts`
- Modify: `src/main.ts`
- Test: `src/common/interceptors/response.interceptor.spec.ts`
- Test: `src/common/filters/all-exceptions.filter.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SendMoneyErrorCode` (string enum), `SendMoneyError { code, message, details? }`, `SendMoneyRuleViolation extends HttpException` with `.errors: SendMoneyError[]` and `.summary: string`, `@ResponseMessage(msg: string)`, `ResponseInterceptor`, `AllExceptionsFilter`.

- [ ] **Step 1: Write the failing interceptor test**

Create `src/common/interceptors/response.interceptor.spec.ts`:

```typescript
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, lastValueFrom } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

function contextFor(path: string, statusCode = 200): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({ route: { path }, url: path }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

const next = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('ResponseInterceptor', () => {
  let interceptor: ResponseInterceptor;

  beforeEach(() => {
    const reflector = new Reflector();
    interceptor = new ResponseInterceptor(reflector);
  });

  it('wraps the payload in the envelope', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(contextFor('/v1/accounts/x'), next({ a: 1 })),
    );

    expect(result).toEqual({
      statusCode: 200,
      data: { a: 1 },
      message: 'OK',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('reports the real status code, not a hardcoded 200', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(contextFor('/v1/send-money', 201), next({})),
    );

    expect(result).toMatchObject({ statusCode: 201 });
  });

  it('leaves /health untouched so probes keep their shape', async () => {
    const payload = { status: 'ok', database: 'connected' };

    const result = await lastValueFrom(
      interceptor.intercept(contextFor('/health'), next(payload)),
    );

    expect(result).toBe(payload);
  });

  it('still wraps a path that merely contains "health"', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(contextFor('/v1/accounts/health-report'), next({})),
    );

    expect(result).toMatchObject({ statusCode: 200, data: {} });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/common/interceptors/response.interceptor.spec.ts`
Expected: FAIL — `Cannot find module './response.interceptor'`.

- [ ] **Step 3: Write the error codes and rule-violation exception**

Create `src/common/errors/send-money-error.ts`:

```typescript
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Machine-readable reasons a send-money request cannot proceed.
 *
 * Phase one reports every applicable code at once; phase two re-checks the same
 * rules and reuses the same codes, so a client maps a code to a message once.
 */
export enum SendMoneyErrorCode {
  SenderNoActiveAccount = 'SENDER_NO_ACTIVE_ACCOUNT',
  SenderAmbiguousAccount = 'SENDER_AMBIGUOUS_ACCOUNT',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  SenderDailyLimitExceeded = 'SENDER_DAILY_LIMIT_EXCEEDED',
  SenderMonthlyLimitExceeded = 'SENDER_MONTHLY_LIMIT_EXCEEDED',
  RecipientNotFound = 'RECIPIENT_NOT_FOUND',
  RecipientNotActive = 'RECIPIENT_NOT_ACTIVE',
  RecipientNoActiveAccount = 'RECIPIENT_NO_ACTIVE_ACCOUNT',
  RecipientAmbiguousAccount = 'RECIPIENT_AMBIGUOUS_ACCOUNT',
  RecipientDailyLimitExceeded = 'RECIPIENT_DAILY_LIMIT_EXCEEDED',
  RecipientMonthlyLimitExceeded = 'RECIPIENT_MONTHLY_LIMIT_EXCEEDED',
  SelfTransferNotAllowed = 'SELF_TRANSFER_NOT_ALLOWED',
}

export interface SendMoneyError {
  code: SendMoneyErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Summary used when phase one rejects a request that was never valid. */
export const RESOLVE_FAILED_SUMMARY = 'Transfer cannot proceed.';

/**
 * Summary used when phase two rejects a request that passed phase one.
 *
 * The codes are identical in both phases, so the summary is the only thing
 * telling a client "your confirmation went stale" apart from "your request was
 * never valid".
 */
export const EXECUTE_STALE_SUMMARY =
  'Transfer no longer valid; please confirm again.';

/**
 * Carries every failed rule rather than the first one. A confirmation screen
 * has to show all of them at once, so throwing on the first violation would
 * make the client re-submit to discover the next.
 */
export class SendMoneyRuleViolation extends HttpException {
  constructor(
    readonly errors: SendMoneyError[],
    readonly summary: string = RESOLVE_FAILED_SUMMARY,
  ) {
    super({ errors }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
```

- [ ] **Step 4: Write the response-message decorator**

Create `src/common/decorators/response-message.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const RESPONSE_MESSAGE_KEY = 'response_message';

/** Sets the envelope's `message`. Without it the interceptor uses 'OK'. */
export const ResponseMessage = (message: string) =>
  SetMetadata(RESPONSE_MESSAGE_KEY, message);
```

- [ ] **Step 5: Write the interceptor**

Create `src/common/interceptors/response.interceptor.ts`:

```typescript
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { RESPONSE_MESSAGE_KEY } from '../decorators/response-message.decorator';

export interface ApiEnvelope<T> {
  statusCode: number;
  data: T;
  message: string;
  timestamp: string;
}

/**
 * Health probes are consumed by infrastructure that expects Terminus' own
 * shape, so wrapping them would break liveness checks.
 *
 * Matched on the route path rather than by substring, so an endpoint like
 * /v1/accounts/health-report is not excluded by accident.
 */
export function isHealthPath(path: string): boolean {
  return path === '/health' || path.startsWith('/health/');
}

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const path: string = request.route?.path ?? request.url ?? '';

    if (isHealthPath(path)) {
      return next.handle();
    }

    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'OK';

    return next.handle().pipe(
      map((data) => ({
        // Read from the response rather than hardcoded, so a 201 stays a 201.
        statusCode: http.getResponse().statusCode,
        data,
        message,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
```

- [ ] **Step 6: Run the interceptor test**

Run: `npx jest src/common/interceptors/response.interceptor.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Write the failing filter test**

Create `src/common/filters/all-exceptions.filter.spec.ts`:

```typescript
import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import {
  SendMoneyErrorCode,
  SendMoneyRuleViolation,
} from '../errors/send-money-error';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostFor(path: string) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ route: { path }, url: path }),
      getResponse: () => ({ status, json }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  it('returns the accumulated errors array for a rule violation', () => {
    const { host, status, json } = hostFor('/v1/send-money/resolve');
    const violation = new SendMoneyRuleViolation([
      {
        code: SendMoneyErrorCode.InsufficientFunds,
        message: 'Insufficient funds.',
        details: { balanceMinor: 100, requestedMinor: 500 },
      },
      {
        code: SendMoneyErrorCode.RecipientNotActive,
        message: 'Recipient cannot receive funds.',
      },
    ]);

    filter.catch(violation, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        message: 'Transfer cannot proceed.',
        data: {
          errors: [
            expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }),
            expect.objectContaining({ code: 'RECIPIENT_NOT_ACTIVE' }),
          ],
        },
      }),
    );
  });

  it('gives an ordinary HttpException a coded envelope', () => {
    const { host, status, json } = hostFor('/v1/send-money');

    filter.catch(new BadRequestException('Body is malformed.'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Body is malformed.',
        data: expect.objectContaining({ code: 'BAD_REQUEST' }),
      }),
    );
  });

  it('hides internals of an unknown throwable behind a 500', () => {
    const { host, status, json } = hostFor('/v1/send-money');

    filter.catch(new Error('connection string: postgres://user:pw@host'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.data).toEqual({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('leaves a failing /health probe in the Terminus shape', () => {
    const { host, json } = hostFor('/health');
    const probe = new BadRequestException({
      status: 'error',
      database: 'disconnected',
    });

    filter.catch(probe, host);

    expect(json).toHaveBeenCalledWith({
      status: 'error',
      database: 'disconnected',
    });
  });
});
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx jest src/common/filters/all-exceptions.filter.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 9: Write the filter**

Create `src/common/filters/all-exceptions.filter.ts`:

```typescript
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { SendMoneyRuleViolation } from '../errors/send-money-error';
import { isHealthPath } from '../interceptors/response.interceptor';

/** HTTP status → stable machine-readable code for non-domain errors. */
const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const path: string = request.route?.path ?? request.url ?? '';

    // Health probes keep their own shape, failures included.
    if (isHealthPath(path)) {
      const status =
        exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.SERVICE_UNAVAILABLE;
      response.status(status).json(
        exception instanceof HttpException
          ? exception.getResponse()
          : { status: 'error' },
      );
      return;
    }

    const { status, data, message } = this.describe(exception);

    response.status(status).json({
      statusCode: status,
      data,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  private describe(exception: unknown): {
    status: number;
    data: Record<string, unknown>;
    message: string;
  } {
    if (exception instanceof SendMoneyRuleViolation) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        data: { errors: exception.errors },
        message: exception.summary,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // Nest's built-in exceptions return either a string or
      // { statusCode, message, error }; class-validator returns message[].
      const detail =
        typeof payload === 'string'
          ? { message: payload }
          : (payload as Record<string, unknown>);

      const raw = detail.message;
      const message = Array.isArray(raw)
        ? 'Request validation failed.'
        : typeof raw === 'string'
          ? raw
          : exception.message;

      const code =
        (typeof detail.code === 'string' ? detail.code : undefined) ??
        STATUS_CODES[status] ??
        'ERROR';

      const { message: _omit, statusCode: _status, ...rest } = detail;

      return {
        status,
        data: { code, ...(Array.isArray(raw) ? { violations: raw } : {}), ...rest },
        message,
      };
    }

    // Anything else is a bug. Log it with the stack; return nothing internal.
    this.logger.error(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception.stack : undefined,
    );

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      data: { code: 'INTERNAL_ERROR' },
      message: 'An unexpected error occurred.',
    };
  }
}
```

- [ ] **Step 10: Run the filter test**

Run: `npx jest src/common/filters/all-exceptions.filter.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 11: Wire both globally in main.ts**

In `src/main.ts`, add imports and register after the existing `useGlobalPipes` block:

```typescript
import { Reflector } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
```

```typescript
  // Envelope every response in { statusCode, data, message, timestamp }.
  // The filter mirrors the interceptor so success and failure parse alike.
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter());
```

- [ ] **Step 12: Verify the envelope end to end**

Run: `npm run build && npx jest src/common`
Expected: build succeeds; all `src/common` specs pass (includes the existing `money.spec.ts`).

- [ ] **Step 13: Lint and commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/common src/main.ts
git commit -m "feat(common): envelope every response as {statusCode,data,message,timestamp}

A global interceptor wraps successes and a matching filter shapes errors,
so clients parse one shape always. /health is excluded in both: probes are
consumed by infrastructure expecting the Terminus shape.

SendMoneyRuleViolation carries an errors[] array rather than a single
reason, because a confirmation screen has to show every failed rule at
once."
```

---

### Task 2: Note column migration and the suspended seed

**Files:**
- Create: `src/database/migrations/1788000000000-AddTransferNote.ts`
- Modify: `src/transfers/entities/transfer.entity.ts`
- Modify: `src/database/seeds/seed-data.ts`
- Modify: `cspell.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `transfers.note` column; `Transfer.note: string | null`; seeded identity `bobbie.salazar` (subject `seed-bobbie-salazar`, mobile `09170000105`) whose holder **and** account are both `suspended`; `HolderSeed.status` and `AccountSeed.status` optional fields.

- [ ] **Step 1: Write the migration**

Create `src/database/migrations/1788000000000-AddTransferNote.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTransferNote1788000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // On transfers rather than ledger_entries: a note describes the transfer as
    // a whole, not one leg of the double-entry pair. Putting it on entries would
    // duplicate the same text across the debit and the credit.
    await queryRunner.query(`
      ALTER TABLE transfers ADD COLUMN note TEXT;

      ALTER TABLE transfers ADD CONSTRAINT transfers_note_len_chk
        CHECK (note IS NULL OR char_length(note) <= 100);

      COMMENT ON COLUMN transfers.note IS
        'NULL = sender attached no note. Max 100 chars, enforced by transfers_note_len_chk.';
    `);

    // The limits were documented as outbound-only. They now bound each
    // direction independently against the same numbers: outbound debits for the
    // sender, inbound credits for the recipient.
    await queryRunner.query(`
      COMMENT ON COLUMN account_limits.daily_limit_minor IS
        'Max per day in PHP centavos, applied per direction: outbound debits for a sender, inbound credits for a recipient. Usage counts only ledger entries tied to a transfer.';

      COMMENT ON COLUMN account_limits.monthly_limit_minor IS
        'Max per month in PHP centavos, applied per direction: outbound debits for a sender, inbound credits for a recipient. Usage counts only ledger entries tied to a transfer.';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_note_len_chk;
      ALTER TABLE transfers DROP COLUMN IF EXISTS note;

      COMMENT ON COLUMN account_limits.daily_limit_minor   IS 'Max outbound per day in PHP centavos (minor units)';
      COMMENT ON COLUMN account_limits.monthly_limit_minor IS 'Max outbound per month in PHP centavos (minor units)';
    `);
  }
}
```

- [ ] **Step 2: Add the column to the entity**

In `src/transfers/entities/transfer.entity.ts`, after the `failureReason` property:

```typescript
  /** NULL = sender attached no note. Max 100 chars, enforced by the schema. */
  @Column({ type: 'text', nullable: true })
  note: string | null;
```

- [ ] **Step 3: Run the migration**

Run: `docker compose up -d postgres && npm run migration:run`
Expected: `AddTransferNote1788000000000 has been executed successfully.`

- [ ] **Step 4: Verify the constraint actually bites**

Run:

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT conname FROM pg_constraint WHERE conname = 'transfers_note_len_chk';"
```

Expected: one row named `transfers_note_len_chk`.

- [ ] **Step 5: Add status to the seed interfaces**

In `src/database/seeds/seed-data.ts`, extend the interfaces:

```typescript
interface AccountSeed {
  accountNumber: string;
  /** Credited to the account by an opening ledger entry. */
  openingBalanceMinor: number;
  /** Defaults to 'active'. */
  status?: 'active' | 'suspended' | 'closed';
}
```

Add to **both** `IndividualSeed` and `CorporateSeed`:

```typescript
  /** Defaults to 'active'. */
  status?: 'active' | 'suspended' | 'closed';
```

- [ ] **Step 6: Honour status in the inserts**

In `insertHolder`, change the holder insert:

```typescript
  const [{ id: holderId }] = await manager.query(
    `INSERT INTO account_holders (holder_type, display_name, status)
     VALUES ($1, $2, $3) RETURNING id`,
    [holder.kind, holder.displayName, holder.status ?? 'active'],
  );
```

and the account insert:

```typescript
    const [{ id: accountId }] = await manager.query(
      `INSERT INTO accounts (account_holder_id, account_number, balance_minor, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        holderId,
        account.accountNumber,
        account.openingBalanceMinor,
        account.status ?? 'active',
      ],
    );
```

- [ ] **Step 7: Add Bobbie Salazar**

Append to `HOLDER_SEEDS`, after Abigail Lim:

```typescript
  {
    // Suspended at both levels on purpose: one fixture exercises two
    // rejections. /dev/token still mints a token for them, the guard rejects it
    // (sender path), and naming them as a recipient fails on account status.
    kind: 'individual',
    displayName: 'Bobbie Salazar',
    firstName: 'Bobbie',
    lastName: 'Salazar',
    dateOfBirth: '1991-04-22',
    status: 'suspended',
    identities: [
      {
        subject: 'seed-bobbie-salazar',
        username: 'bobbie.salazar',
        email: 'bobbie.salazar@example.com',
        mobileNumber: '09170000105',
      },
    ],
    accounts: [
      {
        accountNumber: '1000000005',
        openingBalanceMinor: php(12_000),
        status: 'suspended',
      },
    ],
    limits: DEFAULT_LIMITS,
  },
```

- [ ] **Step 8: Reseed and verify**

Run: `npm run db:seed:reset`
Expected: `Seeded 7 holders and 8 identities with accounts and limits.`

Then:

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT ai.username, h.status AS holder, a.status AS account
     FROM auth_identities ai
     JOIN account_holders h ON h.id = ai.account_holder_id
     JOIN accounts a ON a.account_holder_id = h.id
    WHERE ai.username = 'bobbie.salazar';"
```

Expected: one row, `holder = suspended`, `account = suspended`.

- [ ] **Step 9: Lint and commit**

`Salazar` and `bobbie` are already in `cspell.json` from the spec work; if `npm run lint:spell` still complains, add the flagged word.

```bash
npm run lint:fix && npm run lint:spell
git add src/database src/transfers/entities/transfer.entity.ts cspell.json
git commit -m "feat(schema): add transfers.note and a suspended holder fixture

note lives on transfers, not ledger_entries: it describes the transfer as
a whole rather than one leg of the double-entry pair.

Bobbie Salazar is suspended at both the holder and the account level, so a
single fixture covers rejection as a sender (guard) and as a recipient
(account status)."
```

---

### Task 3: Per-direction limit usage

**Files:**
- Modify: `src/accounts/account-limits.service.ts`
- Modify: `src/accounts/accounts.service.ts`
- Test: `src/accounts/account-limits.service.spec.ts`

**Interfaces:**
- Consumes: `Task 2` (nothing structural).
- Produces:
  - `type LimitDirection = 'debit' | 'credit'`
  - `getUsage(accountHolderId: number, manager: EntityManager, direction: LimitDirection): Promise<LimitUsage>`
  - `evaluate(limit: AccountLimit, manager: EntityManager, direction: LimitDirection): Promise<LimitEvaluation>`

Both gain a **required** third parameter. Making it required rather than defaulting to `'debit'` forces every call site to state its direction, so an inbound check cannot silently measure outbound usage.

- [ ] **Step 1: Write the failing test**

Create `src/accounts/account-limits.service.spec.ts`:

```typescript
import { EntityManager } from 'typeorm';
import { AccountLimitsService } from './account-limits.service';

describe('AccountLimitsService.getUsage', () => {
  let service: AccountLimitsService;
  let manager: { query: jest.Mock };

  beforeEach(() => {
    manager = { query: jest.fn().mockResolvedValue([{ daily_used: '0', monthly_used: '0' }]) };
    service = new AccountLimitsService({} as never);
  });

  it('filters on the requested direction', async () => {
    await service.getUsage(1, manager as unknown as EntityManager, 'credit');

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain('le.direction = $3');
    expect(params[2]).toBe('credit');
  });

  it('counts only entries tied to a transfer', async () => {
    await service.getUsage(1, manager as unknown as EntityManager, 'debit');

    // Opening balances and manual adjustments have a NULL transfer_id. Letting
    // them consume headroom would mean a bank correction blocks a salary.
    expect(manager.query.mock.calls[0][0]).toContain(
      'le.transfer_id IS NOT NULL',
    );
  });

  it('returns numbers, not the strings pg hands back for bigint', async () => {
    manager.query.mockResolvedValue([
      { daily_used: '1500', monthly_used: '90000' },
    ]);

    const usage = await service.getUsage(
      1,
      manager as unknown as EntityManager,
      'debit',
    );

    expect(usage).toEqual({ dailyUsedMinor: 1500, monthlyUsedMinor: 90000 });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/accounts/account-limits.service.spec.ts`
Expected: FAIL — `getUsage` takes 2 arguments, and the SQL contains neither `$3` nor the transfer filter.

- [ ] **Step 3: Add the direction parameter**

In `src/accounts/account-limits.service.ts`, add the type and rewrite `getUsage`:

```typescript
/**
 * Which side of the ledger a limit is measuring. Sender limits bound outbound
 * debits; recipient limits bound inbound credits, against the same columns.
 */
export type LimitDirection = 'debit' | 'credit';
```

```typescript
  /**
   * Sums posted entries in one direction across every account the holder owns,
   * inside the current day and month windows.
   *
   * The windows are computed in CALENDAR_BOUNDARY_TIMEZONE via Postgres
   * (`AT TIME ZONE` + `date_trunc`) rather than in JS. Doing it in Node would
   * mean reimplementing DST-aware month boundaries against the server's local
   * clock, which is a different clock from the one the product promises.
   *
   * Only entries tied to a transfer count. An opening balance or a manual
   * adjustment is not a transfer, and letting one consume a customer's
   * headroom would mean an operational correction silently blocks their money.
   */
  async getUsage(
    accountHolderId: number,
    manager: EntityManager,
    direction: LimitDirection,
  ): Promise<LimitUsage> {
    const [row] = await manager.query(
      `
      WITH holder_accounts AS (
        SELECT id FROM accounts WHERE account_holder_id = $1
      ),
      bounds AS (
        SELECT
          date_trunc('day',   now() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start,
          date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2 AS month_start
      )
      SELECT
        COALESCE(SUM(le.amount_minor)
          FILTER (WHERE le.posted_at >= bounds.day_start), 0)   AS daily_used,
        COALESCE(SUM(le.amount_minor)
          FILTER (WHERE le.posted_at >= bounds.month_start), 0) AS monthly_used
      FROM ledger_entries le
      CROSS JOIN bounds
      WHERE le.account_id IN (SELECT id FROM holder_accounts)
        AND le.direction = $3
        AND le.transfer_id IS NOT NULL
        AND le.posted_at >= bounds.month_start
      `,
      [accountHolderId, CALENDAR_BOUNDARY_TIMEZONE, direction],
    );

    return {
      dailyUsedMinor: Number(row.daily_used),
      monthlyUsedMinor: Number(row.monthly_used),
    };
  }
```

- [ ] **Step 4: Thread direction through evaluate()**

```typescript
  /** Usage plus remaining headroom in one direction, floored at zero. */
  async evaluate(
    limit: AccountLimit,
    manager: EntityManager,
    direction: LimitDirection,
  ): Promise<LimitEvaluation> {
    const usage = await this.getUsage(limit.accountHolderId, manager, direction);

    return {
      limit,
      ...usage,
      dailyRemainingMinor: Math.max(
        0,
        limit.dailyLimitMinor - usage.dailyUsedMinor,
      ),
      monthlyRemainingMinor: Math.max(
        0,
        limit.monthlyLimitMinor - usage.monthlyUsedMinor,
      ),
    };
  }
```

- [ ] **Step 5: Fix the one existing call site**

In `src/accounts/accounts.service.ts`, `getLimits()` reports send-money headroom, so it passes `'debit'`:

```typescript
    const evaluation = await this.limitsService.evaluate(
      limit,
      this.accountRepository.manager,
      'debit',
    );
```

- [ ] **Step 6: Run the tests and the build**

Run: `npx jest src/accounts && npm run build`
Expected: 3 tests pass; build succeeds with no call-site type errors.

- [ ] **Step 7: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/accounts
git commit -m "feat(limits): measure usage per direction, ignoring non-transfer entries

The same limit columns now bound outbound debits for a sender and inbound
credits for a recipient. direction is required rather than defaulting, so
an inbound check cannot silently measure outbound usage.

Usage counts only entries with a transfer_id: opening balances and manual
adjustments are not transfers and must not consume a customer's headroom."
```

---

### Task 4: JWT configuration and the dev token endpoint

**Files:**
- Create: `src/auth/jwt.config.ts`
- Create: `src/auth/identity.types.ts`
- Create: `src/auth/dto/dev-token-request.dto.ts`
- Create: `src/auth/dto/dev-token-response.dto.ts`
- Create: `src/auth/dev-token.service.ts`
- Create: `src/auth/dev-token.controller.ts`
- Create: `src/auth/auth.module.ts`
- Modify: `src/app.module.ts`, `src/main.ts`, `.env.example`, `package.json`
- Test: `src/auth/jwt.config.spec.ts`, `src/auth/dev-token.service.spec.ts`

**Interfaces:**
- Consumes: Task 1's `@ResponseMessage`.
- Produces:
  - `jwtConfig()` → `{ accessSecret, accessTtlSeconds, resolutionSecret, resolutionTtlSeconds, issuer }`
  - `isProduction(): boolean`
  - `AuthenticatedIdentity { authIdentityId: number; accountHolderId: number; subject: string; username: string; displayName: string; holderStatus: string }`
  - `DevTokenService.mint(username: string): Promise<DevTokenResponseDto>`
  - `AuthModule`

- [ ] **Step 1: Install @nestjs/jwt**

```bash
npm install @nestjs/jwt
```

No Passport: there is one token type from one issuer, and a guard reading a bearer header is less machinery than a strategy registry.

- [ ] **Step 2: Write the failing config test**

Create `src/auth/jwt.config.spec.ts`:

```typescript
import { isProduction, jwtConfig } from './jwt.config';

describe('jwtConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('falls back to dev secrets outside production', () => {
    process.env.NODE_ENV = 'demo';
    delete process.env.JWT_ACCESS_SECRET;
    delete process.env.JWT_RESOLUTION_SECRET;

    const config = jwtConfig();

    expect(config.accessSecret).toBeTruthy();
    expect(config.resolutionSecret).toBeTruthy();
    expect(config.accessSecret).not.toEqual(config.resolutionSecret);
  });

  it('refuses to start in production without secrets', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_ACCESS_SECRET;

    expect(() => jwtConfig()).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects reusing one secret for both token types', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'same-secret-value';
    process.env.JWT_RESOLUTION_SECRET = 'same-secret-value';

    expect(() => jwtConfig()).toThrow(/must differ/);
  });

  it('treats only the exact string "production" as production', () => {
    process.env.NODE_ENV = 'demo';
    expect(isProduction()).toBe(false);

    process.env.NODE_ENV = 'production';
    expect(isProduction()).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx jest src/auth/jwt.config.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the config**

Create `src/auth/jwt.config.ts`:

```typescript
/**
 * Exactly the string 'production' counts as production. Anything else —
 * 'demo', 'development', unset — is a non-production build in which
 * POST /v1/dev/token is registered and secret fallbacks apply.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export interface JwtConfig {
  accessSecret: string;
  accessTtlSeconds: number;
  resolutionSecret: string;
  resolutionTtlSeconds: number;
  issuer: string;
}

const DEV_ACCESS_SECRET = 'dev-only-access-secret-do-not-use-in-production';
const DEV_RESOLUTION_SECRET =
  'dev-only-resolution-secret-do-not-use-in-production';

function requiredInProduction(name: string, fallback: string): string {
  const value = process.env[name];
  if (value) return value;

  if (isProduction()) {
    throw new Error(
      `${name} must be set when NODE_ENV=production. Refusing to start with a well-known development secret.`,
    );
  }

  return fallback;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of seconds.`);
  }

  return value;
}

/**
 * Access tokens and resolution tokens are signed with different keys on
 * purpose. An access token authorises a session; a resolution token authorises
 * one specific movement of money. Sharing a key would let either be presented
 * where the other is expected.
 */
export function jwtConfig(): JwtConfig {
  const accessSecret = requiredInProduction(
    'JWT_ACCESS_SECRET',
    DEV_ACCESS_SECRET,
  );
  const resolutionSecret = requiredInProduction(
    'JWT_RESOLUTION_SECRET',
    DEV_RESOLUTION_SECRET,
  );

  if (accessSecret === resolutionSecret) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_RESOLUTION_SECRET must differ; a shared key lets one token type be presented as the other.',
    );
  }

  return {
    accessSecret,
    resolutionSecret,
    accessTtlSeconds: positiveInt('JWT_ACCESS_TTL_SECONDS', 3600),
    resolutionTtlSeconds: positiveInt('JWT_RESOLUTION_TTL_SECONDS', 120),
    issuer:
      process.env.JWT_ISSUER ?? 'http://localhost:8080/realms/send-money',
  };
}
```

- [ ] **Step 5: Run the config test**

Run: `npx jest src/auth/jwt.config.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the identity type**

Create `src/auth/identity.types.ts`:

```typescript
/** Attached to the request by JwtAuthGuard once a bearer token checks out. */
export interface AuthenticatedIdentity {
  authIdentityId: number;
  accountHolderId: number;
  subject: string;
  username: string;
  displayName: string;
  holderStatus: string;
}

/** Claims of a mimicked Keycloak access token. */
export interface AccessTokenClaims {
  iss: string;
  sub: string;
  preferred_username: string;
  email: string;
  realm_access: { roles: string[] };
}
```

- [ ] **Step 7: Write the DTOs**

Create `src/auth/dto/dev-token-request.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class DevTokenRequestDto {
  @ApiProperty({
    description: 'Username of a seeded identity.',
    example: 'adelaida.magtalas',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  username: string;
}
```

Create `src/auth/dto/dev-token-response.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';

export class DevTokenResponseDto {
  @ApiProperty({ description: 'Send as `Authorization: Bearer <token>`.' })
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ description: 'Lifetime in seconds.', example: 3600 })
  expiresIn: number;

  @ApiProperty({
    description: 'The Keycloak `sub` claim this token carries.',
    example: 'seed-adelaida-magtalas',
  })
  subject: string;
}
```

- [ ] **Step 8: Write the failing service test**

Create `src/auth/dev-token.service.spec.ts`:

```typescript
import { JwtService } from '@nestjs/jwt';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuthIdentity } from '../holders/entities/auth-identity.entity';
import { DevTokenService } from './dev-token.service';

describe('DevTokenService', () => {
  let service: DevTokenService;
  let repository: { findOne: jest.Mock };

  const identity = {
    id: 1,
    subject: 'seed-adelaida-magtalas',
    username: 'adelaida.magtalas',
    email: 'adelaida.magtalas@example.com',
  } as AuthIdentity;

  beforeEach(() => {
    repository = { findOne: jest.fn().mockResolvedValue(identity) };
    service = new DevTokenService(
      repository as unknown as Repository<AuthIdentity>,
      new JwtService(),
    );
  });

  it('mints a Keycloak-shaped token for a seeded identity', async () => {
    const result = await service.mint('adelaida.magtalas');

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 3600,
      subject: 'seed-adelaida-magtalas',
    });

    const claims = JSON.parse(
      Buffer.from(result.accessToken.split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({
      sub: 'seed-adelaida-magtalas',
      preferred_username: 'adelaida.magtalas',
      realm_access: { roles: ['user'] },
    });
    expect(claims.iss).toContain('realms');
  });

  it('mints for a suspended holder too — the guard is what rejects them', async () => {
    // Deliberate: the sender-suspended scenario needs a token it can present.
    await expect(service.mint('bobbie.salazar')).resolves.toBeDefined();
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { username: 'bobbie.salazar' },
    });
  });

  it('404s for an unknown username', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(service.mint('nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
```

- [ ] **Step 9: Run it to confirm it fails**

Run: `npx jest src/auth/dev-token.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 10: Write the service**

Create `src/auth/dev-token.service.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthIdentity } from '../holders/entities/auth-identity.entity';
import { DevTokenResponseDto } from './dto/dev-token-response.dto';
import { jwtConfig } from './jwt.config';

/**
 * Stands in for a Keycloak token endpoint so the flow can be driven without
 * running an identity provider. Registered only outside production — see
 * AuthModule.
 */
@Injectable()
export class DevTokenService {
  constructor(
    @InjectRepository(AuthIdentity)
    private readonly identities: Repository<AuthIdentity>,
    private readonly jwt: JwtService,
  ) {}

  async mint(username: string): Promise<DevTokenResponseDto> {
    const identity = await this.identities.findOne({ where: { username } });

    if (!identity) {
      throw new NotFoundException({
        code: 'IDENTITY_NOT_FOUND',
        message: `No identity with username "${username}".`,
      });
    }

    // Holder status is deliberately not checked here. Minting a token for a
    // suspended holder is how the suspended-sender path is exercised; the
    // guard is what rejects it, which is also where a real IdP-issued token
    // for a since-suspended user would be caught.
    const config = jwtConfig();

    const accessToken = await this.jwt.signAsync(
      {
        preferred_username: identity.username,
        email: identity.email,
        realm_access: { roles: ['user'] },
      },
      {
        secret: config.accessSecret,
        subject: identity.subject,
        issuer: config.issuer,
        expiresIn: config.accessTtlSeconds,
      },
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: config.accessTtlSeconds,
      subject: identity.subject,
    };
  }
}
```

- [ ] **Step 11: Run the service test**

Run: `npx jest src/auth/dev-token.service.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 12: Write the controller**

Create `src/auth/dev-token.controller.ts`:

```typescript
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { Public } from './decorators/public.decorator';
import { DevTokenRequestDto } from './dto/dev-token-request.dto';
import { DevTokenResponseDto } from './dto/dev-token-response.dto';
import { DevTokenService } from './dev-token.service';

@ApiTags('Dev')
@Controller({ path: 'dev', version: '1' })
export class DevTokenController {
  constructor(private readonly devTokenService: DevTokenService) {}

  @Post('token')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Access token issued.')
  @ApiOperation({
    summary: 'Mint an access token for a seeded identity (non-production only)',
    description:
      'Stands in for a Keycloak token endpoint. Returns a token whose claims mimic Keycloak, for use as `Authorization: Bearer <token>` on every other endpoint.\n\n' +
      'Seeded usernames: `adelaida.magtalas`, `ethan.delrosario`, `joy.fabregas`, `abigail.lim`, `arturo.montenegro`, `miggy.montenegro`, `richard.lim`, `bobbie.salazar` (suspended).\n\n' +
      'A token is issued for a suspended holder too — the guard rejects it on use, which is how the suspended-sender case is exercised.',
  })
  @ApiOkResponse({ type: DevTokenResponseDto })
  @ApiNotFoundResponse({ description: 'No identity with that username.' })
  mint(@Body() dto: DevTokenRequestDto): Promise<DevTokenResponseDto> {
    return this.devTokenService.mint(dto.username);
  }
}
```

- [ ] **Step 13: Write the decorators**

Create `src/auth/decorators/public.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public';

/** Opts a route out of the global JwtAuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Create `src/auth/decorators/current-identity.decorator.ts`:

```typescript
import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AuthenticatedIdentity } from '../identity.types';

/**
 * The identity JwtAuthGuard attached. Handlers read this rather than
 * request.user, so a signature documents what the handler needs.
 */
export const CurrentIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedIdentity =>
    context.switchToHttp().getRequest().identity,
);
```

- [ ] **Step 14: Write the module**

Create `src/auth/auth.module.ts`:

```typescript
import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthIdentity } from '../holders/entities/auth-identity.entity';
import { DevTokenController } from './dev-token.controller';
import { DevTokenService } from './dev-token.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { isProduction } from './jwt.config';

// Registered only outside production. The route does not exist in a
// production build rather than existing behind a flag that could be flipped.
const devControllers = isProduction() ? [] : [DevTokenController];
const devProviders = isProduction() ? [] : [DevTokenService];

if (!isProduction()) {
  new Logger('AuthModule').warn(
    'POST /v1/dev/token is ENABLED and mints access tokens for any seeded identity without a password. Never run this configuration in production.',
  );
}

@Module({
  imports: [TypeOrmModule.forFeature([AuthIdentity]), JwtModule.register({})],
  controllers: [...devControllers],
  providers: [
    ...devProviders,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
```

- [ ] **Step 15: Register in app.module.ts**

In `src/app.module.ts`, import `AuthModule` and add it to `imports` before `HealthModule`.

- [ ] **Step 16: Add the startup banner**

In `src/main.ts`, before `await app.listen(...)`:

```typescript
  if (process.env.NODE_ENV !== 'production') {
    Logger.warn(
      `NODE_ENV=${process.env.NODE_ENV ?? 'unset'} — POST /v1/dev/token is ENABLED and mints access tokens for any seeded identity without a password. Never run this configuration in production.`,
      'Bootstrap',
    );
  }
```

Import `Logger` from `@nestjs/common`.

- [ ] **Step 17: Document the env vars**

Append to `.env.example`:

```
# --- auth ---
# Access tokens authorise a session; resolution tokens authorise one specific
# movement of money. They MUST use different secrets.
JWT_ACCESS_SECRET=dev-only-access-secret-change-me
JWT_RESOLUTION_SECRET=dev-only-resolution-secret-change-me
JWT_ACCESS_TTL_SECONDS=3600
JWT_RESOLUTION_TTL_SECONDS=120
JWT_ISSUER=http://localhost:8080/realms/send-money
```

- [ ] **Step 18: Verify the endpoint (Task 5 completes the guard; this is a build check)**

Run: `npm run build && npx jest src/auth`
Expected: build succeeds, 7 tests pass. `JwtAuthGuard` is written in Task 5 — implement Task 5 before starting the app.

- [ ] **Step 19: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/auth src/app.module.ts src/main.ts .env.example package.json package-lock.json
git commit -m "feat(auth): mimicked Keycloak dev token endpoint

POST /v1/dev/token mints a Keycloak-shaped access token for a seeded
identity. The module is omitted entirely outside non-production builds, so
the route does not exist in production rather than sitting behind a flag
that could be flipped on.

Access and resolution tokens use different secrets: sharing a key would
let one token type be presented where the other is expected."
```

---

### Task 5: JWT auth guard

**Files:**
- Create: `src/auth/jwt-auth.guard.ts`
- Test: `src/auth/jwt-auth.guard.spec.ts`

**Interfaces:**
- Consumes: Task 4's `jwtConfig()`, `AuthenticatedIdentity`, `IS_PUBLIC_KEY`.
- Produces: `JwtAuthGuard` — global, attaches `request.identity: AuthenticatedIdentity`, throws `401` (`MISSING_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `IDENTITY_NOT_FOUND`) or `403 IDENTITY_NOT_ACTIVE`.

- [ ] **Step 1: Write the failing test**

Create `src/auth/jwt-auth.guard.spec.ts`:

```typescript
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from './jwt-auth.guard';
import { jwtConfig } from './jwt.config';

function contextFor(headers: Record<string, string>, request: Record<string, unknown> = {}) {
  const req = { headers, ...request };
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => req }),
    __req: req,
  } as unknown as ExecutionContext & { __req: Record<string, unknown> };
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwt: JwtService;
  let dataSource: { query: jest.Mock };

  const activeRow = {
    id: '1',
    account_holder_id: '1',
    subject: 'seed-adelaida-magtalas',
    username: 'adelaida.magtalas',
    display_name: 'Adelaida Magtalas',
    holder_status: 'active',
  };

  async function tokenFor(subject: string, overrides: Record<string, unknown> = {}) {
    const config = jwtConfig();
    return jwt.signAsync(
      { preferred_username: 'adelaida.magtalas', ...overrides },
      {
        secret: config.accessSecret,
        subject,
        issuer: config.issuer,
        expiresIn: config.accessTtlSeconds,
      },
    );
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jwt = new JwtService();
    dataSource = { query: jest.fn().mockResolvedValue([activeRow]) };
    guard = new JwtAuthGuard(
      new Reflector(),
      jwt,
      dataSource as unknown as DataSource,
    );
  });

  it('attaches the identity for a valid token', async () => {
    const token = await tokenFor('seed-adelaida-magtalas');
    const context = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect((context as never as { __req: { identity: unknown } }).__req.identity).toEqual({
      authIdentityId: 1,
      accountHolderId: 1,
      subject: 'seed-adelaida-magtalas',
      username: 'adelaida.magtalas',
      displayName: 'Adelaida Magtalas',
      holderStatus: 'active',
    });
  });

  it('rejects a request with no Authorization header', async () => {
    await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with the wrong key', async () => {
    const forged = await jwt.signAsync(
      { sub: 'seed-adelaida-magtalas' },
      { secret: 'not-the-access-secret', expiresIn: 60 },
    );

    await expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${forged}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired token with a distinct code', async () => {
    const config = jwtConfig();
    const expired = await jwt.signAsync(
      { preferred_username: 'x' },
      {
        secret: config.accessSecret,
        subject: 'seed-adelaida-magtalas',
        issuer: config.issuer,
        expiresIn: -10,
      },
    );

    await expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${expired}` })),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
    });
  });

  it('403s a suspended holder', async () => {
    dataSource.query.mockResolvedValue([
      { ...activeRow, holder_status: 'suspended' },
    ]);
    const token = await tokenFor('seed-bobbie-salazar');

    await expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('401s when the identity behind a valid token is gone', async () => {
    dataSource.query.mockResolvedValue([]);
    const token = await tokenFor('seed-deleted');

    await expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${token}` })),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IDENTITY_NOT_FOUND' }),
    });
  });

  it('lets a @Public() route through untouched', async () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    guard = new JwtAuthGuard(
      reflector,
      jwt,
      dataSource as unknown as DataSource,
    );

    await expect(guard.canActivate(contextFor({}))).resolves.toBe(true);
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/auth/jwt-auth.guard.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the guard**

Create `src/auth/jwt-auth.guard.ts`:

```typescript
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { AuthenticatedIdentity } from './identity.types';
import { jwtConfig } from './jwt.config';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = extractBearer(request.headers?.authorization);

    if (!token) {
      throw new UnauthorizedException({
        code: 'MISSING_TOKEN',
        message: 'Send an access token as `Authorization: Bearer <token>`.',
      });
    }

    const config = jwtConfig();
    let subject: string;

    try {
      const claims = await this.jwt.verifyAsync(token, {
        secret: config.accessSecret,
        issuer: config.issuer,
      });
      subject = claims.sub;
    } catch (error) {
      const expired =
        error instanceof Error && error.name === 'TokenExpiredError';

      throw new UnauthorizedException({
        code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: expired
          ? 'Access token has expired; request a new one.'
          : 'Access token is not valid.',
      });
    }

    // Resolved on every request rather than trusted from the token, so a token
    // stays usable only as long as the identity behind it does.
    const [row] = await this.dataSource.query(
      `SELECT ai.id, ai.account_holder_id, ai.subject, ai.username,
              h.display_name, h.status AS holder_status
         FROM auth_identities ai
         JOIN account_holders h ON h.id = ai.account_holder_id
        WHERE ai.subject = $1`,
      [subject],
    );

    if (!row) {
      throw new UnauthorizedException({
        code: 'IDENTITY_NOT_FOUND',
        message: 'The identity this token was issued for no longer exists.',
      });
    }

    if (row.holder_status !== 'active') {
      throw new ForbiddenException({
        code: 'IDENTITY_NOT_ACTIVE',
        message: `This account is ${row.holder_status} and cannot transact.`,
        status: row.holder_status,
      });
    }

    const identity: AuthenticatedIdentity = {
      authIdentityId: Number(row.id),
      accountHolderId: Number(row.account_holder_id),
      subject: row.subject,
      username: row.username,
      displayName: row.display_name,
      holderStatus: row.holder_status,
    };

    request.identity = identity;
    return true;
  }
}

function extractBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;

  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
```

- [ ] **Step 4: Run the guard test**

Run: `npx jest src/auth/jwt-auth.guard.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mark /health public**

In `src/health/health.controller.ts`, add `@Public()` to the `check()` handler and import it from `../auth/decorators/public.decorator`. The interceptor already skips `/health`, but the guard is separate and would otherwise demand a token from a liveness probe.

- [ ] **Step 6: Verify end to end against a running app**

```bash
docker compose up -d postgres && npm run start:dev
```

In another shell:

```bash
TOKEN=$(curl -s -X POST localhost:3000/v1/dev/token \
  -H 'content-type: application/json' \
  -d '{"username":"adelaida.magtalas"}' | jq -r .data.accessToken)

curl -s localhost:3000/v1/accounts/limits-probe -H "Authorization: Bearer $TOKEN" | jq
curl -s localhost:3000/health | jq
```

Expected: the dev-token call returns an envelope with `data.accessToken`; `/health` returns the bare Terminus shape with no token; an unauthenticated call to a guarded route returns `401` with `data.code = "MISSING_TOKEN"`.

Then confirm the suspended path:

```bash
BOBBIE=$(curl -s -X POST localhost:3000/v1/dev/token \
  -H 'content-type: application/json' \
  -d '{"username":"bobbie.salazar"}' | jq -r .data.accessToken)

curl -s localhost:3000/v1/transfers/00000000-0000-0000-0000-000000000000 \
  -H "Authorization: Bearer $BOBBIE" | jq
```

Expected: `403`, `data.code = "IDENTITY_NOT_ACTIVE"`, `data.status = "suspended"`.

- [ ] **Step 7: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/auth src/health
git commit -m "feat(auth): global bearer guard with active-holder check

The identity is resolved from the database on every request rather than
trusted from the token, so a token stays usable only as long as the
identity behind it does. A suspended holder gets 403 IDENTITY_NOT_ACTIVE.

/health is @Public(): the interceptor already skips it, but the guard is
separate and would otherwise demand a token from a liveness probe."
```

---

### Task 6: Resolution token service

**Files:**
- Create: `src/send-money/resolution-token.service.ts`
- Test: `src/send-money/resolution-token.service.spec.ts`

**Interfaces:**
- Consumes: Task 4's `jwtConfig()`.
- Produces:
  - `interface ResolutionClaims { typ: 'send_money_resolution'; aid: number; src: number; dst: number; amt: number; note: string | null; jti: string }`
  - `ResolutionTokenService.sign(claims: Omit<ResolutionClaims, 'typ' | 'jti'>): Promise<{ token: string; expiresAt: Date }>`
  - `ResolutionTokenService.verify(token: string, authIdentityId: number): Promise<ResolutionClaims>` — throws `403` with code `RESOLUTION_TOKEN_EXPIRED`, `RESOLUTION_TOKEN_INVALID`, or `RESOLUTION_TOKEN_IDENTITY_MISMATCH`.

- [ ] **Step 1: Write the failing test**

Create `src/send-money/resolution-token.service.spec.ts`:

```typescript
import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { jwtConfig } from '../auth/jwt.config';
import { ResolutionTokenService } from './resolution-token.service';

describe('ResolutionTokenService', () => {
  let service: ResolutionTokenService;
  let jwt: JwtService;

  const claims = { aid: 1, src: 1, dst: 2, amt: 150_000, note: 'Lunch' };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jwt = new JwtService();
    service = new ResolutionTokenService(jwt);
  });

  it('round-trips the claims, note included', async () => {
    const { token } = await service.sign(claims);

    await expect(service.verify(token, 1)).resolves.toMatchObject({
      typ: 'send_money_resolution',
      aid: 1,
      src: 1,
      dst: 2,
      amt: 150_000,
      note: 'Lunch',
    });
  });

  it('reports expiry with a code the client can act on', async () => {
    process.env.JWT_RESOLUTION_TTL_SECONDS = '1';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T00:00:00Z'));

    const { token } = await service.sign(claims);

    jest.setSystemTime(new Date('2026-08-27T00:05:00Z'));

    await expect(service.verify(token, 1)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'RESOLUTION_TOKEN_EXPIRED',
      }),
    });

    jest.useRealTimers();
    delete process.env.JWT_RESOLUTION_TTL_SECONDS;
  });

  it('rejects a token signed with the access secret', async () => {
    // The two secrets are separate precisely so this fails.
    const config = jwtConfig();
    const wrongKey = await jwt.signAsync(
      { typ: 'send_money_resolution', ...claims, jti: 'x' },
      { secret: config.accessSecret, expiresIn: 120 },
    );

    await expect(service.verify(wrongKey, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects a token whose typ is not a resolution token', async () => {
    const config = jwtConfig();
    const wrongType = await jwt.signAsync(
      { typ: 'something_else', ...claims, jti: 'x' },
      { secret: config.resolutionSecret, expiresIn: 120 },
    );

    await expect(service.verify(wrongType, 1)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'RESOLUTION_TOKEN_INVALID' }),
    });
  });

  it('refuses a token spent by a different identity', async () => {
    const { token } = await service.sign(claims);

    await expect(service.verify(token, 99)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'RESOLUTION_TOKEN_IDENTITY_MISMATCH',
      }),
    });
  });

  it('gives every token a distinct jti', async () => {
    const a = await service.sign(claims);
    const b = await service.sign(claims);

    const [first, second] = await Promise.all([
      service.verify(a.token, 1),
      service.verify(b.token, 1),
    ]);

    expect(first.jti).not.toEqual(second.jti);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/send-money/resolution-token.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Create `src/send-money/resolution-token.service.ts`:

```typescript
import { ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { jwtConfig } from '../auth/jwt.config';

export const RESOLUTION_TOKEN_TYPE = 'send_money_resolution';

/**
 * What phase one tells phase two.
 *
 * src and dst are internal sequential account ids. They are safe here — and
 * only here — because the token is signed by the server, opaque to the client
 * and lives two minutes. They never appear in a request or a response body.
 */
export interface ResolutionClaims {
  typ: typeof RESOLUTION_TOKEN_TYPE;
  /** auth_identities.id of the sender this token was issued to. */
  aid: number;
  src: number;
  dst: number;
  amt: number;
  note: string | null;
  jti: string;
}

export type ResolutionInput = Omit<ResolutionClaims, 'typ' | 'jti'>;

/**
 * The token is a hint, not an authorisation. Phase two re-runs every rule
 * inside the write transaction; this only saves a resolution round-trip and
 * carries the note. That is why no quote table is needed — the idempotency key
 * is the replay guard and the rules are the authority.
 */
@Injectable()
export class ResolutionTokenService {
  constructor(private readonly jwt: JwtService) {}

  async sign(
    input: ResolutionInput,
  ): Promise<{ token: string; expiresAt: Date }> {
    const config = jwtConfig();

    const token = await this.jwt.signAsync(
      { typ: RESOLUTION_TOKEN_TYPE, ...input, jti: randomUUID() },
      {
        secret: config.resolutionSecret,
        expiresIn: config.resolutionTtlSeconds,
      },
    );

    return {
      token,
      expiresAt: new Date(Date.now() + config.resolutionTtlSeconds * 1000),
    };
  }

  async verify(
    token: string,
    authIdentityId: number,
  ): Promise<ResolutionClaims> {
    const config = jwtConfig();
    let claims: ResolutionClaims;

    try {
      claims = await this.jwt.verifyAsync<ResolutionClaims>(token, {
        secret: config.resolutionSecret,
      });
    } catch (error) {
      const expired =
        error instanceof Error && error.name === 'TokenExpiredError';

      // A distinct code, so the client knows to re-resolve rather than
      // surfacing this as a generic failure the user cannot act on.
      throw new ForbiddenException({
        code: expired
          ? 'RESOLUTION_TOKEN_EXPIRED'
          : 'RESOLUTION_TOKEN_INVALID',
        message: expired
          ? 'This confirmation has expired. Please confirm the transfer again.'
          : 'Resolution token is not valid.',
      });
    }

    if (claims.typ !== RESOLUTION_TOKEN_TYPE) {
      throw new ForbiddenException({
        code: 'RESOLUTION_TOKEN_INVALID',
        message: 'Resolution token is not valid.',
      });
    }

    // Binds the token to the identity that asked for it: whoever intercepts a
    // token cannot spend it.
    if (claims.aid !== authIdentityId) {
      throw new ForbiddenException({
        code: 'RESOLUTION_TOKEN_IDENTITY_MISMATCH',
        message: 'This confirmation was issued to a different account.',
      });
    }

    return claims;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/send-money/resolution-token.service.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/send-money
git commit -m "feat(send-money): short-lived resolution token

Carries the sender identity, both internal account ids, the amount and the
note for 120 seconds. Internal ids are safe inside it because it is signed,
opaque and short-lived; they never appear in a request or response body.

The token is a hint, not an authorisation — phase two re-runs every rule —
so expiry gets its own code telling the client to re-resolve, and aid binds
the token to the identity that requested it."
```

---

### Task 7: Recipient and sender account resolution

**Files:**
- Create: `src/send-money/recipient-resolver.service.ts`
- Test: `src/send-money/recipient-resolver.service.spec.ts`

**Interfaces:**
- Consumes: Task 1's `SendMoneyErrorCode`.
- Produces:
  - `type RecipientLookupType = 'username' | 'mobileNumber'`
  - `interface ResolvedParty { accountId: number; accountHolderId: number; displayName: string; balanceMinor: number; accountStatus: string; holderStatus: string }`
  - `type ResolutionOutcome = { ok: true; party: ResolvedParty } | { ok: false; code: SendMoneyErrorCode; details?: Record<string, unknown> }`
  - `resolveByLookup(type, value, manager): Promise<ResolutionOutcome>`
  - `resolveByHolder(accountHolderId, manager, side: 'sender' | 'recipient'): Promise<ResolutionOutcome>`

Returns an outcome object rather than throwing. The rules engine needs to *collect* failures, and an exception would end the pass at the first one.

- [ ] **Step 1: Write the failing test**

Create `src/send-money/recipient-resolver.service.spec.ts`:

```typescript
import { EntityManager } from 'typeorm';
import { SendMoneyErrorCode } from '../common/errors/send-money-error';
import { RecipientResolverService } from './recipient-resolver.service';

describe('RecipientResolverService', () => {
  let service: RecipientResolverService;
  let manager: { query: jest.Mock };

  const account = (over: Record<string, unknown> = {}) => ({
    account_id: '2',
    account_holder_id: '2',
    display_name: 'Ethan Del Rosario',
    balance_minor: '6250005',
    account_status: 'active',
    holder_status: 'active',
    ...over,
  });

  beforeEach(() => {
    manager = { query: jest.fn() };
    service = new RecipientResolverService();
  });

  it('resolves a username to its holder single active account', async () => {
    manager.query.mockResolvedValue([account()]);

    const outcome = await service.resolveByLookup(
      'username',
      'ethan.delrosario',
      manager as unknown as EntityManager,
    );

    expect(outcome).toEqual({
      ok: true,
      party: {
        accountId: 2,
        accountHolderId: 2,
        displayName: 'Ethan Del Rosario',
        balanceMinor: 6_250_005,
        accountStatus: 'active',
        holderStatus: 'active',
      },
    });
    expect(manager.query.mock.calls[0][0]).toContain('ai.username = $1');
  });

  it('looks up by mobile number when asked', async () => {
    manager.query.mockResolvedValue([account()]);

    await service.resolveByLookup(
      'mobileNumber',
      '09170000102',
      manager as unknown as EntityManager,
    );

    expect(manager.query.mock.calls[0][0]).toContain('ai.mobile_number = $1');
  });

  it('resolves a corporate signatory to the company account', async () => {
    // auth_identities.account_holder_id is already the corporate holder — the
    // composite FK forces it — so no signatory special case is needed.
    manager.query.mockResolvedValue([
      account({
        account_id: '5',
        account_holder_id: '5',
        display_name: 'Montenegro Industries',
      }),
    ]);

    const outcome = await service.resolveByLookup(
      'username',
      'arturo.montenegro',
      manager as unknown as EntityManager,
    );

    expect(outcome).toMatchObject({
      ok: true,
      party: { accountId: 5, displayName: 'Montenegro Industries' },
    });
  });

  it('reports RECIPIENT_NOT_FOUND for an unknown identity', async () => {
    manager.query.mockResolvedValue([]);

    const outcome = await service.resolveByLookup(
      'username',
      'nobody',
      manager as unknown as EntityManager,
    );

    expect(outcome).toEqual({
      ok: false,
      code: SendMoneyErrorCode.RecipientNotFound,
    });
  });

  it('reports RECIPIENT_NOT_ACTIVE when the account is suspended', async () => {
    manager.query.mockResolvedValue([
      account({ account_status: 'suspended', holder_status: 'suspended' }),
    ]);

    const outcome = await service.resolveByLookup(
      'username',
      'bobbie.salazar',
      manager as unknown as EntityManager,
    );

    expect(outcome).toMatchObject({
      ok: false,
      code: SendMoneyErrorCode.RecipientNotActive,
      details: { status: 'suspended' },
    });
  });

  it('refuses to guess between two active accounts', async () => {
    manager.query.mockResolvedValue([account(), account({ account_id: '3' })]);

    const outcome = await service.resolveByLookup(
      'username',
      'multi.account',
      manager as unknown as EntityManager,
    );

    expect(outcome).toMatchObject({
      ok: false,
      code: SendMoneyErrorCode.RecipientAmbiguousAccount,
      details: { accountCount: 2 },
    });
  });

  it('uses SENDER_ codes when resolving the sender side', async () => {
    manager.query.mockResolvedValue([]);

    const outcome = await service.resolveByHolder(
      1,
      manager as unknown as EntityManager,
      'sender',
    );

    expect(outcome).toMatchObject({
      ok: false,
      code: SendMoneyErrorCode.SenderNoActiveAccount,
    });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/send-money/recipient-resolver.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the resolver**

Create `src/send-money/recipient-resolver.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SendMoneyErrorCode } from '../common/errors/send-money-error';

export type RecipientLookupType = 'username' | 'mobileNumber';

export interface ResolvedParty {
  accountId: number;
  accountHolderId: number;
  displayName: string;
  balanceMinor: number;
  accountStatus: string;
  holderStatus: string;
}

export type ResolutionOutcome =
  | { ok: true; party: ResolvedParty }
  | {
      ok: false;
      code: SendMoneyErrorCode;
      details?: Record<string, unknown>;
    };

type Side = 'sender' | 'recipient';

/** Which error code family a failure belongs to, by side. */
const CODES = {
  sender: {
    notFound: SendMoneyErrorCode.SenderNoActiveAccount,
    notActive: SendMoneyErrorCode.SenderNoActiveAccount,
    none: SendMoneyErrorCode.SenderNoActiveAccount,
    ambiguous: SendMoneyErrorCode.SenderAmbiguousAccount,
  },
  recipient: {
    notFound: SendMoneyErrorCode.RecipientNotFound,
    notActive: SendMoneyErrorCode.RecipientNotActive,
    none: SendMoneyErrorCode.RecipientNoActiveAccount,
    ambiguous: SendMoneyErrorCode.RecipientAmbiguousAccount,
  },
} as const;

interface PartyRow {
  account_id: string;
  account_holder_id: string;
  display_name: string;
  balance_minor: string;
  account_status: string;
  holder_status: string;
}

@Injectable()
export class RecipientResolverService {
  /**
   * username or mobile number → the holder's single active account.
   *
   * A corporate signatory needs no special case: auth_identities carries the
   * corporate account_holder_id directly, and auth_identities_signatory_holder_fk
   * forces the signatory to belong to that same holder.
   */
  async resolveByLookup(
    type: RecipientLookupType,
    value: string,
    manager: EntityManager,
  ): Promise<ResolutionOutcome> {
    const column = type === 'username' ? 'ai.username' : 'ai.mobile_number';

    const rows: PartyRow[] = await manager.query(
      `SELECT a.id            AS account_id,
              h.id            AS account_holder_id,
              h.display_name  AS display_name,
              a.balance_minor AS balance_minor,
              a.status        AS account_status,
              h.status        AS holder_status
         FROM auth_identities ai
         JOIN account_holders h ON h.id = ai.account_holder_id
         LEFT JOIN accounts a   ON a.account_holder_id = h.id
        WHERE ${column} = $1`,
      [value],
    );

    if (rows.length === 0) {
      return { ok: false, code: CODES.recipient.notFound };
    }

    return this.pickActive(rows, 'recipient');
  }

  /** The same rule from a holder id, for the sender side. */
  async resolveByHolder(
    accountHolderId: number,
    manager: EntityManager,
    side: Side,
  ): Promise<ResolutionOutcome> {
    const rows: PartyRow[] = await manager.query(
      `SELECT a.id            AS account_id,
              h.id            AS account_holder_id,
              h.display_name  AS display_name,
              a.balance_minor AS balance_minor,
              a.status        AS account_status,
              h.status        AS holder_status
         FROM account_holders h
         LEFT JOIN accounts a ON a.account_holder_id = h.id
        WHERE h.id = $1`,
      [accountHolderId],
    );

    if (rows.length === 0) {
      return { ok: false, code: CODES[side].notFound };
    }

    return this.pickActive(rows, side);
  }

  private pickActive(rows: PartyRow[], side: Side): ResolutionOutcome {
    // A LEFT JOIN yields one row with a NULL account when the holder has none.
    const accounts = rows.filter((row) => row.account_id !== null);

    if (accounts.length === 0) {
      return { ok: false, code: CODES[side].none };
    }

    const active = accounts.filter((row) => row.account_status === 'active');

    if (active.length === 0) {
      // Report the status rather than a bare "no active account": a suspended
      // recipient is a different problem from one who never opened an account.
      const [first] = accounts;
      const status =
        first.holder_status !== 'active'
          ? first.holder_status
          : first.account_status;

      return {
        ok: false,
        code: CODES[side].notActive,
        details: { status },
      };
    }

    if (active.length > 1) {
      // Deliberately not "pick the oldest". A wallet that guesses which of your
      // accounts to use is one that will eventually guess wrong, and the sender
      // has no way to tell which it chose.
      return {
        ok: false,
        code: CODES[side].ambiguous,
        details: { accountCount: active.length },
      };
    }

    const [row] = active;

    // The holder can be non-active while an account still reads 'active'.
    if (row.holder_status !== 'active') {
      return {
        ok: false,
        code: CODES[side].notActive,
        details: { status: row.holder_status },
      };
    }

    return {
      ok: true,
      party: {
        accountId: Number(row.account_id),
        accountHolderId: Number(row.account_holder_id),
        displayName: row.display_name,
        balanceMinor: Number(row.balance_minor),
        accountStatus: row.account_status,
        holderStatus: row.holder_status,
      },
    };
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/send-money/recipient-resolver.service.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/send-money
git commit -m "feat(send-money): resolve a party to its single active account

Returns an outcome object rather than throwing, so the rules engine can
collect several failures in one pass.

Corporate signatories need no special case: auth_identities already carries
the corporate holder id, and the composite FK guarantees it matches.

Multiple active accounts is an explicit error, not a silent pick — guessing
would eventually pick wrong with no way for the sender to tell."
```

---

### Task 8: The accumulating rules engine

**Files:**
- Create: `src/send-money/send-money-rules.service.ts`
- Test: `src/send-money/send-money-rules.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 7.
- Produces:
  - `interface RuleInput { senderHolderId: number; recipientType: RecipientLookupType; recipientValue: string; amountMinor: number }`
  - `interface RuleResult { errors: SendMoneyError[]; sender?: ResolvedParty; recipient?: ResolvedParty }`
  - `evaluate(input: RuleInput, manager: EntityManager): Promise<RuleResult>`
  - `evaluateResolved(sender, recipient, amountMinor, manager): Promise<SendMoneyError[]>` — the phase-two re-check, given already-locked parties.

- [ ] **Step 1: Write the failing test**

Create `src/send-money/send-money-rules.service.spec.ts`:

```typescript
import { EntityManager } from 'typeorm';
import { AccountLimitsService } from '../accounts/account-limits.service';
import { SendMoneyErrorCode } from '../common/errors/send-money-error';
import { RecipientResolverService, ResolvedParty } from './recipient-resolver.service';
import { SendMoneyRulesService } from './send-money-rules.service';

const party = (over: Partial<ResolvedParty> = {}): ResolvedParty => ({
  accountId: 1,
  accountHolderId: 1,
  displayName: 'Adelaida Magtalas',
  balanceMinor: 8_500_075,
  accountStatus: 'active',
  holderStatus: 'active',
  ...over,
});

describe('SendMoneyRulesService', () => {
  let service: SendMoneyRulesService;
  let resolver: { resolveByHolder: jest.Mock; resolveByLookup: jest.Mock };
  let limits: { getUsage: jest.Mock };
  let manager: { getRepository: jest.Mock };

  const LIMIT = { dailyLimitMinor: 5_000_000, monthlyLimitMinor: 50_000_000 };

  function codesFrom(result: { errors: { code: SendMoneyErrorCode }[] }) {
    return result.errors.map((error) => error.code);
  }

  beforeEach(() => {
    resolver = {
      resolveByHolder: jest.fn().mockResolvedValue({ ok: true, party: party() }),
      resolveByLookup: jest.fn().mockResolvedValue({
        ok: true,
        party: party({ accountId: 2, accountHolderId: 2, displayName: 'Ethan Del Rosario' }),
      }),
    };
    limits = {
      getUsage: jest
        .fn()
        .mockResolvedValue({ dailyUsedMinor: 0, monthlyUsedMinor: 0 }),
    };
    manager = {
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(LIMIT),
      }),
    };

    service = new SendMoneyRulesService(
      resolver as unknown as RecipientResolverService,
      limits as unknown as AccountLimitsService,
    );
  });

  const input = {
    senderHolderId: 1,
    recipientType: 'username' as const,
    recipientValue: 'ethan.delrosario',
    amountMinor: 150_000,
  };

  it('passes a clean request with no errors', async () => {
    const result = await service.evaluate(input, manager as unknown as EntityManager);

    expect(result.errors).toEqual([]);
    expect(result.sender?.accountId).toBe(1);
    expect(result.recipient?.accountId).toBe(2);
  });

  it('reports insufficient funds with the numbers behind it', async () => {
    resolver.resolveByHolder.mockResolvedValue({
      ok: true,
      party: party({ balanceMinor: 100 }),
    });

    const result = await service.evaluate(input, manager as unknown as EntityManager);

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: SendMoneyErrorCode.InsufficientFunds,
        details: { balanceMinor: 100, requestedMinor: 150_000 },
      }),
    );
  });

  it('allows an amount landing exactly on the daily limit', async () => {
    limits.getUsage.mockResolvedValue({
      dailyUsedMinor: LIMIT.dailyLimitMinor - 150_000,
      monthlyUsedMinor: 0,
    });

    const result = await service.evaluate(input, manager as unknown as EntityManager);

    expect(codesFrom(result)).not.toContain(
      SendMoneyErrorCode.SenderDailyLimitExceeded,
    );
  });

  it('rejects one centavo over the daily limit', async () => {
    limits.getUsage.mockResolvedValue({
      dailyUsedMinor: LIMIT.dailyLimitMinor - 150_000 + 1,
      monthlyUsedMinor: 0,
    });

    const result = await service.evaluate(input, manager as unknown as EntityManager);

    expect(codesFrom(result)).toContain(
      SendMoneyErrorCode.SenderDailyLimitExceeded,
    );
  });

  it('measures the sender outbound and the recipient inbound', async () => {
    await service.evaluate(input, manager as unknown as EntityManager);

    const directions = limits.getUsage.mock.calls.map(([, , direction]) => direction);
    expect(directions).toEqual(expect.arrayContaining(['debit', 'credit']));
  });

  it('reports the recipient limit separately from the sender one', async () => {
    limits.getUsage.mockImplementation(
      async (_holder: number, _manager: unknown, direction: string) =>
        direction === 'credit'
          ? { dailyUsedMinor: LIMIT.dailyLimitMinor, monthlyUsedMinor: 0 }
          : { dailyUsedMinor: 0, monthlyUsedMinor: 0 },
    );

    const result = await service.evaluate(input, manager as unknown as EntityManager);

    expect(codesFrom(result)).toContain(
      SendMoneyErrorCode.RecipientDailyLimitExceeded,
    );
    expect(codesFrom(result)).not.toContain(
      SendMoneyErrorCode.SenderDailyLimitExceeded,
    );
  });

  it('accumulates independent failures instead of stopping at the first', async () => {
    resolver.resolveByHolder.mockResolvedValue({
      ok: true,
      party: party({ balanceMinor: 1 }),
    });
    resolver.resolveByLookup.mockResolvedValue({
      ok: false,
      code: SendMoneyErrorCode.RecipientNotActive,
      details: { status: 'suspended' },
    });

    const result = await service.evaluate(input, manager as unknown as EntityManager);

    expect(codesFrom(result)).toEqual(
      expect.arrayContaining([
        SendMoneyErrorCode.InsufficientFunds,
        SendMoneyErrorCode.RecipientNotActive,
      ]),
    );
  });

  it('skips recipient limit checks when the recipient did not resolve', async () => {
    resolver.resolveByLookup.mockResolvedValue({
      ok: false,
      code: SendMoneyErrorCode.RecipientNotFound,
    });

    const result = await service.evaluate(input, manager as unknown as EntityManager);

    expect(codesFrom(result)).toEqual([SendMoneyErrorCode.RecipientNotFound]);
  });

  it('rejects sending to yourself', async () => {
    resolver.resolveByLookup.mockResolvedValue({
      ok: true,
      party: party({ accountId: 1, accountHolderId: 1 }),
    });

    const result = await service.evaluate(input, manager as unknown as EntityManager);

    expect(codesFrom(result)).toContain(
      SendMoneyErrorCode.SelfTransferNotAllowed,
    );
  });

  it('treats a holder with no configured limit as unlimited', async () => {
    manager.getRepository.mockReturnValue({
      findOne: jest.fn().mockResolvedValue(null),
    });

    const result = await service.evaluate(
      { ...input, amountMinor: 999_999_999 },
      manager as unknown as EntityManager,
    );

    // Only the balance rule fires; no limit codes.
    expect(codesFrom(result)).toEqual([SendMoneyErrorCode.InsufficientFunds]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/send-money/send-money-rules.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the rules engine**

Create `src/send-money/send-money-rules.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  AccountLimitsService,
  LimitDirection,
} from '../accounts/account-limits.service';
import { AccountLimit } from '../accounts/entities/account-limit.entity';
import { minorToPesos } from '../common/money';
import {
  SendMoneyError,
  SendMoneyErrorCode,
} from '../common/errors/send-money-error';
import {
  RecipientLookupType,
  RecipientResolverService,
  ResolvedParty,
} from './recipient-resolver.service';

export interface RuleInput {
  senderHolderId: number;
  recipientType: RecipientLookupType;
  recipientValue: string;
  amountMinor: number;
}

export interface RuleResult {
  errors: SendMoneyError[];
  sender?: ResolvedParty;
  recipient?: ResolvedParty;
}

/** Human-readable text per code. Kept beside the codes so they cannot drift. */
const MESSAGES: Record<SendMoneyErrorCode, string> = {
  [SendMoneyErrorCode.SenderNoActiveAccount]:
    'You have no active account to send from.',
  [SendMoneyErrorCode.SenderAmbiguousAccount]:
    'You have more than one active account; the funding account is ambiguous.',
  [SendMoneyErrorCode.InsufficientFunds]: 'Insufficient funds.',
  [SendMoneyErrorCode.SenderDailyLimitExceeded]:
    'This transfer would exceed your daily sending limit.',
  [SendMoneyErrorCode.SenderMonthlyLimitExceeded]:
    'This transfer would exceed your monthly sending limit.',
  [SendMoneyErrorCode.RecipientNotFound]: 'No account matches that recipient.',
  [SendMoneyErrorCode.RecipientNotActive]:
    'The recipient cannot receive funds at this time.',
  [SendMoneyErrorCode.RecipientNoActiveAccount]:
    'The recipient has no active account.',
  [SendMoneyErrorCode.RecipientAmbiguousAccount]:
    'The recipient has more than one active account.',
  [SendMoneyErrorCode.RecipientDailyLimitExceeded]:
    'This transfer would exceed the recipient daily receiving limit.',
  [SendMoneyErrorCode.RecipientMonthlyLimitExceeded]:
    'This transfer would exceed the recipient monthly receiving limit.',
  [SendMoneyErrorCode.SelfTransferNotAllowed]:
    'You cannot send money to your own account.',
};

function error(
  code: SendMoneyErrorCode,
  details?: Record<string, unknown>,
): SendMoneyError {
  return { code, message: MESSAGES[code], ...(details ? { details } : {}) };
}

/**
 * Evaluates every send-money rule and collects the failures.
 *
 * Accumulating rather than throwing is the whole point of phase one: the
 * confirmation screen has to show every reason at once, so a client is not
 * made to re-submit to discover the next problem.
 */
@Injectable()
export class SendMoneyRulesService {
  constructor(
    private readonly resolver: RecipientResolverService,
    private readonly limits: AccountLimitsService,
  ) {}

  async evaluate(
    input: RuleInput,
    manager: EntityManager,
  ): Promise<RuleResult> {
    const errors: SendMoneyError[] = [];

    const senderOutcome = await this.resolver.resolveByHolder(
      input.senderHolderId,
      manager,
      'sender',
    );
    const recipientOutcome = await this.resolver.resolveByLookup(
      input.recipientType,
      input.recipientValue,
      manager,
    );

    if (!senderOutcome.ok) {
      errors.push(error(senderOutcome.code, senderOutcome.details));
    }
    if (!recipientOutcome.ok) {
      errors.push(error(recipientOutcome.code, recipientOutcome.details));
    }

    const sender = senderOutcome.ok ? senderOutcome.party : undefined;
    const recipient = recipientOutcome.ok ? recipientOutcome.party : undefined;

    // Rules downstream of a resolution that failed are skipped rather than
    // reported as further failures: "recipient not found" plus "recipient limit
    // exceeded" would be noise, not two problems.
    errors.push(
      ...(await this.checkResolved(
        sender,
        recipient,
        input.amountMinor,
        manager,
      )),
    );

    return { errors, sender, recipient };
  }

  /**
   * The phase-two re-check, against parties already locked in the write
   * transaction. Same rules, same codes; the token is up to 120 seconds stale
   * and balances move in between.
   */
  async evaluateResolved(
    sender: ResolvedParty,
    recipient: ResolvedParty,
    amountMinor: number,
    manager: EntityManager,
  ): Promise<SendMoneyError[]> {
    return this.checkResolved(sender, recipient, amountMinor, manager);
  }

  private async checkResolved(
    sender: ResolvedParty | undefined,
    recipient: ResolvedParty | undefined,
    amountMinor: number,
    manager: EntityManager,
  ): Promise<SendMoneyError[]> {
    const errors: SendMoneyError[] = [];

    if (sender) {
      if (sender.balanceMinor < amountMinor) {
        errors.push(
          error(SendMoneyErrorCode.InsufficientFunds, {
            balanceMinor: sender.balanceMinor,
            requestedMinor: amountMinor,
          }),
        );
      }

      errors.push(
        ...(await this.checkLimits(
          sender.accountHolderId,
          amountMinor,
          'debit',
          manager,
          SendMoneyErrorCode.SenderDailyLimitExceeded,
          SendMoneyErrorCode.SenderMonthlyLimitExceeded,
        )),
      );
    }

    if (recipient) {
      errors.push(
        ...(await this.checkLimits(
          recipient.accountHolderId,
          amountMinor,
          'credit',
          manager,
          SendMoneyErrorCode.RecipientDailyLimitExceeded,
          SendMoneyErrorCode.RecipientMonthlyLimitExceeded,
        )),
      );
    }

    if (sender && recipient && sender.accountId === recipient.accountId) {
      errors.push(error(SendMoneyErrorCode.SelfTransferNotAllowed));
    }

    return errors;
  }

  private async checkLimits(
    accountHolderId: number,
    amountMinor: number,
    direction: LimitDirection,
    manager: EntityManager,
    dailyCode: SendMoneyErrorCode,
    monthlyCode: SendMoneyErrorCode,
  ): Promise<SendMoneyError[]> {
    const limit = await manager
      .getRepository(AccountLimit)
      .findOne({ where: { accountHolderId } });

    // No configured limit means unlimited. Made explicit because the safer
    // reading — deny by default — would block every holder seeded without one.
    if (!limit) return [];

    const usage = await this.limits.getUsage(
      accountHolderId,
      manager,
      direction,
    );
    const errors: SendMoneyError[] = [];

    // Inclusive: landing exactly on the limit is allowed.
    if (usage.dailyUsedMinor + amountMinor > limit.dailyLimitMinor) {
      errors.push(
        error(dailyCode, {
          limitMinor: limit.dailyLimitMinor,
          limit: minorToPesos(limit.dailyLimitMinor),
          usedMinor: usage.dailyUsedMinor,
          requestedMinor: amountMinor,
        }),
      );
    }

    if (usage.monthlyUsedMinor + amountMinor > limit.monthlyLimitMinor) {
      errors.push(
        error(monthlyCode, {
          limitMinor: limit.monthlyLimitMinor,
          limit: minorToPesos(limit.monthlyLimitMinor),
          usedMinor: usage.monthlyUsedMinor,
          requestedMinor: amountMinor,
        }),
      );
    }

    return errors;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/send-money/send-money-rules.service.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/send-money
git commit -m "feat(send-money): accumulating rule engine

Collects every failed rule rather than throwing on the first, so a
confirmation screen can show them all at once instead of making the client
re-submit to discover the next problem.

Rules downstream of a failed resolution are skipped, not reported:
'recipient not found' plus 'recipient limit exceeded' is noise, not two
problems. Limits are inclusive — landing exactly on the limit passes."
```

---

### Task 9: Phase one — POST /v1/send-money/resolve

**Files:**
- Create: `src/send-money/dto/resolve-transfer.dto.ts`
- Create: `src/send-money/dto/resolution-response.dto.ts`
- Create: `src/send-money/send-money.controller.ts`
- Create: `src/send-money/send-money.module.ts`
- Modify: `src/app.module.ts`
- Test: `src/send-money/dto/resolve-transfer.dto.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 6, 8.
- Produces:
  - `RecipientRefDto { type: RecipientLookupType; value: string }`
  - `ResolveTransferDto` with `recipient`, `amount?`, `amountMinor?`, `note?`, and `resolvedAmountMinor(): number`
  - `ResolutionResponseDto.from(...)`
  - `SendMoneyModule`

- [ ] **Step 1: Write the failing DTO test**

Create `src/send-money/dto/resolve-transfer.dto.spec.ts`:

```typescript
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ResolveTransferDto } from './resolve-transfer.dto';

function validate(payload: unknown) {
  const dto = plainToInstance(ResolveTransferDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

const base = {
  recipient: { type: 'username', value: 'ethan.delrosario' },
  amount: '1500.00',
};

describe('ResolveTransferDto', () => {
  it('accepts a peso string and normalises it to centavos', () => {
    const { dto, errors } = validate(base);

    expect(errors).toHaveLength(0);
    expect(dto.resolvedAmountMinor()).toBe(150_000);
  });

  it('accepts centavos directly', () => {
    const { dto, errors } = validate({
      recipient: base.recipient,
      amountMinor: 150_000,
    });

    expect(errors).toHaveLength(0);
    expect(dto.resolvedAmountMinor()).toBe(150_000);
  });

  it('rejects a body with neither amount', () => {
    const { errors } = validate({ recipient: base.recipient });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects more than two decimal places rather than rounding', () => {
    const { errors } = validate({ ...base, amount: '10.005' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a mobile number that is not a PH mobile', () => {
    const { errors } = validate({
      ...base,
      recipient: { type: 'mobileNumber', value: '12345' },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid PH mobile', () => {
    const { errors } = validate({
      ...base,
      recipient: { type: 'mobileNumber', value: '09170000102' },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a note longer than 100 characters', () => {
    const { errors } = validate({ ...base, note: 'x'.repeat(101) });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown recipient type', () => {
    const { errors } = validate({
      ...base,
      recipient: { type: 'accountId', value: 'anything' },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/send-money/dto/resolve-transfer.dto.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the request DTO**

Create `src/send-money/dto/resolve-transfer.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ExactlyOneAmountConstraint } from '../../common/validators/exactly-one-amount.validator';
import { IsPesoAmount } from '../../common/validators/is-peso-amount.validator';
import type { RecipientLookupType } from '../recipient-resolver.service';

/**
 * How the sender named the recipient. The client already knows which kind of
 * value the user typed, so the discriminator is trusted and the value is
 * validated against it rather than sniffed.
 */
export class RecipientRefDto {
  @ApiProperty({ enum: ['username', 'mobileNumber'], example: 'username' })
  @IsIn(['username', 'mobileNumber'])
  type: RecipientLookupType;

  @ApiProperty({ example: 'ethan.delrosario' })
  @IsString()
  @MaxLength(255)
  // The format check applies only when type says this is a mobile number.
  // @ValidateIf rather than the `groups` option: class-validator runs a
  // grouped decorator only when that group is requested, and the global pipe
  // passes none — so a groups-based rule would silently never fire.
  @ValidateIf((ref: RecipientRefDto) => ref.type === 'mobileNumber')
  @Matches(/^09\d{9}$/, {
    message: 'A mobile number must be a PH mobile in the form 09XXXXXXXXX.',
  })
  value: string;
}

export class ResolveTransferDto {
  @ApiProperty({ type: RecipientRefDto })
  @ValidateNested()
  @Type(() => RecipientRefDto)
  // Hosts the amount pair check. It must sit on a required field: on an
  // @IsOptional() property class-validator skips every decorator when the
  // value is absent, so a body omitting both amounts would slip through.
  @Validate(ExactlyOneAmountConstraint)
  recipient: RecipientRefDto;

  /**
   * Pesos, preferably as a string. A JSON number is an IEEE-754 double, so any
   * arithmetic the client did before serializing can arrive already wrong.
   * After validation this holds an integer number of centavos.
   */
  @ApiPropertyOptional({
    description:
      'Amount in PHP with at most 2 decimal places. Prefer a string ("1500.00"). Mutually exclusive with amountMinor.',
    example: '1500.00',
    type: String,
    pattern: '^\\d+(\\.\\d{1,2})?$',
  })
  @IsOptional()
  @IsPesoAmount()
  amount?: number;

  @ApiPropertyOptional({
    description: 'Amount in PHP centavos (100 = PHP 1.00). Integer only.',
    example: 150_000,
    type: Number,
    minimum: 1,
  })
  @IsOptional()
  @IsInt({ message: 'amountMinor must be a whole number of centavos.' })
  @IsPositive({ message: 'amountMinor must be greater than zero.' })
  amountMinor?: number;

  @ApiPropertyOptional({
    description: 'Optional note shown on the transfer. Max 100 characters.',
    example: 'Lunch',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  note?: string;

  /**
   * A method rather than a getter: class-transformer would treat a getter as a
   * property and try to serialize it.
   */
  resolvedAmountMinor(): number {
    const resolved = this.amount ?? this.amountMinor;

    if (resolved === undefined || resolved === null) {
      throw new Error(
        'ResolveTransferDto has neither amount nor amountMinor; it was not validated.',
      );
    }

    return resolved;
  }
}
```

- [ ] **Step 4: Run the DTO test**

Run: `npx jest src/send-money/dto/resolve-transfer.dto.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the response DTO**

Create `src/send-money/dto/resolution-response.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Currency } from '../../common/domain.types';
import { SUPPORTED_CURRENCY } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';

class ResolvedRecipientDto {
  @ApiProperty({ example: 'Ethan Del Rosario' })
  displayName: string;
}

/**
 * Only the display name is returned for the recipient. No account id, no masked
 * number, no mobile: the client already knows what it typed, and echoing more
 * would reintroduce the enumeration leak this design removes.
 */
export class ResolutionResponseDto {
  @ApiProperty({
    description:
      'Opaque, short-lived. Send it back to POST /v1/send-money to complete the transfer.',
  })
  resolutionToken: string;

  @ApiProperty({ description: 'After this the token must be re-requested.' })
  expiresAt: Date;

  @ApiProperty({ type: ResolvedRecipientDto })
  recipient: ResolvedRecipientDto;

  @ApiProperty({ example: '1500.00', type: String })
  amount: string;

  @ApiProperty({ example: 150_000 })
  amountMinor: number;

  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  @ApiPropertyOptional({ nullable: true, example: 'Lunch' })
  note: string | null;

  static from(params: {
    token: string;
    expiresAt: Date;
    displayName: string;
    amountMinor: number;
    note: string | null;
  }): ResolutionResponseDto {
    return {
      resolutionToken: params.token,
      expiresAt: params.expiresAt,
      recipient: { displayName: params.displayName },
      amount: minorToPesos(params.amountMinor),
      amountMinor: params.amountMinor,
      currency: SUPPORTED_CURRENCY,
      note: params.note,
    };
  }
}
```

- [ ] **Step 6: Write the controller with phase one only**

Create `src/send-money/send-money.controller.ts`:

```typescript
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentIdentity } from '../auth/decorators/current-identity.decorator';
import { AuthenticatedIdentity } from '../auth/identity.types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { ResolutionResponseDto } from './dto/resolution-response.dto';
import { ResolveTransferDto } from './dto/resolve-transfer.dto';
import { SendMoneyService } from './send-money.service';

@ApiTags('Send Money')
@ApiBearerAuth()
@Controller({ path: 'send-money', version: '1' })
export class SendMoneyController {
  constructor(private readonly sendMoneyService: SendMoneyService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Recipient resolved.')
  @ApiOperation({
    summary: 'Validate a transfer and get a confirmation token',
    description:
      'Checks the sender balance and limits, resolves the recipient from a username or mobile number, and checks their status and receiving limits.\n\n' +
      'Every failed condition is reported at once as a 422 with an `errors` array, so a confirmation screen can show them all.\n\n' +
      'On success the `resolutionToken` is valid for 120 seconds. It is re-validated on POST /v1/send-money — a stale token is expected to fail, and every rule is re-run against live balances before money moves.',
    externalDocs: {
      description: 'Scenario walkthrough',
      url: 'https://github.com/#docs/SEND-MONEY.md',
    },
  })
  @ApiOkResponse({
    type: ResolutionResponseDto,
    schema: {
      example: {
        statusCode: 200,
        data: {
          resolutionToken: 'eyJhbGci…',
          expiresAt: '2026-08-27T09:17:00.000Z',
          recipient: { displayName: 'Ethan Del Rosario' },
          amount: '1500.00',
          amountMinor: 150000,
          currency: 'PHP',
          note: 'Lunch',
        },
        message: 'Recipient resolved.',
        timestamp: '2026-08-27T09:15:00.000Z',
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description: 'One or more conditions failed.',
    content: {
      'application/json': {
        examples: {
          insufficientFunds: {
            summary: 'Balance too low',
            value: {
              statusCode: 422,
              data: {
                errors: [
                  {
                    code: 'INSUFFICIENT_FUNDS',
                    message: 'Insufficient funds.',
                    details: { balanceMinor: 5000, requestedMinor: 150000 },
                  },
                ],
              },
              message: 'Transfer cannot proceed.',
              timestamp: '2026-08-27T09:15:00.000Z',
            },
          },
          dailyLimitExceeded: {
            summary: 'Over the sender daily limit',
            value: {
              statusCode: 422,
              data: {
                errors: [
                  {
                    code: 'SENDER_DAILY_LIMIT_EXCEEDED',
                    message:
                      'This transfer would exceed your daily sending limit.',
                    details: {
                      limitMinor: 5000000,
                      limit: '50000.00',
                      usedMinor: 4900000,
                      requestedMinor: 150000,
                    },
                  },
                ],
              },
              message: 'Transfer cannot proceed.',
              timestamp: '2026-08-27T09:15:00.000Z',
            },
          },
          recipientNotActive: {
            summary: 'Recipient is suspended (bobbie.salazar)',
            value: {
              statusCode: 422,
              data: {
                errors: [
                  {
                    code: 'RECIPIENT_NOT_ACTIVE',
                    message:
                      'The recipient cannot receive funds at this time.',
                    details: { status: 'suspended' },
                  },
                ],
              },
              message: 'Transfer cannot proceed.',
              timestamp: '2026-08-27T09:15:00.000Z',
            },
          },
          multipleErrors: {
            summary: 'Several conditions failed at once',
            value: {
              statusCode: 422,
              data: {
                errors: [
                  {
                    code: 'INSUFFICIENT_FUNDS',
                    message: 'Insufficient funds.',
                    details: { balanceMinor: 5000, requestedMinor: 150000 },
                  },
                  {
                    code: 'RECIPIENT_NOT_ACTIVE',
                    message:
                      'The recipient cannot receive funds at this time.',
                    details: { status: 'suspended' },
                  },
                ],
              },
              message: 'Transfer cannot proceed.',
              timestamp: '2026-08-27T09:15:00.000Z',
            },
          },
        },
      },
    },
  })
  resolve(
    @Body() dto: ResolveTransferDto,
    @CurrentIdentity() identity: AuthenticatedIdentity,
  ): Promise<ResolutionResponseDto> {
    return this.sendMoneyService.resolve(dto, identity);
  }
}
```

- [ ] **Step 7: Write the resolve half of the service**

Create `src/send-money/send-money.service.ts` (phase two is added in Task 10):

```typescript
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthenticatedIdentity } from '../auth/identity.types';
import { SendMoneyRuleViolation } from '../common/errors/send-money-error';
import { ResolutionResponseDto } from './dto/resolution-response.dto';
import { ResolveTransferDto } from './dto/resolve-transfer.dto';
import { ResolutionTokenService } from './resolution-token.service';
import { SendMoneyRulesService } from './send-money-rules.service';

@Injectable()
export class SendMoneyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rules: SendMoneyRulesService,
    private readonly tokens: ResolutionTokenService,
  ) {}

  /**
   * Phase one. Read-only: it validates and issues a token, and moves nothing.
   */
  async resolve(
    dto: ResolveTransferDto,
    identity: AuthenticatedIdentity,
  ): Promise<ResolutionResponseDto> {
    const amountMinor = dto.resolvedAmountMinor();

    const result = await this.rules.evaluate(
      {
        senderHolderId: identity.accountHolderId,
        recipientType: dto.recipient.type,
        recipientValue: dto.recipient.value,
        amountMinor,
      },
      this.dataSource.manager,
    );

    if (result.errors.length > 0) {
      throw new SendMoneyRuleViolation(result.errors);
    }

    // Both are defined whenever errors is empty; the checks keep TypeScript
    // honest rather than guarding a reachable case.
    const sender = result.sender!;
    const recipient = result.recipient!;
    const note = dto.note ?? null;

    const { token, expiresAt } = await this.tokens.sign({
      aid: identity.authIdentityId,
      src: sender.accountId,
      dst: recipient.accountId,
      amt: amountMinor,
      note,
    });

    return ResolutionResponseDto.from({
      token,
      expiresAt,
      displayName: recipient.displayName,
      amountMinor,
      note,
    });
  }
}
```

- [ ] **Step 8: Write the module**

Create `src/send-money/send-money.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from '../accounts/accounts.module';
import { AccountLimit } from '../accounts/entities/account-limit.entity';
import { LedgerEntry } from '../ledger/entities/ledger-entry.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { Transfer } from '../transfers/entities/transfer.entity';
import { RecipientResolverService } from './recipient-resolver.service';
import { ResolutionTokenService } from './resolution-token.service';
import { SendMoneyController } from './send-money.controller';
import { SendMoneyRulesService } from './send-money-rules.service';
import { SendMoneyService } from './send-money.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transfer, LedgerEntry, OutboxEvent, AccountLimit]),
    JwtModule.register({}),
    AccountsModule,
  ],
  controllers: [SendMoneyController],
  providers: [
    SendMoneyService,
    SendMoneyRulesService,
    RecipientResolverService,
    ResolutionTokenService,
  ],
})
export class SendMoneyModule {}
```

- [ ] **Step 9: Register in app.module.ts**

Add `SendMoneyModule` to the `imports` array in `src/app.module.ts`.

- [ ] **Step 10: Verify phase one end to end**

```bash
docker compose up -d postgres && npm run start:dev
```

```bash
TOKEN=$(curl -s -X POST localhost:3000/v1/dev/token -H 'content-type: application/json' \
  -d '{"username":"adelaida.magtalas"}' | jq -r .data.accessToken)

curl -s -X POST localhost:3000/v1/send-money/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"recipient":{"type":"username","value":"ethan.delrosario"},"amount":"1500.00","note":"Lunch"}' | jq
```

Expected: `statusCode: 200`, a `data.resolutionToken`, `data.recipient.displayName == "Ethan Del Rosario"`, and **no account id anywhere in the response**.

Then the suspended recipient:

```bash
curl -s -X POST localhost:3000/v1/send-money/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"recipient":{"type":"username","value":"bobbie.salazar"},"amount":"100.00"}' | jq
```

Expected: `422`, `data.errors[0].code == "RECIPIENT_NOT_ACTIVE"`.

- [ ] **Step 11: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/send-money src/app.module.ts
git commit -m "feat(send-money): POST /v1/send-money/resolve

Phase one. Validates everything and returns a 120s confirmation token; it
moves no money. Every failed rule comes back at once in a 422 errors array.

The response carries only the recipient's display name — no account id, no
masked number — since echoing more would reintroduce the enumeration leak
this design removes."
```

---

### Task 10: Phase two — POST /v1/send-money

**Files:**
- Create: `src/send-money/dto/execute-transfer.dto.ts`
- Create: `src/send-money/dto/send-money-receipt.dto.ts`
- Modify: `src/send-money/send-money.service.ts`
- Modify: `src/send-money/send-money.controller.ts`
- Test: `test/send-money.e2e-spec.ts`, `test/jest-e2e.json`

**Interfaces:**
- Consumes: Tasks 6, 8, 9.
- Produces:
  - `ExecuteTransferDto { resolutionToken: string }`
  - `SendMoneyReceiptDto { reference, recipient: { name }, amount, amountMinor, currency, note, postedAt }`
  - `SendMoneyService.execute(dto, identity, idempotencyKey): Promise<SendMoneyReceiptDto>`

- [ ] **Step 1: Write the DTOs**

Create `src/send-money/dto/execute-transfer.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ExecuteTransferDto {
  @ApiProperty({
    description:
      'The `resolutionToken` returned by POST /v1/send-money/resolve. Valid for 120 seconds.',
  })
  @IsString()
  @MinLength(1)
  resolutionToken: string;
}
```

Create `src/send-money/dto/send-money-receipt.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Currency } from '../../common/domain.types';
import { SUPPORTED_CURRENCY } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';

class ReceiptRecipientDto {
  @ApiProperty({ example: 'Ethan Del Rosario' })
  name: string;
}

export class SendMoneyReceiptDto {
  /**
   * The transfer's public_id. Safe as an output: it is a receipt for something
   * that happened, and no write endpoint accepts it as an input.
   */
  @ApiProperty({ format: 'uuid' })
  reference: string;

  @ApiProperty({ type: ReceiptRecipientDto })
  recipient: ReceiptRecipientDto;

  @ApiProperty({ example: '1500.00', type: String })
  amount: string;

  @ApiProperty({ example: 150_000 })
  amountMinor: number;

  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  @ApiPropertyOptional({ nullable: true, example: 'Lunch' })
  note: string | null;

  @ApiProperty()
  postedAt: Date;

  static from(params: {
    reference: string;
    recipientName: string;
    amountMinor: number;
    note: string | null;
    postedAt: Date;
  }): SendMoneyReceiptDto {
    return {
      reference: params.reference,
      recipient: { name: params.recipientName },
      amount: minorToPesos(params.amountMinor),
      amountMinor: params.amountMinor,
      currency: SUPPORTED_CURRENCY,
      note: params.note,
      postedAt: params.postedAt,
    };
  }
}
```

- [ ] **Step 2: Add execute() to the service**

Append to `src/send-money/send-money.service.ts` (add the imports it needs):

```typescript
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { SUPPORTED_CURRENCY } from '../common/domain.types';
import {
  EXECUTE_STALE_SUMMARY,
  SendMoneyRuleViolation,
} from '../common/errors/send-money-error';
import { LedgerEntry } from '../ledger/entities/ledger-entry.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { Transfer } from '../transfers/entities/transfer.entity';
import { ResolvedParty } from './recipient-resolver.service';
import { ExecuteTransferDto } from './dto/execute-transfer.dto';
import { SendMoneyReceiptDto } from './dto/send-money-receipt.dto';
```

```typescript
  /**
   * Phase two. Everything happens in one transaction: if the ledger write
   * fails, the balance update and the outbox event roll back with it, so the
   * cached balance can never drift from the ledger and no event is published
   * for a transfer that did not happen.
   */
  async execute(
    dto: ExecuteTransferDto,
    identity: AuthenticatedIdentity,
    idempotencyKey: string,
  ): Promise<SendMoneyReceiptDto> {
    if (!idempotencyKey) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message:
          'Send an Idempotency-Key header. Without one a retry would send twice.',
      });
    }

    const claims = await this.tokens.verify(
      dto.resolutionToken,
      identity.authIdentityId,
    );

    return this.dataSource.transaction(async (manager) => {
      const replay = await this.findReplay(
        manager,
        idempotencyKey,
        identity.authIdentityId,
      );
      if (replay) return replay;

      // Lock in a deterministic order. Two opposing transfers between the same
      // pair of accounts would otherwise each hold one row and wait on the
      // other; ordering by id makes that deadlock impossible.
      const locked = await manager.query(
        `SELECT a.id, a.account_holder_id, a.balance_minor, a.status AS account_status,
                h.display_name, h.status AS holder_status
           FROM accounts a
           JOIN account_holders h ON h.id = a.account_holder_id
          WHERE a.id = ANY($1::bigint[])
          ORDER BY a.id
            FOR UPDATE OF a`,
        [[claims.src, claims.dst]],
      );

      const byId = new Map<number, (typeof locked)[number]>(
        locked.map((row: { id: string }) => [Number(row.id), row]),
      );

      const source = byId.get(claims.src);
      const destination = byId.get(claims.dst);

      if (!source || !destination) {
        throw new NotFoundException({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'An account in this confirmation no longer exists.',
        });
      }

      const sender = toParty(source);
      const recipient = toParty(destination);

      // The token is up to 120 seconds stale and balances move, so every rule
      // runs again against the locked rows. The token was only ever a hint.
      const errors = await this.rules.evaluateResolved(
        sender,
        recipient,
        claims.amt,
        manager,
      );

      if (errors.length > 0) {
        // Same codes as phase one; the summary is what tells a client this was
        // a stale confirmation rather than a request that was never valid.
        throw new SendMoneyRuleViolation(errors, EXECUTE_STALE_SUMMARY);
      }

      return this.post(manager, claims, sender, recipient, identity, idempotencyKey);
    });
  }

  /**
   * A replayed idempotency key must return the original transfer rather than
   * moving money a second time. The unique index is scoped per initiating
   * identity, and this lookup matches that scope.
   */
  private async findReplay(
    manager: EntityManager,
    idempotencyKey: string,
    authIdentityId: number,
  ): Promise<SendMoneyReceiptDto | null> {
    const existing = await manager.getRepository(Transfer).findOne({
      where: {
        idempotencyKey,
        initiatedByAuthIdentityId: authIdentityId,
      },
      relations: { destinationAccount: { accountHolder: true } },
    });

    if (!existing) return null;

    return SendMoneyReceiptDto.from({
      reference: existing.publicId,
      recipientName:
        existing.destinationAccount?.accountHolder?.displayName ?? 'Recipient',
      amountMinor: existing.amountMinor,
      note: existing.note,
      postedAt: existing.postedAt ?? existing.createdAt,
    });
  }

  /** Writes the transfer, the double-entry pair, the balances and the event. */
  private async post(
    manager: EntityManager,
    claims: { src: number; dst: number; amt: number; note: string | null },
    sender: ResolvedParty,
    recipient: ResolvedParty,
    identity: AuthenticatedIdentity,
    idempotencyKey: string,
  ): Promise<SendMoneyReceiptDto> {
    // Inserted directly as 'posted'. The whole method runs inside one
    // transaction and the ledger write below either commits with it or rolls
    // back, so an intermediate 'pending' row would never be observable.
    let transferId: number;
    try {
      const [inserted] = await manager.query(
        `INSERT INTO transfers
           (source_account_id, destination_account_id, amount_minor,
            status, posted_at, note, idempotency_key, initiated_by_auth_identity_id)
         VALUES ($1, $2, $3, 'posted', now(), $4, $5, $6)
         RETURNING id`,
        [
          claims.src,
          claims.dst,
          claims.amt,
          claims.note,
          idempotencyKey,
          identity.authIdentityId,
        ],
      );
      transferId = Number(inserted.id);
    } catch (error) {
      // Two concurrent requests with the same key: the unique index rejects
      // the loser. Returning the winner's transfer is the point of the key.
      if (isUniqueViolation(error)) {
        const replay = await this.findReplay(
          manager,
          idempotencyKey,
          identity.authIdentityId,
        );
        if (replay) return replay;
      }
      throw error;
    }

    const newSourceBalance = sender.balanceMinor - claims.amt;
    const newDestinationBalance = recipient.balanceMinor + claims.amt;

    // balance_after_minor is recorded per entry so the ledger alone can be
    // replayed and audited without recomputing running totals.
    await manager.getRepository(LedgerEntry).insert([
      {
        transferId,
        accountId: claims.src,
        direction: 'debit',
        amountMinor: claims.amt,
        balanceAfterMinor: newSourceBalance,
      },
      {
        transferId,
        accountId: claims.dst,
        direction: 'credit',
        amountMinor: claims.amt,
        balanceAfterMinor: newDestinationBalance,
      },
    ]);

    // Relative deltas rather than absolute values: the rows are locked, so this
    // is equivalent, and it keeps accounts_balance_not_negative_chk as the
    // authority on overdrafts.
    await manager.query(
      `UPDATE accounts SET balance_minor = balance_minor - $1 WHERE id = $2`,
      [claims.amt, claims.src],
    );
    await manager.query(
      `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2`,
      [claims.amt, claims.dst],
    );

    // Read back through the repository so the entity mapping applies; building
    // the response from raw RETURNING rows would hand back undefined for every
    // camelCase property.
    const transfer = await manager
      .getRepository(Transfer)
      .findOneOrFail({ where: { id: transferId } });

    await manager.getRepository(OutboxEvent).insert({
      aggregateType: 'transfer',
      aggregateId: transferId,
      eventType: 'transfer.posted',
      payload: {
        transferId: transfer.publicId,
        amountMinor: claims.amt,
        currency: SUPPORTED_CURRENCY,
      },
    });

    return SendMoneyReceiptDto.from({
      reference: transfer.publicId,
      recipientName: recipient.displayName,
      amountMinor: claims.amt,
      note: claims.note,
      postedAt: transfer.postedAt ?? transfer.createdAt,
    });
  }
}

interface LockedAccountRow {
  id: string;
  account_holder_id: string;
  balance_minor: string;
  account_status: string;
  display_name: string;
  holder_status: string;
}

function toParty(row: LockedAccountRow): ResolvedParty {
  return {
    accountId: Number(row.id),
    accountHolderId: Number(row.account_holder_id),
    displayName: row.display_name,
    balanceMinor: Number(row.balance_minor),
    accountStatus: row.account_status,
    holderStatus: row.holder_status,
  };
}

/**
 * Postgres unique_violation. TypeORM wraps driver errors in QueryFailedError,
 * which sometimes surfaces the SQLSTATE at the top level and sometimes only on
 * driverError, so both are checked.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const { code, driverError } = error as {
    code?: string;
    driverError?: { code?: string };
  };

  return code === '23505' || driverError?.code === '23505';
}
```

- [ ] **Step 3: Add the endpoint to the controller**

Append to `SendMoneyController` (add `Headers` to the `@nestjs/common` import and the Swagger decorators used):

```typescript
  @Post()
  @ResponseMessage('Transfer posted.')
  @ApiOperation({
    summary: 'Complete a transfer using a confirmation token',
    description:
      'Spends the `resolutionToken` from POST /v1/send-money/resolve. Every rule is re-run against live, locked balances before money moves — the token is a confirmation, not an authorisation.\n\n' +
      'The transfer, its debit/credit ledger pair, both balances and the outbox event either all commit or none do.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required. Replaying the same key returns the original transfer instead of sending twice.',
  })
  @ApiCreatedResponse({
    type: SendMoneyReceiptDto,
    schema: {
      example: {
        statusCode: 201,
        data: {
          reference: '3f2a7c18-9d4e-4c1b-9f7a-2b8e5d6c1a90',
          recipient: { name: 'Ethan Del Rosario' },
          amount: '1500.00',
          amountMinor: 150000,
          currency: 'PHP',
          note: 'Lunch',
          postedAt: '2026-08-27T09:16:12.000Z',
        },
        message: 'Transfer posted.',
        timestamp: '2026-08-27T09:16:12.000Z',
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'The resolution token expired (RESOLUTION_TOKEN_EXPIRED), is invalid, or was issued to another identity.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'A rule that passed at resolve time no longer holds — same codes, with message "Transfer no longer valid; please confirm again."',
  })
  execute(
    @Body() dto: ExecuteTransferDto,
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<SendMoneyReceiptDto> {
    return this.sendMoneyService.execute(dto, identity, idempotencyKey);
  }
```

- [ ] **Step 4: Configure e2e to see the app**

Replace `test/jest-e2e.json`:

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  "testTimeout": 30000
}
```

- [ ] **Step 5: Write the e2e test**

Create `test/send-money.e2e-spec.ts`:

```typescript
import { INestApplication, Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { seed, truncate } from '../src/database/seeds/seed-data';

describe('Send money (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const tokenFor = async (username: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/v1/dev/token')
      .send({ username })
      .expect(200);

    return response.body.data.accessToken;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    app.useGlobalFilters(new AllExceptionsFilter());

    await app.init();

    dataSource = app.get(DataSource);
    await truncate(dataSource);
    await seed(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  it('posts a transfer end to end and moves both balances exactly once', async () => {
    const token = await tokenFor('adelaida.magtalas');

    const resolved = await request(app.getHttpServer())
      .post('/v1/send-money/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipient: { type: 'username', value: 'ethan.delrosario' },
        amount: '1500.00',
        note: 'Lunch',
      })
      .expect(200);

    expect(resolved.body).toMatchObject({
      statusCode: 200,
      message: 'Recipient resolved.',
      data: { recipient: { displayName: 'Ethan Del Rosario' } },
    });
    // The enumeration fix: no account identifier anywhere in the response.
    expect(JSON.stringify(resolved.body)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );

    const [before] = await dataSource.query(
      `SELECT balance_minor FROM accounts WHERE account_number = '1000000001'`,
    );

    const posted = await request(app.getHttpServer())
      .post('/v1/send-money')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ resolutionToken: resolved.body.data.resolutionToken })
      .expect(201);

    expect(posted.body).toMatchObject({
      statusCode: 201,
      message: 'Transfer posted.',
      data: {
        recipient: { name: 'Ethan Del Rosario' },
        amount: '1500.00',
        note: 'Lunch',
      },
    });

    const [after] = await dataSource.query(
      `SELECT balance_minor FROM accounts WHERE account_number = '1000000001'`,
    );
    expect(Number(before.balance_minor) - Number(after.balance_minor)).toBe(
      150_000,
    );

    const entries = await dataSource.query(
      `SELECT direction FROM ledger_entries le
         JOIN transfers t ON t.id = le.transfer_id
        WHERE t.public_id = $1 ORDER BY direction`,
      [posted.body.data.reference],
    );
    expect(entries.map((e: { direction: string }) => e.direction)).toEqual([
      'credit',
      'debit',
    ]);

    const outbox = await dataSource.query(
      `SELECT event_type FROM outbox_events ORDER BY id DESC LIMIT 1`,
    );
    expect(outbox[0].event_type).toBe('transfer.posted');
  });

  it('returns every failed condition at once', async () => {
    const token = await tokenFor('abigail.lim');

    const response = await request(app.getHttpServer())
      .post('/v1/send-money/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipient: { type: 'username', value: 'bobbie.salazar' },
        amount: '999999.00',
      })
      .expect(422);

    const codes = response.body.data.errors.map(
      (e: { code: string }) => e.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining(['INSUFFICIENT_FUNDS', 'RECIPIENT_NOT_ACTIVE']),
    );
    expect(response.body.message).toBe('Transfer cannot proceed.');
  });

  it('rejects a suspended holder token', async () => {
    const token = await tokenFor('bobbie.salazar');

    const response = await request(app.getHttpServer())
      .post('/v1/send-money/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipient: { type: 'username', value: 'ethan.delrosario' },
        amount: '100.00',
      })
      .expect(403);

    expect(response.body.data).toMatchObject({
      code: 'IDENTITY_NOT_ACTIVE',
      status: 'suspended',
    });
  });

  it('refuses a resolution token spent by another identity', async () => {
    const mine = await tokenFor('adelaida.magtalas');
    const theirs = await tokenFor('joy.fabregas');

    const resolved = await request(app.getHttpServer())
      .post('/v1/send-money/resolve')
      .set('Authorization', `Bearer ${mine}`)
      .send({
        recipient: { type: 'username', value: 'ethan.delrosario' },
        amount: '100.00',
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/v1/send-money')
      .set('Authorization', `Bearer ${theirs}`)
      .set('Idempotency-Key', randomUUID())
      .send({ resolutionToken: resolved.body.data.resolutionToken })
      .expect(403);

    expect(response.body.data.code).toBe(
      'RESOLUTION_TOKEN_IDENTITY_MISMATCH',
    );
  });

  it('moves money once when the same idempotency key is replayed', async () => {
    const token = await tokenFor('adelaida.magtalas');
    const key = randomUUID();

    const resolved = await request(app.getHttpServer())
      .post('/v1/send-money/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipient: { type: 'username', value: 'joy.fabregas' },
        amount: '250.00',
      })
      .expect(200);

    const send = () =>
      request(app.getHttpServer())
        .post('/v1/send-money')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ resolutionToken: resolved.body.data.resolutionToken });

    const first = await send().expect(201);
    const second = await send().expect(201);

    expect(second.body.data.reference).toBe(first.body.data.reference);

    const [{ count }] = await dataSource.query(
      `SELECT count(*)::int FROM transfers WHERE idempotency_key = $1`,
      [key],
    );
    expect(count).toBe(1);
  });

  it('requires an Idempotency-Key', async () => {
    const token = await tokenFor('adelaida.magtalas');

    const resolved = await request(app.getHttpServer())
      .post('/v1/send-money/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipient: { type: 'username', value: 'ethan.delrosario' },
        amount: '100.00',
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/v1/send-money')
      .set('Authorization', `Bearer ${token}`)
      .send({ resolutionToken: resolved.body.data.resolutionToken })
      .expect(400);

    expect(response.body.data.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('leaves /health outside the envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok', database: 'connected' });
  });
});
```

- [ ] **Step 6: Run the e2e suite**

```bash
docker compose up -d postgres && npm run migration:run
npm run test:e2e
```

Expected: 7 tests pass.

- [ ] **Step 7: Run everything**

Run: `npx jest && npm run test:e2e && npm run build`
Expected: all unit specs pass, all e2e pass, build clean.

- [ ] **Step 8: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add src/send-money test
git commit -m "feat(send-money): POST /v1/send-money posts the transfer

Phase two verifies the resolution token, locks both accounts in id order,
and re-runs every rule against live balances before moving anything — the
token is a confirmation, not an authorisation.

Idempotency-Key is required here, unlike the old endpoint where it was
optional: a phase-two retry without one sends twice."
```

---

### Task 11: Remove the old transfer write path

**Files:**
- Delete: `src/transfers/dto/create-transfer.dto.ts`, `src/transfers/dto/create-transfer.dto.spec.ts`
- Modify: `src/transfers/transfers.controller.ts`, `src/transfers/transfers.service.ts`, `src/transfers/transfers.module.ts`
- Modify: `src/common/validators/exactly-one-amount.validator.ts` (comment only)

**Interfaces:**
- Consumes: Task 10 (the replacement must work before this is removed).
- Produces: `TransfersService` reduced to `findByPublicId`; `TransfersController` reduced to `GET :publicId`.

`GET /v1/transfers/:publicId` stays. A `public_id` handed back as a receipt is a reasonable thing to look up; the objection was to accepting one as a write input.

- [ ] **Step 1: Delete the DTO and its spec**

```bash
git rm src/transfers/dto/create-transfer.dto.ts src/transfers/dto/create-transfer.dto.spec.ts
```

- [ ] **Step 2: Reduce the service**

Replace `src/transfers/transfers.service.ts` entirely:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TransferResponseDto } from './dto/transfer-response.dto';
import { Transfer } from './entities/transfer.entity';

/**
 * Read model for transfers. Writing is SendMoneyModule's job: a transfer is
 * created by the two-phase send-money flow, never by naming two accounts.
 */
@Injectable()
export class TransfersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findByPublicId(publicId: string): Promise<TransferResponseDto> {
    const transfer = await this.dataSource.getRepository(Transfer).findOne({
      where: { publicId },
      relations: { sourceAccount: true, destinationAccount: true },
    });

    if (!transfer) {
      throw new NotFoundException(`Transfer ${publicId} not found.`);
    }

    return TransferResponseDto.from(
      transfer,
      transfer.sourceAccount!.publicId,
      transfer.destinationAccount!.publicId,
    );
  }
}
```

This drops `create`, `assertTransferable`, `assertWithinLimits`, `findReplay`, `post`, and `isUniqueViolation`. It also drops the currency arm of `assertTransferable`, which was unreachable: `accounts_currency_chk` pins every row to PHP.

- [ ] **Step 3: Reduce the controller**

Replace `src/transfers/transfers.controller.ts`:

```typescript
import { Controller, Get, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { TransferResponseDto } from './dto/transfer-response.dto';
import { TransfersService } from './transfers.service';

@ApiTags('Transfers')
@ApiBearerAuth()
@Controller({ path: 'transfers', version: '1' })
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  @Get(':publicId')
  @ResponseMessage('Transfer found.')
  @ApiOperation({
    summary: 'Fetch a transfer by its reference',
    description:
      'The reference is the `reference` returned by POST /v1/send-money. Transfers are created through the send-money flow, not by this resource.',
  })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  @ApiOkResponse({ type: TransferResponseDto })
  @ApiNotFoundResponse({ description: 'No transfer with that reference.' })
  findOne(
    @Param(
      'publicId',
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND }),
    )
    publicId: string,
  ): Promise<TransferResponseDto> {
    return this.transfersService.findByPublicId(publicId);
  }
}
```

- [ ] **Step 4: Trim the module**

`TransfersModule` no longer writes, so it needs neither `AccountsModule` nor the ledger/outbox entities:

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transfer } from './entities/transfer.entity';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [TypeOrmModule.forFeature([Transfer])],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
```

- [ ] **Step 5: Update the validator's stale comment**

In `src/common/validators/exactly-one-amount.validator.ts`, the class doc references the old host field. Change the note about where it sits to name the new host:

```typescript
 * Hosted on ResolveTransferDto.recipient — a required property, because
 * class-validator skips every decorator on an @IsOptional() property when the
 * value is absent, so a body omitting both amounts would slip through.
```

- [ ] **Step 6: Confirm nothing still references the removed code**

```bash
grep -rn "CreateTransferDto\|sourceAccountId\|destinationAccountId" src/ --include="*.ts" | grep -v entities/ | grep -v dto/transfer-response
```

Expected: no output. Matches inside `entities/` and `transfer-response.dto.ts` are the persistence layer and the read model, which legitimately keep those names.

- [ ] **Step 7: Run everything**

Run: `npm run build && npx jest && npm run test:e2e`
Expected: build clean, all specs pass. The `create-transfer.dto.spec.ts` tests are gone; `resolve-transfer.dto.spec.ts` covers the same validation.

- [ ] **Step 8: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add -A src
git commit -m "refactor(transfers): drop the account-naming write path

POST /v1/transfers took account public_ids in the body, which made accounts
enumerable and gave a confirmation screen nothing to show. The two-phase
send-money flow replaces it.

GET :publicId stays: a reference handed back as a receipt is fine to look
up, the objection was to accepting one as a write input.

Also removes the unreachable currency branch — accounts_currency_chk pins
every row to PHP, so it could never fire."
```

---

### Task 12: Compose — demo mode and the migrate service

**Files:**
- Modify: `docker-compose.yml`
- Create: `src/database/migrate-and-seed.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Tasks 2, 4.
- Produces: `docker compose up` yields a migrated, seeded, demoable stack.

- [ ] **Step 1: Write the entrypoint**

Create `src/database/migrate-and-seed.ts`:

```typescript
import dataSource from './data-source';
import { seed } from './seeds/seed-data';

/**
 * Entry point for the one-shot `migrate` compose service.
 *
 * Compiled to dist/database/migrate-and-seed.js by `nest build`, so the
 * production image needs neither ts-node nor the TypeORM CLI.
 *
 * Idempotent: runMigrations() skips what is already applied and seed()
 * short-circuits on its marker subject, so re-running `docker compose up` is
 * safe.
 */
async function run(): Promise<void> {
  await dataSource.initialize();

  try {
    const applied = await dataSource.runMigrations();
    console.log(
      applied.length > 0
        ? `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`
        : 'Schema already up to date.',
    );

    await seed(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

run().catch((error) => {
  console.error('Migrate and seed failed:', error);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it compiles into dist**

Run: `npm run build && ls dist/database/migrate-and-seed.js`
Expected: the file exists.

- [ ] **Step 3: Add the migrate service**

In `docker-compose.yml`, insert between `postgres` and `api`:

```yaml
  # 2. One-shot schema + fixture load. Exits; the API waits for it.
  migrate:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: maya_arvi_martech_migrate
    # Overrides the restart: always the long-running services use — a task that
    # is meant to exit must not be restarted on success.
    restart: "no"
    command: ["node", "dist/database/migrate-and-seed.js"]
    environment:
      NODE_ENV: demo
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    depends_on:
      postgres:
        condition: service_healthy
```

- [ ] **Step 4: Put the api in demo mode and gate it on migrate**

In the `api` service, replace the `environment` and `depends_on` blocks:

```yaml
    environment:
      PORT: 3000
      # Not 'production': the hardening keys off that exact string, and this
      # stack needs /v1/dev/token to be demoable. The Dockerfile still sets
      # production, so the image stays safe to deploy unchanged.
      NODE_ENV: demo
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:-demo-access-secret-not-for-production}
      JWT_RESOLUTION_SECRET: ${JWT_RESOLUTION_SECRET:-demo-resolution-secret-not-for-production}
      JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-3600}
      JWT_RESOLUTION_TTL_SECONDS: ${JWT_RESOLUTION_TTL_SECONDS:-120}
      JWT_ISSUER: ${JWT_ISSUER:-http://localhost:8080/realms/send-money}
    depends_on:
      postgres:
        condition: service_healthy
      # Never serve traffic against an unmigrated schema.
      migrate:
        condition: service_completed_successfully
```

- [ ] **Step 5: Bring the whole stack up from scratch**

```bash
docker compose down -v
docker compose up -d --build
docker compose logs migrate
```

Expected in the migrate logs: `Applied 2 migration(s): InitialSchema1787796874604, AddTransferNote1788000000000` then `Seeded 7 holders and 8 identities with accounts and limits.` and the container exits `0`.

- [ ] **Step 6: Confirm the API is demoable**

```bash
curl -s localhost:${API_HOST_PORT:-3000}/health | jq
curl -s -X POST localhost:${API_HOST_PORT:-3000}/v1/dev/token \
  -H 'content-type: application/json' -d '{"username":"adelaida.magtalas"}' | jq
```

Expected: health returns the bare Terminus shape; dev/token returns an envelope with `data.accessToken`. Check `docker compose logs api` shows the `NODE_ENV=demo` warning banner.

- [ ] **Step 7: Confirm re-running is safe**

Run: `docker compose up -d` again, then `docker compose logs migrate | tail -5`
Expected: `Schema already up to date.` and `Seed data already present; skipping.`

- [ ] **Step 8: Commit**

```bash
npm run lint:fix && npm run lint:spell
git add docker-compose.yml src/database/migrate-and-seed.ts .env.example
git commit -m "feat(compose): docker compose up yields a migrated, seeded, demoable stack

A one-shot migrate service runs a compiled entrypoint, so the runner image
needs no ts-node or TypeORM CLI. The api gates on
service_completed_successfully and never serves an unmigrated schema.
Migration stays out of app startup: an app that migrates on boot cannot
scale past one replica without racing on DDL.

The api runs NODE_ENV=demo so /v1/dev/token exists. The Dockerfile keeps
production, so the image is unchanged for a real deploy."
```

---

### Task 13: Scenario script and evaluation docs

**Files:**
- Create: `scripts/scenarios.sh`
- Create: `docs/SEND-MONEY.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: every prior task.
- Produces: `./scripts/scenarios.sh <scenario|all>` exiting non-zero on any divergence.

- [ ] **Step 1: Write the script skeleton and helpers**

Create `scripts/scenarios.sh` (`chmod +x` it in Step 5):

```bash
#!/usr/bin/env bash
# Self-asserting walkthrough of the send-money flow.
#
# Each scenario prints its request, the envelope it got back, and PASS/FAIL.
# `all` exits non-zero if anything diverges, so this is an acceptance suite
# rather than a demo reel.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:${API_HOST_PORT:-3000}}"
PASSED=0
FAILED=0

command -v jq >/dev/null 2>&1 || {
  echo "jq is required. Install with: brew install jq (macOS) or apt-get install jq" >&2
  exit 1
}

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }

pass() { PASSED=$((PASSED + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

# Mints an access token. The evaluator never handles one by hand — resolution
# tokens live 120 seconds and manual paste between two calls is error-prone.
token_for() {
  curl -s -X POST "$BASE_URL/v1/dev/token" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"$1\"}" | jq -r '.data.accessToken'
}

# resolve <token> <recipient-type> <recipient-value> <amount> [note]
resolve() {
  local note_json=""
  [ -n "${5:-}" ] && note_json=",\"note\":\"$5\""

  curl -s -w '\n%{http_code}' -X POST "$BASE_URL/v1/send-money/resolve" \
    -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"recipient\":{\"type\":\"$2\",\"value\":\"$3\"},\"amount\":\"$4\"$note_json}"
}

# execute <token> <resolution-token> <idempotency-key>
execute() {
  curl -s -w '\n%{http_code}' -X POST "$BASE_URL/v1/send-money" \
    -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -H "Idempotency-Key: $3" \
    -d "{\"resolutionToken\":\"$2\"}"
}

status_of() { tail -n1 <<<"$1"; }
body_of()   { sed '$d' <<<"$1"; }

expect_status() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label — expected HTTP $expected, got $actual"
  fi
}

expect_code() {
  local body="$1" code="$2"
  if jq -e --arg c "$code" '.data.errors[]? | select(.code == $c)' >/dev/null <<<"$body"; then
    pass "reported $code"
  else
    fail "expected error code $code; got $(jq -c '.data.errors // .data' <<<"$body")"
  fi
}
```

- [ ] **Step 2: Write the scenarios**

Append to `scripts/scenarios.sh`:

```bash
scenario_happy() {
  bold "happy — Adelaida sends PHP 1,500.00 to Ethan"
  local token response body status
  token=$(token_for adelaida.magtalas)

  info "POST /v1/send-money/resolve"
  response=$(resolve "$token" username ethan.delrosario 1500.00 "Lunch")
  status=$(status_of "$response"); body=$(body_of "$response")
  expect_status "$status" 200 "resolve"

  jq -c '.data | {recipient, amount, expiresAt}' <<<"$body" | sed 's/^/  /'

  local rt; rt=$(jq -r '.data.resolutionToken' <<<"$body")

  info "POST /v1/send-money"
  response=$(execute "$token" "$rt" "$(uuidgen)")
  status=$(status_of "$response"); body=$(body_of "$response")
  expect_status "$status" 201 "execute"

  jq -c '.data' <<<"$body" | sed 's/^/  /'
  info "Cross-check: docs/SEND-MONEY.md § happy"
}

scenario_insufficient_funds() {
  bold "insufficient-funds — Abigail (PHP 1,999.99) tries to send PHP 5,000.00"
  local token response body
  token=$(token_for abigail.lim)
  response=$(resolve "$token" username ethan.delrosario 5000.00)
  expect_status "$(status_of "$response")" 422 "resolve rejected"
  body=$(body_of "$response")
  expect_code "$body" INSUFFICIENT_FUNDS
}

scenario_sender_limit() {
  bold "sender-limit — build up usage, then cross the PHP 50,000 daily cap"
  local token rt response body key
  token=$(token_for arturo.montenegro)

  info "Sending 49,900.00 to reach just under the cap"
  response=$(resolve "$token" username ethan.delrosario 49900.00)
  if [ "$(status_of "$response")" != "200" ]; then
    fail "setup transfer rejected: $(jq -c '.data' <<<"$(body_of "$response")")"
    return
  fi
  rt=$(jq -r '.data.resolutionToken' <<<"$(body_of "$response")")
  execute "$token" "$rt" "$(uuidgen)" >/dev/null

  info "Now 100.00 lands exactly on the limit — inclusive, so it passes"
  response=$(resolve "$token" username ethan.delrosario 100.00)
  expect_status "$(status_of "$response")" 200 "boundary amount allowed"
  rt=$(jq -r '.data.resolutionToken' <<<"$(body_of "$response")")
  execute "$token" "$rt" "$(uuidgen)" >/dev/null

  info "One more centavo is over"
  response=$(resolve "$token" username ethan.delrosario 0.01)
  expect_status "$(status_of "$response")" 422 "over-limit rejected"
  expect_code "$(body_of "$response")" SENDER_DAILY_LIMIT_EXCEEDED
}

scenario_recipient_limit() {
  bold "recipient-limit — fill Joy's inbound headroom, then exceed it"
  local token rt response
  token=$(token_for richard.lim)

  info "Crediting Joy 50,000.00 to consume her daily receiving limit"
  response=$(resolve "$token" username joy.fabregas 50000.00)
  if [ "$(status_of "$response")" = "200" ]; then
    rt=$(jq -r '.data.resolutionToken' <<<"$(body_of "$response")")
    execute "$token" "$rt" "$(uuidgen)" >/dev/null
  fi

  info "A further 100.00 exceeds what she may receive today"
  response=$(resolve "$token" username joy.fabregas 100.00)
  expect_status "$(status_of "$response")" 422 "recipient over limit"
  expect_code "$(body_of "$response")" RECIPIENT_DAILY_LIMIT_EXCEEDED
}

scenario_recipient_not_found() {
  bold "recipient-not-found — an unknown username"
  local response
  response=$(resolve "$(token_for adelaida.magtalas)" username no.such.person 100.00)
  expect_status "$(status_of "$response")" 422 "rejected"
  expect_code "$(body_of "$response")" RECIPIENT_NOT_FOUND
}

scenario_recipient_suspended() {
  bold "recipient-suspended — Bobbie Salazar cannot receive"
  local response
  response=$(resolve "$(token_for adelaida.magtalas)" username bobbie.salazar 100.00)
  expect_status "$(status_of "$response")" 422 "rejected"
  expect_code "$(body_of "$response")" RECIPIENT_NOT_ACTIVE
}

scenario_sender_suspended() {
  bold "sender-suspended — Bobbie's token is rejected by the guard"
  local token response body
  token=$(token_for bobbie.salazar)
  info "A token IS minted for a suspended holder; the guard is what rejects it"

  response=$(resolve "$token" username ethan.delrosario 100.00)
  expect_status "$(status_of "$response")" 403 "guard rejected"
  body=$(body_of "$response")

  if [ "$(jq -r '.data.code' <<<"$body")" = "IDENTITY_NOT_ACTIVE" ]; then
    pass "reported IDENTITY_NOT_ACTIVE"
  else
    fail "expected IDENTITY_NOT_ACTIVE; got $(jq -c '.data' <<<"$body")"
  fi
}

scenario_self_transfer() {
  bold "self-transfer — sending to your own username"
  local response
  response=$(resolve "$(token_for adelaida.magtalas)" username adelaida.magtalas 100.00)
  expect_status "$(status_of "$response")" 422 "rejected"
  expect_code "$(body_of "$response")" SELF_TRANSFER_NOT_ALLOWED
}

scenario_multi_error() {
  bold "multi-error — several conditions fail in one call"
  local response body count
  response=$(resolve "$(token_for abigail.lim)" username bobbie.salazar 999999.00)
  expect_status "$(status_of "$response")" 422 "rejected"
  body=$(body_of "$response")

  count=$(jq '.data.errors | length' <<<"$body")
  if [ "$count" -ge 2 ]; then
    pass "returned $count codes in one response"
    jq -r '.data.errors[] | "    - \(.code): \(.message)"' <<<"$body"
  else
    fail "expected at least 2 error codes, got $count"
  fi
}

scenario_expired_token() {
  bold "expired-token — a confirmation left too long (takes ~2 minutes)"
  local token rt response
  token=$(token_for adelaida.magtalas)
  response=$(resolve "$token" username ethan.delrosario 100.00)
  rt=$(jq -r '.data.resolutionToken' <<<"$(body_of "$response")")

  info "Waiting 125s for the 120s token to expire..."
  sleep 125

  response=$(execute "$token" "$rt" "$(uuidgen)")
  expect_status "$(status_of "$response")" 403 "expired token rejected"

  if [ "$(jq -r '.data.code' <<<"$(body_of "$response")")" = "RESOLUTION_TOKEN_EXPIRED" ]; then
    pass "reported RESOLUTION_TOKEN_EXPIRED"
  else
    fail "expected RESOLUTION_TOKEN_EXPIRED"
  fi
}

scenario_replay() {
  bold "replay — the same Idempotency-Key twice moves money once"
  local token rt key first second
  token=$(token_for adelaida.magtalas)
  key=$(uuidgen)

  rt=$(jq -r '.data.resolutionToken' \
    <<<"$(body_of "$(resolve "$token" username ethan.delrosario 250.00)")")

  first=$(jq -r '.data.reference' <<<"$(body_of "$(execute "$token" "$rt" "$key")")")
  second=$(jq -r '.data.reference' <<<"$(body_of "$(execute "$token" "$rt" "$key")")")

  if [ "$first" = "$second" ] && [ "$first" != "null" ]; then
    pass "both calls returned reference $first"
  else
    fail "expected the same reference twice, got '$first' and '$second'"
  fi
  info "Cross-check: SELECT count(*) FROM transfers WHERE idempotency_key = '$key'; -- expect 1"
}
```

- [ ] **Step 3: Write the dispatcher**

Append to `scripts/scenarios.sh`:

```bash
ALL_SCENARIOS=(
  happy insufficient_funds sender_limit recipient_limit
  recipient_not_found recipient_suspended sender_suspended
  self_transfer multi_error replay
)

run_all() {
  local include_slow="${1:-}"

  for name in "${ALL_SCENARIOS[@]}"; do
    "scenario_$name"
    echo
  done

  if [ "$include_slow" = "--slow" ]; then
    scenario_expired_token
    echo
  fi

  bold "Summary: $PASSED passed, $FAILED failed"
  if [ "$include_slow" != "--slow" ]; then
    info "Skipped: expired-token (costs ~2 minutes). Run './scripts/scenarios.sh all --slow' to include it."
  fi
  [ "$FAILED" -eq 0 ]
}

case "${1:-}" in
  happy)               scenario_happy ;;
  insufficient-funds)  scenario_insufficient_funds ;;
  sender-limit)        scenario_sender_limit ;;
  recipient-limit)     scenario_recipient_limit ;;
  recipient-not-found) scenario_recipient_not_found ;;
  recipient-suspended) scenario_recipient_suspended ;;
  sender-suspended)    scenario_sender_suspended ;;
  self-transfer)       scenario_self_transfer ;;
  multi-error)         scenario_multi_error ;;
  expired-token)       scenario_expired_token ;;
  replay)              scenario_replay ;;
  all)                 run_all "${2:-}" ;;
  *)
    echo "Usage: $0 <scenario|all [--slow]>"
    echo
    echo "Scenarios: happy insufficient-funds sender-limit recipient-limit"
    echo "           recipient-not-found recipient-suspended sender-suspended"
    echo "           self-transfer multi-error expired-token replay"
    echo
    echo "Most scenarios assume a freshly seeded database:"
    echo "  docker compose down -v && docker compose up -d"
    exit 1
    ;;
esac

[ "$FAILED" -eq 0 ]
```

- [ ] **Step 4: Verify against a clean stack**

```bash
chmod +x scripts/scenarios.sh
docker compose down -v && docker compose up -d --build
./scripts/scenarios.sh all
echo "exit: $?"
```

Expected: every scenario PASSes, summary reports `0 failed`, exit `0`. Then deliberately break one expectation (change an expected code) and confirm the exit status becomes `1` — that is what makes this an acceptance suite.

- [ ] **Step 5: Write docs/SEND-MONEY.md**

Create `docs/SEND-MONEY.md` covering, in this order:

1. **Quick start** — `docker compose up -d --build`, then `./scripts/scenarios.sh all`. Note that `docker compose down -v` is the reset, and that the limit scenarios are only repeatable from a clean database.
2. **The two phases** — the request/response for each endpoint, with the note that the resolution token lives 120 seconds and is re-validated on execute.
3. **Seeded identities table** — username, mobile, display name, opening balance, limits, status, for all 8 identities including `bobbie.salazar` (suspended).
4. **One section per scenario** — what it proves, the endpoints in order, the expected response, the subcommand, and a SQL cross-check. For `happy`:

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

For `replay`:

```sql
-- one row, however many times the key was replayed
SELECT count(*) FROM transfers WHERE idempotency_key = '<the key>';
```

For `sender-limit`:

```sql
-- what the limit check was measuring; only transfer-linked entries count
SELECT le.direction, sum(le.amount_minor) AS used_minor
  FROM ledger_entries le
  JOIN accounts a ON a.id = le.account_id
 WHERE a.account_holder_id = (SELECT id FROM account_holders WHERE display_name = 'Montenegro Industries')
   AND le.transfer_id IS NOT NULL
   AND le.posted_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila'
 GROUP BY le.direction;
```

5. **Running the SQL** — DbGate at `http://localhost:${DBGATE_HOST_PORT}` needs no client installed and no connection string; the connection is pre-configured. Or `docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"`.
6. **Swagger** — `http://localhost:${API_HOST_PORT}/docs`; mint a token at `/v1/dev/token`, click Authorize, paste it, and every example is runnable.

- [ ] **Step 6: Link it from the README**

Add to `README.md`:

```markdown
## Send money

`docker compose up -d --build` brings up Postgres, the API (migrated and
seeded) and DbGate. Then:

    ./scripts/scenarios.sh all

See [docs/SEND-MONEY.md](docs/SEND-MONEY.md) for the endpoint walkthrough,
the seeded identities, and SQL to cross-check each scenario against the
database.
```

- [ ] **Step 7: Final full verification**

```bash
docker compose down -v && docker compose up -d --build
npx jest && npm run test:e2e && npm run build
npm run lint && npm run lint:spell
./scripts/scenarios.sh all
```

Expected: all unit specs pass, all e2e pass, build clean, lint clean, every scenario PASSes with exit `0`.

- [ ] **Step 8: Commit**

```bash
git add scripts docs/SEND-MONEY.md README.md
git commit -m "docs: self-asserting scenario runner and evaluation guide

scripts/scenarios.sh mints its own tokens and asserts each expected status
and error code, exiting non-zero on divergence — an acceptance suite, not a
demo reel. expired-token is excluded from 'all' by default because it costs
two minutes; the summary names what it skipped.

docs/SEND-MONEY.md pairs each scenario with SQL to cross-check the result
against the database rather than trusting the API's own report."
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: §1 envelope → Task 1; §2 auth → Tasks 4–5; §3 phase one (all 12 codes, inbound limits, resolution) → Tasks 3, 7, 8, 9; §4 phase two → Task 10; §5 schema and seed → Task 2; §6 removals → Task 11; §7 module layout → Tasks 1, 4–10, 12; §8 testing → tests inside each task plus the e2e in Task 10; §9 evaluation aids → Tasks 12–13.

**Type consistency.** `getUsage(holderId, manager, direction)` is defined in Task 3 and called with that arity in Tasks 3, 8. `ResolvedParty` is defined in Task 7 and consumed unchanged in Tasks 8 and 10. `ResolutionClaims` field names (`aid`, `src`, `dst`, `amt`, `note`, `jti`) are identical in Tasks 6, 9, 10. `SendMoneyErrorCode` members are used by the same names in Tasks 1, 7, 8. `isHealthPath` is exported by the interceptor in Task 1 and imported by the filter in the same task.

**Known ordering constraint.** Task 4 writes `AuthModule`, which imports `JwtAuthGuard` from Task 5. Task 4's verification step is a build-and-unit-test check only; the app will not boot until Task 5 lands. This is called out in Task 4 Step 18.
