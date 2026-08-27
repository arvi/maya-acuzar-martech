import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CALENDAR_BOUNDARY_TIMEZONE } from '../common/domain.types';
import { AccountLimitsService } from './account-limits.service';
import { AccountLimitResponseDto } from './dto/account-limit-response.dto';
import { AccountResponseDto } from './dto/account-response.dto';
import { Account } from './entities/account.entity';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly limitsService: AccountLimitsService,
  ) {}

  /** Lookup is by public_id: the sequential id is never part of the API. */
  async findByPublicId(publicId: string): Promise<Account> {
    const account = await this.accountRepository.findOne({
      where: { publicId },
    });

    if (!account) {
      throw new NotFoundException(`Account ${publicId} not found.`);
    }

    return account;
  }

  async getAccount(publicId: string): Promise<AccountResponseDto> {
    return AccountResponseDto.from(await this.findByPublicId(publicId));
  }

  async getLimits(publicId: string): Promise<AccountLimitResponseDto> {
    const account = await this.findByPublicId(publicId);

    const limit = await this.limitsService.findByHolder(
      account.accountHolderId,
    );
    if (!limit) {
      throw new NotFoundException(
        `No limits configured for the holder of account ${publicId}.`,
      );
    }

    const evaluation = await this.limitsService.evaluate(
      limit,
      this.accountRepository.manager,
      'debit',
    );

    return AccountLimitResponseDto.from({
      currency: limit.currency,
      dailyLimitMinor: limit.dailyLimitMinor,
      monthlyLimitMinor: limit.monthlyLimitMinor,
      dailyUsedMinor: evaluation.dailyUsedMinor,
      monthlyUsedMinor: evaluation.monthlyUsedMinor,
      dailyRemainingMinor: evaluation.dailyRemainingMinor,
      monthlyRemainingMinor: evaluation.monthlyRemainingMinor,
      periodTimezone: CALENDAR_BOUNDARY_TIMEZONE,
    });
  }
}
