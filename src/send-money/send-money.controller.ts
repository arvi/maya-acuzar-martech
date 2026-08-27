import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentIdentity } from '../auth/decorators/current-identity.decorator';
import type { AuthenticatedIdentity } from '../auth/identity.types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { ResolutionResponseDto } from './dto/resolution-response.dto';
import { ResolveTransferDto } from './dto/resolve-transfer.dto';
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
      url: 'https://github.com/#docs/SEND-MONEY.md',
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
}
