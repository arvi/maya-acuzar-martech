import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Currency } from '../../common/domain.types';
import { SUPPORTED_CURRENCY } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';

class ReceiptRecipientDto {
  @ApiProperty({ example: 'Ethan Del Rosario' })
  name: string;
}

export class SendMoneyReceiptDto {
  /**
   * The transfer's public_id. Safe as an output: it is a receipt for something
   * that happened, and no write endpoint accepts it as an input.
   */
  @ApiProperty({ format: 'uuid' })
  reference: string;

  @ApiProperty({ type: ReceiptRecipientDto })
  recipient: ReceiptRecipientDto;

  @ApiProperty({ example: '1500.00', type: String })
  amount: string;

  @ApiProperty({ example: 150_000 })
  amountMinor: number;

  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  @ApiPropertyOptional({ nullable: true, example: 'Lunch' })
  note: string | null;

  @ApiProperty()
  postedAt: Date;

  static from(params: {
    reference: string;
    recipientName: string;
    amountMinor: number;
    note: string | null;
    postedAt: Date;
  }): SendMoneyReceiptDto {
    return {
      reference: params.reference,
      recipient: { name: params.recipientName },
      amount: minorToPesos(params.amountMinor),
      amountMinor: params.amountMinor,
      currency: SUPPORTED_CURRENCY,
      note: params.note,
      postedAt: params.postedAt,
    };
  }
}
