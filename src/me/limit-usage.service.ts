import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AccountLimitsService } from '../accounts/account-limits.service';
import { CALENDAR_BOUNDARY_TIMEZONE } from '../common/domain.types';
import { LimitUsageResponseDto } from './dto/limit-usage-response.dto';

@Injectable()
export class LimitUsageService {
  constructor(private readonly limitsService: AccountLimitsService) {}

  /**
   * Limit usage for one holder, both directions.
   *
   * Keyed by holder id rather than by an access token or a public id: the
   * caller that has a token resolves it first, and a future service-to-service
   * endpoint passes an id it resolved its own way. Neither needs this method
   * to change.
   *
   * @throws NotFoundException LIMITS_NOT_CONFIGURED when the holder has no
   * limits row. Zeros would be indistinguishable from a real zero, and
   * unlimited headroom would be worse than either.
   */
  async forHolder(
    accountHolderId: number,
    manager: EntityManager,
  ): Promise<LimitUsageResponseDto> {
    const limit = await this.limitsService.findByHolder(accountHolderId);

    if (!limit) {
      throw new NotFoundException({
        code: 'LIMITS_NOT_CONFIGURED',
        message: 'No sending limits are configured for this account.',
      });
    }

    // Both directions measure against the same columns: outbound debits and
    // inbound credits each get the full limit, independently.
    const [debit, credit] = await Promise.all([
      this.limitsService.evaluate(limit, manager, 'debit'),
      this.limitsService.evaluate(limit, manager, 'credit'),
    ]);

    return LimitUsageResponseDto.from({
      currency: limit.currency,
      periodTimezone: CALENDAR_BOUNDARY_TIMEZONE,
      dailyLimitMinor: limit.dailyLimitMinor,
      monthlyLimitMinor: limit.monthlyLimitMinor,
      debit,
      credit,
    });
  }
}
