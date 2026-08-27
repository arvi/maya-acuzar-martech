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

  it('leaves /health outside the envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok', database: 'connected' });
  });
});
