import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Validate,
} from 'class-validator';
import { ExactlyOneAmountConstraint } from '../../common/validators/exactly-one-amount.validator';
import { IsPesoAmount } from '../../common/validators/is-peso-amount.validator';

export class CreateTransferDto {
  @ApiPropertyOptional({
    description: 'public_id of the account funds are debited from.',
    format: 'uuid',
  })
  @IsUUID()
  // Hosts the amount/amountMinor pair check. It must sit on a required field:
  // on an @IsOptional() property, class-validator skips every decorator when
  // the value is absent, so a body omitting both amounts would slip through.
  @Validate(ExactlyOneAmountConstraint)
  sourceAccountId: string;

  @ApiPropertyOptional({
    description: 'public_id of the account funds are credited to.',
    format: 'uuid',
  })
  @IsUUID()
  destinationAccountId: string;

  /**
   * Pesos. The preferred field, and preferably sent as a string.
   *
   * A JSON number is an IEEE-754 double, so any arithmetic the client did
   * before serializing can arrive already wrong — `0.1 + 0.2` serializes as
   * 0.30000000000000004, and a 12% VAT calculation as 11.9988. Sending the
   * amount as text keeps a value that originated as text (a form field, a
   * NUMERIC column, an upstream API) from ever passing through a double.
   *
   * Numbers are still accepted: a literal like 100.23 round-trips exactly, and
   * both forms are parsed off the decimal string rather than by multiplying.
   * Either way, more than two decimal places is rejected rather than rounded.
   *
   * After validation this property holds an integer number of centavos.
   */
  @ApiPropertyOptional({
    description:
      'Amount in PHP with at most 2 decimal places. Prefer a string ("100.23") over a number to avoid client-side float rounding. Mutually exclusive with amountMinor — send one or the other.',
    example: '100.23',
    type: String,
    pattern: '^\\d+(\\.\\d{1,2})?$',
  })
  @IsOptional()
  @IsPesoAmount()
  amount?: number;

  /**
   * The same amount in centavos, for callers that already work in minor units
   * and would rather not round-trip through a decimal string. Integer only —
   * a centavo is the atomic unit, so there is nothing to round here.
   */
  @ApiPropertyOptional({
    description:
      'Amount in PHP centavos (100 = PHP 1.00). Integer only. Mutually exclusive with amount — send one or the other.',
    example: 10_023,
    type: Number,
    minimum: 1,
  })
  @IsOptional()
  @IsInt({ message: 'amountMinor must be a whole number of centavos.' })
  @IsPositive({ message: 'amountMinor must be greater than zero.' })
  amountMinor?: number;

  @ApiPropertyOptional({
    description:
      'Caller-supplied key making a retry safe. Replaying the same key from the same identity returns the original transfer instead of moving money twice.',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;

  /**
   * The amount in centavos, whichever field the caller used. Both are already
   * normalised to centavos by validation, so this is just the non-empty one.
   *
   * A method rather than a getter: class-transformer would treat a getter as a
   * property and try to serialize it.
   */
  resolvedAmountMinor(): number {
    const resolved = this.amount ?? this.amountMinor;

    // ExactlyOneAmountConstraint guarantees this, so reaching it means the DTO
    // was built without validation. Throwing beats returning undefined and
    // letting it reach the ledger as NaN.
    if (resolved === undefined || resolved === null) {
      throw new Error(
        'CreateTransferDto has neither amount nor amountMinor; it was not validated.',
      );
    }

    return resolved;
  }
}
