import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransferResponseDto } from './dto/transfer-response.dto';
import { TransfersService } from './transfers.service';

@ApiTags('Transfers')
@Controller({ path: 'transfers', version: '1' })
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  @Post()
  @ApiOperation({
    summary: 'Send money between two accounts',
    description:
      'Posts atomically: the transfer, its debit/credit ledger pair, both balances and the outbox event either all commit or none do. Rejected if the source lacks funds or the holder is over their daily/monthly limit.\n\n' +
      'Supply the amount as either `amount` (pesos, up to 2 decimal places) or `amountMinor` (centavos) — exactly one, or both if they agree. ' +
      'Prefer `amount` as a JSON **string** ("100.23"): a JSON number is an IEEE-754 double, so any arithmetic done client-side before sending can arrive already wrong (0.1 + 0.2 serializes as 0.30000000000000004). ' +
      'Amounts with more than 2 decimal places are rejected, never rounded.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. Replaying the same key returns the original transfer instead of sending twice. A key in the body takes precedence over this header.',
  })
  @ApiCreatedResponse({ type: TransferResponseDto })
  @ApiBadRequestResponse({
    description: 'Malformed body, or same source and destination.',
  })
  @ApiNotFoundResponse({
    description: 'Source or destination account not found.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Insufficient funds, limit exceeded, or an account that is not active.',
  })
  create(
    @Body() dto: CreateTransferDto,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ): Promise<TransferResponseDto> {
    // Mutate the validated instance rather than spreading into a literal: a
    // spread would drop the prototype, and with it resolvedAmountMinor().
    dto.idempotencyKey = dto.idempotencyKey ?? idempotencyKeyHeader;
    const body = dto;

    // TODO: derive the initiating identity from the authenticated Keycloak
    // subject once the auth guard lands. Until then transfers are recorded as
    // system-initiated (NULL), which the schema allows and which scopes
    // idempotency keys to the system caller.
    return this.transfersService.create(body, null);
  }

  @Get(':publicId')
  @ApiOperation({ summary: 'Fetch a transfer by its public id' })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  @ApiOkResponse({ type: TransferResponseDto })
  @ApiNotFoundResponse({ description: 'No transfer with that public id.' })
  findOne(
    @Param(
      'publicId',
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND }),
    )
    publicId: string,
  ): Promise<TransferResponseDto> {
    return this.transfersService.findByPublicId(publicId);
  }
}
