import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Currency, TransferStatus } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';
import type { Transfer } from '../entities/transfer.entity';

/**
 * The API boundary. Internal sequential ids (transfers.id, accounts.id) are
 * deliberately absent: they leak volume and are enumerable, which is why the
 * schema carries a separate public_id.
 */
export class TransferResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  sourceAccountId: string;

  @ApiProperty({ format: 'uuid' })
  destinationAccountId: string;

  /**
   * Returned as a fixed 2-decimal string so clients never have to divide by
   * 100 themselves — that division is where display rounding bugs start.
   * amountMinor is kept alongside it as the exact integer to compute with.
   */
  @ApiProperty({
    description: 'Amount in PHP, always 2 decimal places.',
    example: '1500.00',
    type: String,
  })
  amount: string;

  @ApiProperty({
    description: 'The same amount in PHP centavos; use this for arithmetic.',
    example: 150_000,
  })
  amountMinor: number;

  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  @ApiProperty({ enum: ['pending', 'posted', 'failed', 'reversed'] })
  status: TransferStatus;

  @ApiPropertyOptional({
    description: 'Null unless the transfer failed.',
    nullable: true,
  })
  failureReason: string | null;

  @ApiPropertyOptional({
    description: 'Null until the transfer is posted to the ledger.',
    nullable: true,
  })
  postedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  /**
   * Takes the public ids explicitly rather than reading transfer.sourceAccount,
   * so a caller cannot get a half-populated response by forgetting to join the
   * relations.
   */
  static from(
    transfer: Transfer,
    sourceAccountPublicId: string,
    destinationAccountPublicId: string,
  ): TransferResponseDto {
    return {
      id: transfer.publicId,
      sourceAccountId: sourceAccountPublicId,
      destinationAccountId: destinationAccountPublicId,
      amount: minorToPesos(transfer.amountMinor),
      amountMinor: transfer.amountMinor,
      currency: transfer.currency,
      status: transfer.status,
      failureReason: transfer.failureReason,
      postedAt: transfer.postedAt,
      createdAt: transfer.createdAt,
    };
  }
}
