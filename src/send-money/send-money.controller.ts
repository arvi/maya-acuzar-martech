import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentIdentity } from '../auth/decorators/current-identity.decorator';
import type { AuthenticatedIdentity } from '../auth/identity.types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { ExecuteTransferDto } from './dto/execute-transfer.dto';
import { ResolutionResponseDto } from './dto/resolution-response.dto';
import { ResolveTransferDto } from './dto/resolve-transfer.dto';
import { SendMoneyReceiptDto } from './dto/send-money-receipt.dto';
import { SendMoneyService } from './send-money.service';

@ApiTags('Send Money')
@ApiBearerAuth()
@Controller({ path: 'send-money', version: '1' })
export class SendMoneyController {
  constructor(private readonly sendMoneyService: SendMoneyService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Recipient resolved.')
  @ApiOperation({
    summary: 'Validate a transfer and get a confirmation token',
    description:
      'Checks the sender balance and limits, resolves the recipient from a username or mobile number, and checks their status and receiving limits.\n\n' +
      'Every failed condition is reported at once as a 422 with an `errors` array, so a confirmation screen can show them all.\n\n' +
      'On success the `resolutionToken` is valid for 120 seconds. It is re-validated on POST /v1/send-money — a stale token is expected to fail, and every rule is re-run against live balances before money moves.',
    externalDocs: {
      description: 'Scenario walkthrough',
      url: 'https://github.com/#docs/SEND_MONEY.md',
    },
  })
  @ApiOkResponse({
    type: ResolutionResponseDto,
    schema: {
      example: {
        statusCode: 200,
        data: {
          resolutionToken: 'eyJhbGci…',
          expiresAt: '2026-08-27T09:17:00.000Z',
          recipient: { displayName: 'Ethan Del Rosario' },
          amount: '1500.00',
          amountMinor: 150000,
          currency: 'PHP',
          note: 'Lunch',
        },
        message: 'Recipient resolved.',
        timestamp: '2026-08-27T09:15:00.000Z',
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description: 'One or more conditions failed.',
    content: {
      'application/json': {
        examples: {
          insufficientFunds: {
            summary: 'Balance too low',
            value: {
              statusCode: 422,
              data: {
                errors: [
                  {
                    code: 'INSUFFICIENT_FUNDS',
                    message: 'Insufficient funds.',
                    details: { balanceMinor: 5000, requestedMinor: 150000 },
                  },
                ],
              },
              message: 'Transfer cannot proceed.',
              timestamp: '2026-08-27T09:15:00.000Z',
            },
          },
          dailyLimitExceeded: {
            summary: 'Over the sender daily limit',
            value: {
              statusCode: 422,
              data: {
                errors: [
                  {
                    code: 'SENDER_DAILY_LIMIT_EXCEEDED',
                    message:
                      'This transfer would exceed your daily sending limit.',
                    details: {
                      limitMinor: 5000000,
                      limit: '50000.00',
                      usedMinor: 4900000,
                      requestedMinor: 150000,
                    },
                  },
                ],
              },
              message: 'Transfer cannot proceed.',
              timestamp: '2026-08-27T09:15:00.000Z',
            },
          },
          recipientNotActive: {
            summary: 'Recipient is suspended (bobbie.salazar)',
            value: {
              statusCode: 422,
              data: {
                errors: [
                  {
                    code: 'RECIPIENT_NOT_ACTIVE',
                    message: 'The recipient cannot receive funds at this time.',
                    details: { status: 'suspended' },
                  },
                ],
              },
              message: 'Transfer cannot proceed.',
              timestamp: '2026-08-27T09:15:00.000Z',
            },
          },
          multipleErrors: {
            summary: 'Several conditions failed at once',
            value: {
              statusCode: 422,
              data: {
                errors: [
                  {
                    code: 'INSUFFICIENT_FUNDS',
                    message: 'Insufficient funds.',
                    details: { balanceMinor: 5000, requestedMinor: 150000 },
                  },
                  {
                    code: 'RECIPIENT_NOT_ACTIVE',
                    message: 'The recipient cannot receive funds at this time.',
                    details: { status: 'suspended' },
                  },
                ],
              },
              message: 'Transfer cannot proceed.',
              timestamp: '2026-08-27T09:15:00.000Z',
            },
          },
        },
      },
    },
  })
  resolve(
    @Body() dto: ResolveTransferDto,
    @CurrentIdentity() identity: AuthenticatedIdentity,
  ): Promise<ResolutionResponseDto> {
    return this.sendMoneyService.resolve(dto, identity);
  }

  @Post()
  @ResponseMessage('Transfer posted.')
  @ApiOperation({
    summary: 'Complete a transfer using a confirmation token',
    description:
      'Spends the `resolutionToken` from POST /v1/send-money/resolve. Every rule is re-run against live, locked balances before money moves — the token is a confirmation, not an authorisation.\n\n' +
      'The transfer, its debit/credit ledger pair, both balances and the outbox event either all commit or none do.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required. Replaying the same key returns the original transfer instead of sending twice.',
  })
  @ApiCreatedResponse({
    type: SendMoneyReceiptDto,
    schema: {
      example: {
        statusCode: 201,
        data: {
          reference: '3f2a7c18-9d4e-4c1b-9f7a-2b8e5d6c1a90',
          recipient: { name: 'Ethan Del Rosario' },
          amount: '1500.00',
          amountMinor: 150000,
          currency: 'PHP',
          note: 'Lunch',
          postedAt: '2026-08-27T09:16:12.000Z',
        },
        message: 'Transfer posted.',
        timestamp: '2026-08-27T09:16:12.000Z',
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'The resolution token expired (RESOLUTION_TOKEN_EXPIRED), is invalid, or was issued to another identity.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'A rule that passed at resolve time no longer holds — same codes, with message "Transfer no longer valid; please confirm again."',
  })
  execute(
    @Body() dto: ExecuteTransferDto,
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<SendMoneyReceiptDto> {
    return this.sendMoneyService.execute(dto, identity, idempotencyKey);
  }
}
