import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ExactlyOneAmountConstraint } from '../../common/validators/exactly-one-amount.validator';
import { IsPesoAmount } from '../../common/validators/is-peso-amount.validator';
import type { RecipientLookupType } from '../recipient-resolver.service';

/**
 * How the sender named the recipient. The client already knows which kind of
 * value the user typed, so the discriminator is trusted and the value is
 * validated against it rather than sniffed.
 */
export class RecipientRefDto {
  @ApiProperty({ enum: ['username', 'mobileNumber'], example: 'username' })
  @IsIn(['username', 'mobileNumber'])
  type: RecipientLookupType;

  @ApiProperty({ example: 'ethan.delrosario' })
  @IsString()
  @MaxLength(255)
  // The format check applies only when type says this is a mobile number.
  // @ValidateIf rather than the `groups` option: class-validator runs a
  // grouped decorator only when that group is requested, and the global pipe
  // passes none — so a groups-based rule would silently never fire.
  @ValidateIf((ref: RecipientRefDto) => ref.type === 'mobileNumber')
  @Matches(/^09\d{9}$/, {
    message: 'A mobile number must be a PH mobile in the form 09XXXXXXXXX.',
  })
  value: string;
}

export class ResolveTransferDto {
  @ApiProperty({ type: RecipientRefDto })
  @ValidateNested()
  @Type(() => RecipientRefDto)
  // Hosts the amount pair check. It must sit on a required field: on an
  // @IsOptional() property class-validator skips every decorator when the
  // value is absent, so a body omitting both amounts would slip through.
  @Validate(ExactlyOneAmountConstraint)
  recipient: RecipientRefDto;

  /**
   * Pesos, preferably as a string. A JSON number is an IEEE-754 double, so any
   * arithmetic the client did before serializing can arrive already wrong.
   * After validation this holds an integer number of centavos.
   */
  @ApiPropertyOptional({
    description:
      'Amount in PHP with at most 2 decimal places. Prefer a string ("1500.00"). Mutually exclusive with amountMinor.',
    example: '1500.00',
    type: String,
    pattern: '^\\d+(\\.\\d{1,2})?$',
  })
  @IsOptional()
  @IsPesoAmount()
  amount?: number;

  @ApiPropertyOptional({
    description: 'Amount in PHP centavos (100 = PHP 1.00). Integer only.',
    example: 150_000,
    type: Number,
    minimum: 1,
  })
  @IsOptional()
  @IsInt({ message: 'amountMinor must be a whole number of centavos.' })
  @IsPositive({ message: 'amountMinor must be greater than zero.' })
  amountMinor?: number;

  @ApiPropertyOptional({
    description: 'Optional note shown on the transfer. Max 100 characters.',
    example: 'Lunch',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  note?: string;

  /**
   * A method rather than a getter: class-transformer would treat a getter as a
   * property and try to serialize it.
   */
  resolvedAmountMinor(): number {
    const resolved = this.amount ?? this.amountMinor;

    if (resolved === undefined || resolved === null) {
      throw new Error(
        'ResolveTransferDto has neither amount nor amountMinor; it was not validated.',
      );
    }

    return resolved;
  }
}
