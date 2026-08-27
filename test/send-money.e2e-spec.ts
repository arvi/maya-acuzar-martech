import { randomUUID } from 'node:crypto';
import {
  INestApplication,
  Logger,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
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

    expect(response.body.data.code).toBe('RESOLUTION_TOKEN_IDENTITY_MISMATCH');
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

  it('rejects execute when the recipient was suspended after resolve (phase-two re-check)', async () => {
    const token = await tokenFor('adelaida.magtalas');

    const resolved = await request(app.getHttpServer())
      .post('/v1/send-money/resolve')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipient: { type: 'username', value: 'ethan.delrosario' },
        amount: '100.00',
      })
      .expect(200);

    const [recipientHolder] = await dataSource.query(
      `SELECT h.id AS holder_id, a.id AS account_id
         FROM account_holders h
         JOIN accounts a ON a.account_holder_id = h.id
        WHERE h.display_name = 'Ethan Del Rosario'`,
    );

    const [before] = await dataSource.query(
      `SELECT balance_minor FROM accounts WHERE id = $1`,
      [recipientHolder.account_id],
    );

    // Simulates the reviewer's live probe: a fraud-triggered suspension
    // landing inside the resolve-to-execute window, applied directly against
    // the locked row phase two re-fetches by id (not through the resolver).
    await dataSource.query(
      `UPDATE accounts SET status = 'suspended' WHERE id = $1`,
      [recipientHolder.account_id],
    );

    try {
      const response = await request(app.getHttpServer())
        .post('/v1/send-money')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ resolutionToken: resolved.body.data.resolutionToken })
        .expect(422);

      expect(response.body.message).toBe(
        'Transfer no longer valid; please confirm again.',
      );
      const codes = response.body.data.errors.map(
        (e: { code: string }) => e.code,
      );
      expect(codes).toContain('RECIPIENT_NOT_ACTIVE');

      // The whole point of the test: the suspended account must not have
      // been credited. 201 would mean the phase-two re-check was bypassed.
      const [afterAttempt] = await dataSource.query(
        `SELECT balance_minor FROM accounts WHERE id = $1`,
        [recipientHolder.account_id],
      );
      expect(afterAttempt.balance_minor).toBe(before.balance_minor);
    } finally {
      // Restore shared fixture state: other tests in this file reuse Ethan's
      // account and expect it active.
      await dataSource.query(
        `UPDATE accounts SET status = 'active' WHERE id = $1`,
        [recipientHolder.account_id],
      );
    }
  });

  it('excludes a ledger entry from a previous day/month when computing limit usage', async () => {
    // Arturo (Montenegro Industries) has the seed default limits: PHP 50,000/day,
    // PHP 500,000/month. A backdated debit of PHP 49,999.00 would blow the daily
    // limit for any subsequent transfer today if the SQL boundary in
    // AccountLimitsService.getUsage() were wrong and counted it anyway.
    const [sender] = await dataSource.query(
      `SELECT h.id AS holder_id, a.id AS account_id
         FROM account_holders h
         JOIN accounts a ON a.account_holder_id = h.id
        WHERE h.display_name = 'Montenegro Industries'`,
    );
    const [destination] = await dataSource.query(
      `SELECT a.id AS account_id
         FROM account_holders h
         JOIN accounts a ON a.account_holder_id = h.id
        WHERE h.display_name = 'Ethan Del Rosario'`,
    );

    // Computed rather than a fixed 'now() - interval 2 days': a fixed offset
    // would cross into the previous month on the 1st/2nd of a calendar month,
    // silently changing which boundary this timestamp tests. GREATEST clamps
    // it to month start on any day where 2-days-ago would otherwise predate
    // the month; that clamp is only NOT strictly before today's midnight when
    // today IS the 1st (month start), which is the one calendar day where "a
    // moment before today but still this month" cannot exist at all — dailyIsExclusive
    // below detects that case so the assertions stay correct instead of flaky.
    const [{ chosen_daily: chosenDaily, day_start: dayStart }] =
      await dataSource.query(
        `SELECT
           GREATEST(
             date_trunc('month', now() AT TIME ZONE 'Asia/Manila'),
             date_trunc('day', now() AT TIME ZONE 'Asia/Manila') - interval '1 hour'
           ) AT TIME ZONE 'Asia/Manila' AS chosen_daily,
           date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila' AS day_start`,
      );
    const dailyIsExclusive = new Date(chosenDaily) < new Date(dayStart);

    const backdatedDailyTransferId = '11111111-1111-4111-8111-111111111111';
    const backdatedMonthlyTransferId = '22222222-2222-4222-8222-222222222222';

    try {
      // Timestamped just after this month started (or, on every day but the
      // 1st, roughly 2 days ago) — before today's Manila-time midnight, but
      // always inside the current month.
      const [dailyTransfer] = await dataSource.query(
        `INSERT INTO transfers
           (public_id, source_account_id, destination_account_id, amount_minor,
            status, posted_at, note, idempotency_key)
         VALUES ($1, $2, $3, $4, 'posted', $6, 'Backdated daily boundary fixture', $5)
         RETURNING id`,
        [
          backdatedDailyTransferId,
          sender.account_id,
          destination.account_id,
          4_999_900,
          `test-daily-boundary-${backdatedDailyTransferId}`,
          chosenDaily,
        ],
      );

      await dataSource.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount_minor, posted_at)
         VALUES
           ($1, $2, 'debit',  $3, $5),
           ($1, $4, 'credit', $3, $5)`,
        [
          dailyTransfer.id,
          sender.account_id,
          4_999_900,
          destination.account_id,
          chosenDaily,
        ],
      );
      await dataSource.query(
        `UPDATE accounts SET balance_minor = balance_minor - $1 WHERE id = $2`,
        [4_999_900, sender.account_id],
      );
      await dataSource.query(
        `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2`,
        [4_999_900, destination.account_id],
      );

      // Backdated 35 days ago: safely outside the current calendar month
      // regardless of what day of the month the suite runs on.
      const [monthlyTransfer] = await dataSource.query(
        `INSERT INTO transfers
           (public_id, source_account_id, destination_account_id, amount_minor,
            status, posted_at, note, idempotency_key)
         VALUES ($1, $2, $3, $4, 'posted', now() - interval '35 days', 'Backdated monthly boundary fixture', $5)
         RETURNING id`,
        [
          backdatedMonthlyTransferId,
          sender.account_id,
          destination.account_id,
          3_999_900,
          `test-monthly-boundary-${backdatedMonthlyTransferId}`,
        ],
      );

      await dataSource.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount_minor, posted_at)
         VALUES
           ($1, $2, 'debit',  $3, now() - interval '35 days'),
           ($1, $4, 'credit', $3, now() - interval '35 days')`,
        [
          monthlyTransfer.id,
          sender.account_id,
          3_999_900,
          destination.account_id,
        ],
      );
      await dataSource.query(
        `UPDATE accounts SET balance_minor = balance_minor - $1 WHERE id = $2`,
        [3_999_900, sender.account_id],
      );
      await dataSource.query(
        `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2`,
        [3_999_900, destination.account_id],
      );

      // API-level proof: a normal-sized transfer today still succeeds, so the
      // backdated debit was excluded from today's usage window.
      const token = await tokenFor('arturo.montenegro');

      const resolved = await request(app.getHttpServer())
        .post('/v1/send-money/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({
          recipient: { type: 'username', value: 'ethan.delrosario' },
          amount: '100.00',
        })
        .expect(200);

      expect(resolved.body).toMatchObject({
        statusCode: 200,
        message: 'Recipient resolved.',
        data: { recipient: { displayName: 'Ethan Del Rosario' } },
      });
      expect(resolved.body.data.errors).toBeUndefined();

      // SQL-level proof: query the same boundary directly and confirm the
      // backdated amounts are excluded, independent of the API-level
      // assertion above. The 35-days-ago entry is always from a previous
      // month, so daily usage always excludes it. The "2 days ago" entry is
      // excluded from daily usage on every day except the 1st of the month,
      // where no timestamp can be both before today and inside this month —
      // dailyIsExclusive (computed above from the same GREATEST clamp used to
      // pick chosenDaily) tracks which case this run landed in.
      const [dailyUsage] = await dataSource.query(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total
           FROM ledger_entries
          WHERE account_id = $1
            AND direction = 'debit'
            AND posted_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila'`,
        [sender.account_id],
      );
      expect(Number(dailyUsage.total)).toBe(dailyIsExclusive ? 0 : 4_999_900);

      // The near-month-start entry (4,999,900) always falls inside the
      // current calendar month and must always count; only the 35-days-ago
      // entry (3,999,900) should be excluded. If the monthly boundary were
      // broken and counted it too, the total below would be 8,999,800.
      const [monthlyUsage] = await dataSource.query(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total
           FROM ledger_entries
          WHERE account_id = $1
            AND direction = 'debit'
            AND posted_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila'`,
        [sender.account_id],
      );
      expect(Number(monthlyUsage.total)).toBe(4_999_900);
    } finally {
      // ledger_entries is append-only (trg_ledger_entries_immutable rejects
      // every UPDATE/DELETE unconditionally, and the FK from ledger_entries to
      // transfers is ON DELETE RESTRICT), so the backdated rows above can never
      // be removed. Undo their effect the same way the schema's own comments
      // prescribe corrections be made: a compensating reversal pair, posted
      // now with transfer_id NULL (a manual adjustment, not a transfer) so it
      // is invisible to getUsage()'s `transfer_id IS NOT NULL` filter and
      // therefore can't itself pollute another test's limit-usage window. This
      // restores accounts.balance_minor for Arturo and Ethan; it leaves two
      // harmless, correctly-dated historical transfers/ledger rows behind,
      // which no assertion in this file depends on the absence of.
      await dataSource.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount_minor)
         VALUES
           (NULL, $1, 'credit', $2),
           (NULL, $3, 'debit',  $2)`,
        [sender.account_id, 4_999_900, destination.account_id],
      );
      await dataSource.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount_minor)
         VALUES
           (NULL, $1, 'credit', $2),
           (NULL, $3, 'debit',  $2)`,
        [sender.account_id, 3_999_900, destination.account_id],
      );
      await dataSource.query(
        `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2`,
        [4_999_900 + 3_999_900, sender.account_id],
      );
      await dataSource.query(
        `UPDATE accounts SET balance_minor = balance_minor - $1 WHERE id = $2`,
        [4_999_900 + 3_999_900, destination.account_id],
      );
    }
  });

  it('leaves /health outside the envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok', database: 'connected' });
  });
});
