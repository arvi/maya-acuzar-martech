import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthenticatedIdentity } from '../auth/identity.types';
import { SendMoneyRuleViolation } from '../common/errors/send-money-error';
import { ResolutionResponseDto } from './dto/resolution-response.dto';
import { ResolveTransferDto } from './dto/resolve-transfer.dto';
import { ResolutionTokenService } from './resolution-token.service';
import { SendMoneyRulesService } from './send-money-rules.service';

@Injectable()
export class SendMoneyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rules: SendMoneyRulesService,
    private readonly tokens: ResolutionTokenService,
  ) {}

  /**
   * Phase one. Read-only: it validates and issues a token, and moves nothing.
   */
  async resolve(
    dto: ResolveTransferDto,
    identity: AuthenticatedIdentity,
  ): Promise<ResolutionResponseDto> {
    const amountMinor = dto.resolvedAmountMinor();

    const result = await this.rules.evaluate(
      {
        senderHolderId: identity.accountHolderId,
        recipientType: dto.recipient.type,
        recipientValue: dto.recipient.value,
        amountMinor,
      },
      this.dataSource.manager,
    );

    if (result.errors.length > 0) {
      throw new SendMoneyRuleViolation(result.errors);
    }

    // Both are defined whenever errors is empty; the checks keep TypeScript
    // honest rather than guarding a reachable case.
    const sender = result.sender!;
    const recipient = result.recipient!;
    const note = dto.note ?? null;

    const { token, expiresAt } = await this.tokens.sign({
      aid: identity.authIdentityId,
      src: sender.accountId,
      dst: recipient.accountId,
      amt: amountMinor,
      note,
    });

    return ResolutionResponseDto.from({
      token,
      expiresAt,
      displayName: recipient.displayName,
      amountMinor,
      note,
    });
  }
}
