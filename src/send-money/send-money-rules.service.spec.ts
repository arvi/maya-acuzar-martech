import { EntityManager } from 'typeorm';
import { AccountLimitsService } from '../accounts/account-limits.service';
import { SendMoneyErrorCode } from '../common/errors/send-money-error';
import {
  RecipientResolverService,
  ResolvedParty,
} from './recipient-resolver.service';
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
      resolveByHolder: jest
        .fn()
        .mockResolvedValue({ ok: true, party: party() }),
      resolveByLookup: jest.fn().mockResolvedValue({
        ok: true,
        party: party({
          accountId: 2,
          accountHolderId: 2,
          displayName: 'Ethan Del Rosario',
        }),
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
    const result = await service.evaluate(
      input,
      manager as unknown as EntityManager,
    );

    expect(result.errors).toEqual([]);
    expect(result.sender?.accountId).toBe(1);
    expect(result.recipient?.accountId).toBe(2);
  });

  it('reports insufficient funds with the numbers behind it', async () => {
    resolver.resolveByHolder.mockResolvedValue({
      ok: true,
      party: party({ balanceMinor: 100 }),
    });

    const result = await service.evaluate(
      input,
      manager as unknown as EntityManager,
    );

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

    const result = await service.evaluate(
      input,
      manager as unknown as EntityManager,
    );

    expect(codesFrom(result)).not.toContain(
      SendMoneyErrorCode.SenderDailyLimitExceeded,
    );
  });

  it('rejects one centavo over the daily limit', async () => {
    limits.getUsage.mockResolvedValue({
      dailyUsedMinor: LIMIT.dailyLimitMinor - 150_000 + 1,
      monthlyUsedMinor: 0,
    });

    const result = await service.evaluate(
      input,
      manager as unknown as EntityManager,
    );

    expect(codesFrom(result)).toContain(
      SendMoneyErrorCode.SenderDailyLimitExceeded,
    );
  });

  it('measures the sender outbound and the recipient inbound', async () => {
    await service.evaluate(input, manager as unknown as EntityManager);

    const directions = limits.getUsage.mock.calls.map(
      ([, , direction]) => direction,
    );
    expect(directions).toEqual(expect.arrayContaining(['debit', 'credit']));
  });

  it('reports the recipient limit separately from the sender one', async () => {
    limits.getUsage.mockImplementation(
      async (_holder: number, _manager: unknown, direction: string) =>
        direction === 'credit'
          ? { dailyUsedMinor: LIMIT.dailyLimitMinor, monthlyUsedMinor: 0 }
          : { dailyUsedMinor: 0, monthlyUsedMinor: 0 },
    );

    const result = await service.evaluate(
      input,
      manager as unknown as EntityManager,
    );

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

    const result = await service.evaluate(
      input,
      manager as unknown as EntityManager,
    );

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

    const result = await service.evaluate(
      input,
      manager as unknown as EntityManager,
    );

    expect(codesFrom(result)).toEqual([SendMoneyErrorCode.RecipientNotFound]);
  });

  it('rejects sending to yourself', async () => {
    resolver.resolveByLookup.mockResolvedValue({
      ok: true,
      party: party({ accountId: 1, accountHolderId: 1 }),
    });

    const result = await service.evaluate(
      input,
      manager as unknown as EntityManager,
    );

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
