import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import type { AuthenticatedIdentity } from '../auth/identity.types';
import {
  SendMoneyErrorCode,
  SendMoneyRuleViolation,
} from '../common/errors/send-money-error';
import { RecipientResolverService } from '../send-money/recipient-resolver.service';
import { MeResponseDto } from './dto/me-response.dto';
import { LimitUsageService } from './limit-usage.service';

/** Messages for the account conditions /me can hit. */
const ACCOUNT_MESSAGES: Partial<Record<SendMoneyErrorCode, string>> = {
  [SendMoneyErrorCode.SenderNoActiveAccount]: 'You have no active account.',
  [SendMoneyErrorCode.SenderAmbiguousAccount]:
    'You have more than one active account.',
};

@Injectable()
export class MeService {
  constructor(
    private readonly resolver: RecipientResolverService,
    private readonly limitUsage: LimitUsageService,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  /**
   * The authenticated holder's profile, balance and headroom summary.
   *
   * The account is resolved by the same rule send-money uses — the holder's
   * single active account — so /me and a transfer can never disagree about
   * which account is "yours".
   */
  async getProfile(identity: AuthenticatedIdentity): Promise<MeResponseDto> {
    const { manager } = this.accountRepository;

    const outcome = await this.resolver.resolveByHolder(
      identity.accountHolderId,
      manager,
      'sender',
    );

    if (!outcome.ok) {
      // Deliberately not "pick the first account". Reporting a balance for one
      // of several accounts would eventually report the wrong one, and the
      // holder has no way to tell which was chosen.
      throw new SendMoneyRuleViolation(
        [
          {
            code: outcome.code,
            message:
              ACCOUNT_MESSAGES[outcome.code] ??
              'Your account cannot be used at this time.',
            details: outcome.details,
          },
        ],
        'Account unavailable.',
      );
    }

    const usage = await this.limitUsage.forHolder(
      identity.accountHolderId,
      manager,
    );

    return MeResponseDto.from({
      displayName: outcome.party.displayName,
      username: identity.username,
      balanceMinor: outcome.party.balanceMinor,
      dailyRemainingMinor: usage.dailyDebitRemainingMinor,
      monthlyRemainingMinor: usage.monthlyDebitRemainingMinor,
    });
  }
}
