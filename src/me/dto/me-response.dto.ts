import { ApiProperty } from '@nestjs/swagger';
import type { Currency } from '../../common/domain.types';
import { SUPPORTED_CURRENCY } from '../../common/domain.types';
import { minorToPesos } from '../../common/money';

/**
 * The headline headroom figures a home screen shows. The full per-direction
 * breakdown lives at GET /v1/me/limits; both are produced by the same service,
 * so they cannot disagree.
 */
class LimitSummaryDto {
  @ApiProperty({ example: '48500.00', type: String })
  dailyRemaining: string;

  @ApiProperty({ description: 'PHP centavos.', example: 4_850_000 })
  dailyRemainingMinor: number;

  @ApiProperty({ example: '498500.00', type: String })
  monthlyRemaining: string;

  @ApiProperty({ description: 'PHP centavos.', example: 49_850_000 })
  monthlyRemainingMinor: number;
}

/** The authenticated holder: who they are, what they hold, what is left to send. */
export class MeResponseDto {
  @ApiProperty({ example: 'Adelaida Magtalas' })
  displayName: string;

  @ApiProperty({ example: 'adelaida.magtalas' })
  username: string;

  @ApiProperty({ example: '748500.00', type: String })
  balance: string;

  @ApiProperty({ description: 'PHP centavos.', example: 74_850_000 })
  balanceMinor: number;

  @ApiProperty({ example: 'PHP' })
  currency: Currency;

  @ApiProperty({ type: LimitSummaryDto })
  limits: LimitSummaryDto;

  static from(input: {
    displayName: string;
    username: string;
    balanceMinor: number;
    dailyRemainingMinor: number;
    monthlyRemainingMinor: number;
  }): MeResponseDto {
    return {
      displayName: input.displayName,
      username: input.username,
      balance: minorToPesos(input.balanceMinor),
      balanceMinor: input.balanceMinor,
      currency: SUPPORTED_CURRENCY,
      limits: {
        dailyRemaining: minorToPesos(input.dailyRemainingMinor),
        dailyRemainingMinor: input.dailyRemainingMinor,
        monthlyRemaining: minorToPesos(input.monthlyRemainingMinor),
        monthlyRemainingMinor: input.monthlyRemainingMinor,
      },
    };
  }
}
