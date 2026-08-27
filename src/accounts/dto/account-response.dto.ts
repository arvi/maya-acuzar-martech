import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AccountStatus, Currency } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';
import type { Account } from '../entities/account.entity';

export class AccountResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ nullable: true })
  accountNumber: string | null;

  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  /** Fixed 2-decimal string so clients need not divide by 100 themselves. */
  @ApiProperty({
    description: 'Balance in PHP, always 2 decimal places.',
    example: '10000.00',
    type: String,
  })
  balance: string;

  @ApiProperty({
    description: 'The same balance in PHP centavos; use this for arithmetic.',
    example: 1_000_000,
  })
  balanceMinor: number;

  @ApiProperty({ enum: ['active', 'suspended', 'closed'] })
  status: AccountStatus;

  @ApiProperty()
  createdAt: Date;

  static from(account: Account): AccountResponseDto {
    return {
      id: account.publicId,
      accountNumber: account.accountNumber,
      currency: account.currency,
      balance: minorToPesos(account.balanceMinor),
      balanceMinor: account.balanceMinor,
      status: account.status,
      createdAt: account.createdAt,
    };
  }
}
