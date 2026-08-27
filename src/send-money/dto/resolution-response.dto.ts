import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Currency } from '../../common/domain.types';
import { SUPPORTED_CURRENCY } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';

class ResolvedRecipientDto {
  @ApiProperty({ example: 'Ethan Del Rosario' })
  displayName: string;
}

/**
 * Only the display name is returned for the recipient. No account id, no masked
 * number, no mobile: the client already knows what it typed, and echoing more
 * would reintroduce the enumeration leak this design removes.
 */
export class ResolutionResponseDto {
  @ApiProperty({
    description:
      'Opaque, short-lived. Send it back to POST /v1/send-money to complete the transfer.',
  })
  resolutionToken: string;

  @ApiProperty({ description: 'After this the token must be re-requested.' })
  expiresAt: Date;

  @ApiProperty({ type: ResolvedRecipientDto })
  recipient: ResolvedRecipientDto;

  @ApiProperty({ example: '1500.00', type: String })
  amount: string;

  @ApiProperty({ example: 150_000 })
  amountMinor: number;

  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  @ApiPropertyOptional({ nullable: true, example: 'Lunch' })
  note: string | null;

  static from(params: {
    token: string;
    expiresAt: Date;
    displayName: string;
    amountMinor: number;
    note: string | null;
  }): ResolutionResponseDto {
    return {
      resolutionToken: params.token,
      expiresAt: params.expiresAt,
      recipient: { displayName: params.displayName },
      amount: minorToPesos(params.amountMinor),
      amountMinor: params.amountMinor,
      currency: SUPPORTED_CURRENCY,
      note: params.note,
    };
  }
}
