import { EntityManager } from 'typeorm';
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  TransactionHistoryService,
} from './transaction-history.service';

const ROW = {
  reference: '3f2a7c18-9d4e-4c1b-9f7a-2b8e5d6c1a90',
  direction: 'debit',
  counterparty_name: 'Ethan Del Rosario',
  amount_minor: '150000',
  note: 'Lunch',
  posted_at: new Date('2026-08-27T09:16:12.000Z'),
};

describe('TransactionHistoryService.forHolder', () => {
  let manager: { query: jest.Mock };
  let service: TransactionHistoryService;

  const sqlOf = () => manager.query.mock.calls[0][0] as string;
  const paramsOf = () => manager.query.mock.calls[0][1] as unknown[];

  beforeEach(() => {
    manager = { query: jest.fn().mockResolvedValue([ROW]) };
    service = new TransactionHistoryService();
  });

  const run = (query = {}) =>
    service.forHolder(1, manager as unknown as EntityManager, query);

  it('counts only transfer-linked entries, so it agrees with limit usage', async () => {
    await run();

    // An opening balance has no counterparty and no reference; it is also not
    // something the customer did.
    expect(sqlOf()).toContain('le.transfer_id IS NOT NULL');
  });

  it('returns only posted transfers', async () => {
    await run();

    expect(sqlOf()).toContain("t.status = 'posted'");
  });

  it('reports the direction from the holder own perspective', async () => {
    const [item] = await run();

    expect(item.direction).toBe('debit');
    expect(item.counterpartyName).toBe('Ethan Del Rosario');
  });

  it('resolves the counterparty as the other leg holder', async () => {
    await run();

    // The counterparty is whichever account on the transfer is not the one the
    // ledger entry belongs to.
    expect(sqlOf()).toContain('CASE');
    expect(sqlOf()).toContain('t.source_account_id');
    expect(sqlOf()).toContain('t.destination_account_id');
  });

  it('pairs centavos with a peso string and fixes the currency', async () => {
    const [item] = await run();

    expect(item.amountMinor).toBe(150_000);
    expect(item.amount).toBe('1500.00');
    expect(item.currency).toBe('PHP');
  });

  it('returns the latest few when no range is given', async () => {
    await run();

    expect(sqlOf()).toContain('ORDER BY le.posted_at DESC, le.id DESC');
    expect(paramsOf()).toContain(DEFAULT_HISTORY_LIMIT);
  });

  it('caps a ranged query rather than scanning without bound', async () => {
    await run({ from: '2026-08-01', to: '2026-08-27' });

    expect(paramsOf()).toContain(MAX_HISTORY_LIMIT);
  });

  it('treats from as Manila midnight', async () => {
    await run({ from: '2026-08-01' });

    expect(sqlOf()).toContain("$2::date AT TIME ZONE 'Asia/Manila'");
    expect(paramsOf()).toContain('2026-08-01');
  });

  it('includes the whole of the to day, not just its midnight', async () => {
    await run({ to: '2026-08-27' });

    // A transfer at 23:30 PHT on the 27th belongs to the 27th. Comparing
    // against the 27th at 00:00 would silently drop the entire day.
    expect(sqlOf()).toContain("+ INTERVAL '1 day'");
    expect(sqlOf()).toContain('<');
    expect(sqlOf()).not.toContain('<=');
  });

  it('scopes to the holder accounts, never to an account named by the caller', async () => {
    await run();

    expect(sqlOf()).toContain('a.account_holder_id = $1');
    expect(paramsOf()[0]).toBe(1);
  });

  it('returns an empty array when there is no history', async () => {
    manager.query.mockResolvedValue([]);

    // No history is a fact about an existing user, not a missing resource.
    await expect(run()).resolves.toEqual([]);
  });
});
