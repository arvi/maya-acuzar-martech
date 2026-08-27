import { EntityManager } from 'typeorm';
import { SendMoneyRuleViolation } from '../common/errors/send-money-error';
import { MeService } from './me.service';

const IDENTITY = {
  authIdentityId: 1,
  accountHolderId: 7,
  subject: 'seed-adelaida-magtalas',
  username: 'adelaida.magtalas',
  displayName: 'Adelaida Magtalas',
  holderStatus: 'active',
};

const USAGE = {
  dailyDebitRemainingMinor: 4_850_000,
  monthlyDebitRemainingMinor: 49_850_000,
};

describe('MeService.getProfile', () => {
  let resolver: { resolveByHolder: jest.Mock };
  let limitUsage: { forHolder: jest.Mock };
  let service: MeService;
  const manager = {} as EntityManager;

  beforeEach(() => {
    resolver = {
      resolveByHolder: jest.fn().mockResolvedValue({
        ok: true,
        party: {
          accountId: 3,
          accountHolderId: 7,
          displayName: 'Adelaida Magtalas',
          balanceMinor: 74_850_000,
          accountStatus: 'active',
          holderStatus: 'active',
        },
      }),
    };
    limitUsage = { forHolder: jest.fn().mockResolvedValue(USAGE) };
    service = new MeService(
      resolver as never,
      limitUsage as never,
      { manager } as never,
    );
  });

  it('reports the holder profile and the balance of their active account', async () => {
    const me = await service.getProfile(IDENTITY);

    expect(me.displayName).toBe('Adelaida Magtalas');
    expect(me.username).toBe('adelaida.magtalas');
    expect(me.balanceMinor).toBe(74_850_000);
    expect(me.balance).toBe('748500.00');
    expect(me.currency).toBe('PHP');
  });

  it('summarises remaining headroom from the same source as /me/limits', async () => {
    const me = await service.getProfile(IDENTITY);

    expect(limitUsage.forHolder).toHaveBeenCalledWith(7, manager);
    expect(me.limits.dailyRemainingMinor).toBe(4_850_000);
    expect(me.limits.monthlyRemaining).toBe('498500.00');
  });

  it('resolves the account by holder, never by an id from the caller', async () => {
    await service.getProfile(IDENTITY);

    expect(resolver.resolveByHolder).toHaveBeenCalledWith(7, manager, 'sender');
  });

  it('surfaces an unusable account as a rule violation rather than guessing', async () => {
    resolver.resolveByHolder.mockResolvedValue({
      ok: false,
      code: 'SENDER_AMBIGUOUS_ACCOUNT',
      details: { accountCount: 2 },
    });

    // Picking one of several accounts to report would eventually report the
    // wrong balance, and the holder has no way to tell which it chose.
    await expect(service.getProfile(IDENTITY)).rejects.toBeInstanceOf(
      SendMoneyRuleViolation,
    );
  });
});
