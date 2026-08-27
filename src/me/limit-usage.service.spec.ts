import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AccountLimit } from '../accounts/entities/account-limit.entity';
import { LimitUsageService } from './limit-usage.service';

const LIMIT = {
  accountHolderId: 1,
  currency: 'PHP',
  dailyLimitMinor: 5_000_000,
  monthlyLimitMinor: 50_000_000,
} as AccountLimit;

describe('LimitUsageService.forHolder', () => {
  let limits: {
    findByHolder: jest.Mock;
    evaluate: jest.Mock;
  };
  let service: LimitUsageService;
  const manager = {} as EntityManager;

  beforeEach(() => {
    limits = {
      findByHolder: jest.fn().mockResolvedValue(LIMIT),
      evaluate: jest.fn().mockImplementation((limit, _manager, direction) =>
        Promise.resolve(
          direction === 'debit'
            ? {
                limit,
                dailyUsedMinor: 150_000,
                monthlyUsedMinor: 150_000,
                dailyRemainingMinor: 4_850_000,
                monthlyRemainingMinor: 49_850_000,
              }
            : {
                limit,
                dailyUsedMinor: 0,
                monthlyUsedMinor: 0,
                dailyRemainingMinor: 5_000_000,
                monthlyRemainingMinor: 50_000_000,
              },
        ),
      ),
    };
    service = new LimitUsageService(limits as never);
  });

  it('reports both directions against the same limit columns', async () => {
    const usage = await service.forHolder(1, manager);

    expect(limits.evaluate).toHaveBeenCalledWith(LIMIT, manager, 'debit');
    expect(limits.evaluate).toHaveBeenCalledWith(LIMIT, manager, 'credit');

    expect(usage.dailyDebitUsedMinor).toBe(150_000);
    expect(usage.dailyCreditUsedMinor).toBe(0);
    expect(usage.dailyDebitRemainingMinor).toBe(4_850_000);
    expect(usage.dailyCreditRemainingMinor).toBe(5_000_000);
  });

  it('is keyed by holder id, so a service-to-service caller needs no token', async () => {
    await service.forHolder(42, manager);

    expect(limits.findByHolder).toHaveBeenCalledWith(42);
  });

  it('pairs every centavo figure with a peso string', async () => {
    const usage = await service.forHolder(1, manager);

    expect(usage.dailyLimit).toBe('50000.00');
    expect(usage.dailyDebitUsed).toBe('1500.00');
    expect(usage.monthlyDebitRemaining).toBe('498500.00');
    expect(usage.currency).toBe('PHP');
    expect(usage.periodTimezone).toBe('Asia/Manila');
  });

  it('rejects a holder with no configured limits rather than inventing zeros', async () => {
    limits.findByHolder.mockResolvedValue(null);

    // Returning zero limits would be indistinguishable from a real zero, and
    // returning unlimited headroom would be worse. This is a data problem.
    await expect(service.forHolder(1, manager)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    await expect(service.forHolder(1, manager)).rejects.toMatchObject({
      response: { code: 'LIMITS_NOT_CONFIGURED' },
    });
  });
});
