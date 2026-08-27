import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { CurrentIdentity } from '../auth/decorators/current-identity.decorator';
import type { AuthenticatedIdentity } from '../auth/identity.types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { LimitUsageResponseDto } from './dto/limit-usage-response.dto';
import { MeResponseDto } from './dto/me-response.dto';
import { TransactionHistoryQueryDto } from './dto/transaction-history-query.dto';
import { TransactionHistoryItemDto } from './dto/transaction-history-response.dto';
import { LimitUsageService } from './limit-usage.service';
import { MeService } from './me.service';
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  TransactionHistoryService,
} from './transaction-history.service';

/**
 * Everything here is addressed by the access token. No route accepts an
 * account identifier — public or internal — which is what keeps account
 * identity out of the API surface entirely.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    private readonly meService: MeService,
    private readonly limitUsage: LimitUsageService,
    private readonly history: TransactionHistoryService,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  @Get()
  @ResponseMessage('Profile retrieved.')
  @ApiOperation({
    summary: 'The authenticated holder, their balance and remaining headroom',
    description:
      'Derived entirely from the access token. The `limits` block is a summary; GET /v1/me/limits carries the full per-direction breakdown.',
  })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiUnprocessableEntityResponse({
    description:
      'The holder has no active account, or more than one (SENDER_NO_ACTIVE_ACCOUNT / SENDER_AMBIGUOUS_ACCOUNT).',
  })
  getProfile(
    @CurrentIdentity() identity: AuthenticatedIdentity,
  ): Promise<MeResponseDto> {
    return this.meService.getProfile(identity);
  }

  @Get('limits')
  @ResponseMessage('Limit usage retrieved.')
  @ApiOperation({
    summary: 'Send and receive limit usage',
    description:
      'Limits belong to the holder and apply across every account they own, so usage spans all of them.\n\n' +
      'The same daily and monthly ceilings bound both directions independently: outbound sends and inbound receipts each get the full limit.\n\n' +
      'Only transfer-linked ledger entries count — an opening balance or a manual adjustment never consumes headroom.\n\n' +
      'The response is flat: direction is part of each key, so no client-side grouping is needed.',
  })
  @ApiOkResponse({ type: LimitUsageResponseDto })
  @ApiNotFoundResponse({
    description:
      'No limits are configured for this holder (LIMITS_NOT_CONFIGURED).',
  })
  getLimits(
    @CurrentIdentity() identity: AuthenticatedIdentity,
  ): Promise<LimitUsageResponseDto> {
    return this.limitUsage.forHolder(
      identity.accountHolderId,
      this.accountRepository.manager,
    );
  }

  @Get('transactions')
  @ResponseMessage('Transaction history retrieved.')
  @ApiOperation({
    summary: 'Posted transfers, newest first',
    description:
      `Without a date range, the latest ${DEFAULT_HISTORY_LIMIT} transactions. With one, up to ${MAX_HISTORY_LIMIT}.\n\n` +
      '`from` and `to` are optional and independent, given as Manila calendar days (YYYY-MM-DD). `to` includes the whole of that day, so a transfer at 23:30 PHT on the `to` date is in range.\n\n' +
      "`direction` is from the holder's own perspective: `debit` is money they sent, `credit` money they received, and `counterpartyName` is the other party either way.\n\n" +
      'An empty array means no transactions yet.',
  })
  @ApiOkResponse({ type: [TransactionHistoryItemDto] })
  getTransactions(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Query() query: TransactionHistoryQueryDto,
  ): Promise<TransactionHistoryItemDto[]> {
    return this.history.forHolder(
      identity.accountHolderId,
      this.accountRepository.manager,
      query,
    );
  }
}
