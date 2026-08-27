import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Currency, LedgerDirection } from '../../common/domain.types';
import { SUPPORTED_CURRENCY } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';

/**
 * One posted transfer, from the perspective of the authenticated holder.
 *
 * Mirrors the send-money receipt so a client renders a completed transfer and
 * a historical one with the same code, adding only what history needs:
 * `direction`, and a counterparty that may be either party.
 */
export class TransactionHistoryItemDto {
  /**
   * The transfer's public_id, as handed back at send time. Safe as an output:
   * it is a receipt for something that happened, and no write endpoint accepts
   * one as input.
   */
  @ApiProperty({ format: 'uuid' })
  reference: string;

  @ApiProperty({
    enum: ['debit', 'credit'],
    description:
      "'debit' means the holder sent this money; 'credit' means they received it.",
    example: 'debit',
  })
  direction: LedgerDirection;

  /** The other party: recipient on a debit, sender on a credit. */
  @ApiProperty({ example: 'Ethan Del Rosario' })
  counterpartyName: string;

  @ApiProperty({ example: '1500.00', type: String })
  amount: string;

  @ApiProperty({ description: 'PHP centavos.', example: 150_000 })
  amountMinor: number;

  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  @ApiPropertyOptional({
    nullable: true,
    description: 'NULL when the sender attached no note.',
    example: 'Lunch',
  })
  note: string | null;

  @ApiProperty({ example: '2026-08-27T09:16:12.000Z' })
  postedAt: Date;

  static from(row: {
    reference: string;
    direction: LedgerDirection;
    counterpartyName: string;
    amountMinor: number;
    note: string | null;
    postedAt: Date;
  }): TransactionHistoryItemDto {
    return {
      reference: row.reference,
      direction: row.direction,
      counterpartyName: row.counterpartyName,
      amount: minorToPesos(row.amountMinor),
      amountMinor: row.amountMinor,
      currency: SUPPORTED_CURRENCY,
      note: row.note,
      postedAt: row.postedAt,
    };
  }
}
