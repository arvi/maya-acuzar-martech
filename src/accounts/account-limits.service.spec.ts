import { EntityManager } from 'typeorm';
import { AccountLimitsService } from './account-limits.service';

describe('AccountLimitsService.getUsage', () => {
  let service: AccountLimitsService;
  let manager: { query: jest.Mock };

  beforeEach(() => {
    manager = {
      query: jest
        .fn()
        .mockResolvedValue([{ daily_used: '0', monthly_used: '0' }]),
    };
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
