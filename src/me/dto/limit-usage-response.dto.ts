import { ApiProperty } from '@nestjs/swagger';
import type { Currency } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';

/**
 * Limit usage, flattened.
 *
 * Direction lives in the key name (`dailyDebitUsedMinor`) rather than in a
 * nested daily/monthly array, so a client reads one property instead of
 * filtering a list to find the figure it wants.
 *
 * Every money figure appears twice: a fixed 2-decimal peso string to display,
 * and the exact centavo integer to compute with. Comparing decimal strings is
 * not arithmetic, so anything doing sums must use the *Minor values.
 *
 * Limits belong to the holder and apply across every account they own, so the
 * usage here spans all of them.
 */
export class LimitUsageResponseDto {
  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  /**
   * Reported so a client can tell when the windows roll over. The same for
   * every holder — a product-wide constant, not stored per row.
   */
  @ApiProperty({
    description:
      'IANA zone whose midnight defines the day/month boundaries. Not UTC.',
    example: 'Asia/Manila',
  })
  periodTimezone: string;

  @ApiProperty({ example: '50000.00', type: String })
  dailyLimit: string;

  @ApiProperty({ description: 'PHP centavos.', example: 5_000_000 })
  dailyLimitMinor: number;

  @ApiProperty({ example: '500000.00', type: String })
  monthlyLimit: string;

  @ApiProperty({ description: 'PHP centavos.', example: 50_000_000 })
  monthlyLimitMinor: number;

  @ApiProperty({ example: '1500.00', type: String })
  dailyDebitUsed: string;

  @ApiProperty({
    description: 'Sent today, counting only transfer-linked entries.',
    example: 150_000,
  })
  dailyDebitUsedMinor: number;

  @ApiProperty({ example: '48500.00', type: String })
  dailyDebitRemaining: string;

  @ApiProperty({
    description: 'dailyLimitMinor - dailyDebitUsedMinor, floored at 0.',
    example: 4_850_000,
  })
  dailyDebitRemainingMinor: number;

  @ApiProperty({ example: '1500.00', type: String })
  monthlyDebitUsed: string;

  @ApiProperty({ description: 'Sent this month.', example: 150_000 })
  monthlyDebitUsedMinor: number;

  @ApiProperty({ example: '498500.00', type: String })
  monthlyDebitRemaining: string;

  @ApiProperty({
    description: 'monthlyLimitMinor - monthlyDebitUsedMinor, floored at 0.',
    example: 49_850_000,
  })
  monthlyDebitRemainingMinor: number;

  @ApiProperty({ example: '0.00', type: String })
  dailyCreditUsed: string;

  @ApiProperty({ description: 'Received today.', example: 0 })
  dailyCreditUsedMinor: number;

  @ApiProperty({ example: '50000.00', type: String })
  dailyCreditRemaining: string;

  @ApiProperty({
    description: 'dailyLimitMinor - dailyCreditUsedMinor, floored at 0.',
    example: 5_000_000,
  })
  dailyCreditRemainingMinor: number;

  @ApiProperty({ example: '0.00', type: String })
  monthlyCreditUsed: string;

  @ApiProperty({ description: 'Received this month.', example: 0 })
  monthlyCreditUsedMinor: number;

  @ApiProperty({ example: '500000.00', type: String })
  monthlyCreditRemaining: string;

  @ApiProperty({
    description: 'monthlyLimitMinor - monthlyCreditUsedMinor, floored at 0.',
    example: 50_000_000,
  })
  monthlyCreditRemainingMinor: number;

  /**
   * Builds the paired peso/centavo view from centavo figures, so the two
   * representations cannot drift apart at a call site.
   */
  static from(input: {
    currency: Currency;
    periodTimezone: string;
    dailyLimitMinor: number;
    monthlyLimitMinor: number;
    debit: {
      dailyUsedMinor: number;
      monthlyUsedMinor: number;
      dailyRemainingMinor: number;
      monthlyRemainingMinor: number;
    };
    credit: {
      dailyUsedMinor: number;
      monthlyUsedMinor: number;
      dailyRemainingMinor: number;
      monthlyRemainingMinor: number;
    };
  }): LimitUsageResponseDto {
    return {
      currency: input.currency,
      periodTimezone: input.periodTimezone,

      dailyLimit: minorToPesos(input.dailyLimitMinor),
      dailyLimitMinor: input.dailyLimitMinor,
      monthlyLimit: minorToPesos(input.monthlyLimitMinor),
      monthlyLimitMinor: input.monthlyLimitMinor,

      dailyDebitUsed: minorToPesos(input.debit.dailyUsedMinor),
      dailyDebitUsedMinor: input.debit.dailyUsedMinor,
      dailyDebitRemaining: minorToPesos(input.debit.dailyRemainingMinor),
      dailyDebitRemainingMinor: input.debit.dailyRemainingMinor,
      monthlyDebitUsed: minorToPesos(input.debit.monthlyUsedMinor),
      monthlyDebitUsedMinor: input.debit.monthlyUsedMinor,
      monthlyDebitRemaining: minorToPesos(input.debit.monthlyRemainingMinor),
      monthlyDebitRemainingMinor: input.debit.monthlyRemainingMinor,

      dailyCreditUsed: minorToPesos(input.credit.dailyUsedMinor),
      dailyCreditUsedMinor: input.credit.dailyUsedMinor,
      dailyCreditRemaining: minorToPesos(input.credit.dailyRemainingMinor),
      dailyCreditRemainingMinor: input.credit.dailyRemainingMinor,
      monthlyCreditUsed: minorToPesos(input.credit.monthlyUsedMinor),
      monthlyCreditUsedMinor: input.credit.monthlyUsedMinor,
      monthlyCreditRemaining: minorToPesos(input.credit.monthlyRemainingMinor),
      monthlyCreditRemainingMinor: input.credit.monthlyRemainingMinor,
    };
  }
}
