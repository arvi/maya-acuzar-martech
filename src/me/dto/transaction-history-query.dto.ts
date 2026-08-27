import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  Matches,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date that exists. The regex admits 2026-02-30 and 2026-13-01, which
 * Postgres would reject at query time as a 22008 — a 500 for what is really a
 * bad request.
 */
export function isRealCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Round-tripping catches rollover: Date.UTC(2026, 1, 30) becomes March 2.
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

@ValidatorConstraint({ name: 'realCalendarDate' })
class RealCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isRealCalendarDate(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a real calendar date in YYYY-MM-DD form.`;
  }
}

/**
 * An ordered range. Reported on `to` so the message lands on the field the
 * caller most likely got wrong.
 */
@ValidatorConstraint({ name: 'notBeforeFrom' })
class NotBeforeFromConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const { from } = args.object as TransactionHistoryQueryDto;

    if (typeof value !== 'string' || typeof from !== 'string') {
      return true; // Nothing to compare; the per-field rules cover the rest.
    }

    // Both are zero-padded YYYY-MM-DD, so lexical order is chronological.
    return from <= value;
  }

  defaultMessage(): string {
    return 'to must not be earlier than from.';
  }
}

/**
 * Both bounds are optional and independent. With neither, the endpoint returns
 * the latest few transactions.
 *
 * Dates name Manila calendar days, not instants: `from` starts at 00:00 PHT
 * and `to` runs through 23:59:59.999 PHT of that same day. The conversion
 * happens in Postgres, which is DST-aware.
 */
export class TransactionHistoryQueryDto {
  @ApiPropertyOptional({
    description:
      'Start of the range, inclusive. A Manila calendar day (YYYY-MM-DD).',
    example: '2026-08-01',
  })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'from must be in YYYY-MM-DD form.' })
  @Validate(RealCalendarDateConstraint)
  from?: string;

  @ApiPropertyOptional({
    description:
      'End of the range, inclusive of the whole day. A Manila calendar day (YYYY-MM-DD).',
    example: '2026-08-27',
  })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'to must be in YYYY-MM-DD form.' })
  @Validate(RealCalendarDateConstraint)
  @Validate(NotBeforeFromConstraint)
  to?: string;
}
