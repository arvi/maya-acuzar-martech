import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  AccountLimitsService,
  LimitDirection,
} from '../accounts/account-limits.service';
import { AccountLimit } from '../accounts/entities/account-limit.entity';
import {
  SendMoneyError,
  SendMoneyErrorCode,
} from '../common/errors/send-money-error';
import { minorToPesos } from '../common/money';
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
