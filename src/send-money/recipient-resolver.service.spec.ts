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
