import { Transform } from 'class-transformer';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { InvalidMoneyAmountError, pesosToMinor } from '../money';

/**
 * Marks a field as a PHP amount supplied in pesos and stored in centavos.
 *
 * Combines the transform and the check in one decorator on purpose. Composing
 * `@Transform` with `@IsInt` + `@IsPositive` produced two messages for a single
 * mistake — a malformed amount also fails the positivity check, so "100.235"
 * came back as both "at most 2 decimal places" and "must be greater than zero".
 * Owning both halves here means one failure yields exactly one message.
 *
 * After validation the property holds an integer number of centavos.
 */
export function IsPesoAmount(options?: {
  /** Reject zero and negatives. Defaults to true. */
  positiveOnly?: boolean;
  validationOptions?: ValidationOptions;
}) {
  const positiveOnly = options?.positiveOnly ?? true;

  return (target: object, propertyName: string) => {
    // Runs before validation; leaves the raw value in place when it cannot be
    // parsed so the validator below can report why.
    Transform(({ value }) => {
      if (value === null || value === undefined) return value;
      try {
        return pesosToMinor(value as string | number);
      } catch (error) {
        if (error instanceof InvalidMoneyAmountError) return value;
        throw error;
      }
    })(target, propertyName);

    registerDecorator({
      name: 'isPesoAmount',
      target: target.constructor,
      propertyName,
      options: options?.validationOptions,
      validator: {
        validate(value: unknown) {
          // The transform above turns every acceptable input into a safe
          // integer, so anything else here failed to parse.
          if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
            return false;
          }
          return positiveOnly ? value > 0 : true;
        },

        defaultMessage(args: ValidationArguments) {
          const raw = args.value;

          if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
            // Parsed cleanly, so the only way to get here is a non-positive
            // amount.
            return `${args.property} must be greater than zero.`;
          }

          return `${args.property} must be a PHP amount with at most 2 decimal places, e.g. "100.23".`;
        },
      },
    });
  };
}
