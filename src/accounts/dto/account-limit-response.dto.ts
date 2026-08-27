import { ApiProperty } from '@nestjs/swagger';
import type { Currency } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';

/**
 * Limits are per holder and apply across every account they own, so `used`
 * is summed over all of the holder's accounts, not just the one in the path.
 *
 * Every money figure is reported twice: a fixed 2-decimal peso string for
 * display, and the exact centavo integer to compute with. Clients that compare
 * a requested amount against the remaining headroom must use the *Minor values,
 * since comparing decimal strings is not arithmetic.
 */
export class AccountLimitResponseDto {
  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  @ApiProperty({ example: '5000.00', type: String })
  dailyLimit: string;

  @ApiProperty({ description: 'PHP centavos.', example: 500_000 })
  dailyLimitMinor: number;

  @ApiProperty({ example: '50000.00', type: String })
  monthlyLimit: string;

  @ApiProperty({ description: 'PHP centavos.', example: 5_000_000 })
  monthlyLimitMinor: number;

  @ApiProperty({ example: '1500.00', type: String })
  dailyUsed: string;

  @ApiProperty({
    description: 'Outbound total already posted in the current day window.',
    example: 150_000,
  })
  dailyUsedMinor: number;

  @ApiProperty({ example: '4500.00', type: String })
  monthlyUsed: string;

  @ApiProperty({
    description: 'Outbound total already posted in the current month window.',
    example: 450_000,
  })
  monthlyUsedMinor: number;

  @ApiProperty({ example: '3500.00', type: String })
  dailyRemaining: string;

  @ApiProperty({
    description: 'dailyLimitMinor - dailyUsedMinor, floored at 0.',
    example: 350_000,
  })
  dailyRemainingMinor: number;

  @ApiProperty({ example: '45500.00', type: String })
  monthlyRemaining: string;

  @ApiProperty({
    description: 'monthlyLimitMinor - monthlyUsedMinor, floored at 0.',
    example: 4_550_000,
  })
  monthlyRemainingMinor: number;

  /**
   * Reported so clients can tell when the day/month windows roll over. The
   * same for every holder — a product-wide constant, not stored per row.
   */
  @ApiProperty({
    description:
      'IANA zone whose midnight defines the day/month boundaries. Not UTC.',
    example: 'Asia/Manila',
  })
  periodTimezone: string;

  /**
   * Builds the paired peso/centavo view from centavo figures. Kept here so the
   * two representations cannot drift apart at a call site.
   */
  static from(input: {
    currency: Currency;
    dailyLimitMinor: number;
    monthlyLimitMinor: number;
    dailyUsedMinor: number;
    monthlyUsedMinor: number;
    dailyRemainingMinor: number;
    monthlyRemainingMinor: number;
    periodTimezone: string;
  }): AccountLimitResponseDto {
    return {
      currency: input.currency,
      dailyLimit: minorToPesos(input.dailyLimitMinor),
      dailyLimitMinor: input.dailyLimitMinor,
      monthlyLimit: minorToPesos(input.monthlyLimitMinor),
      monthlyLimitMinor: input.monthlyLimitMinor,
      dailyUsed: minorToPesos(input.dailyUsedMinor),
      dailyUsedMinor: input.dailyUsedMinor,
      monthlyUsed: minorToPesos(input.monthlyUsedMinor),
      monthlyUsedMinor: input.monthlyUsedMinor,
      dailyRemaining: minorToPesos(input.dailyRemainingMinor),
      dailyRemainingMinor: input.dailyRemainingMinor,
      monthlyRemaining: minorToPesos(input.monthlyRemainingMinor),
      monthlyRemainingMinor: input.monthlyRemainingMinor,
      periodTimezone: input.periodTimezone,
    };
  }
}
