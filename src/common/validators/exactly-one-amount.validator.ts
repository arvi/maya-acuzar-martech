import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { minorToPesos } from '../money';

interface AmountBearing {
  amount?: number;
  amountMinor?: number;
}

/**
 * Requires exactly one of `amount` (pesos) or `amountMinor` (centavos), and
 * requires them to agree when both are present.
 *
 * Accepting both and silently preferring one would let a client whose two
 * fields disagree move a sum it did not intend — the kind of mismatch that
 * shows up when a caller updates one field and forgets the other. Rejecting is
 * the only answer that cannot move the wrong amount.
 */
@ValidatorConstraint({ name: 'exactlyOneAmount', async: false })
export class ExactlyOneAmountConstraint
  implements ValidatorConstraintInterface
{
  validate(_value: unknown, args: ValidationArguments): boolean {
    const { amount, amountMinor } = args.object as AmountBearing;

    const hasAmount = amount !== undefined && amount !== null;
    const hasMinor = amountMinor !== undefined && amountMinor !== null;

    if (!hasAmount && !hasMinor) return false;

    // Both present: they must describe the same sum. Each has already been
    // normalised to centavos by its own validator, so this is an integer
    // comparison, not a float one.
    if (hasAmount && hasMinor) return amount === amountMinor;

    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    const { amount, amountMinor } = args.object as AmountBearing;

    const hasAmount = amount !== undefined && amount !== null;
    const hasMinor = amountMinor !== undefined && amountMinor !== null;

    if (!hasAmount && !hasMinor) {
      return 'Provide an amount: either "amount" in pesos (e.g. "100.23") or "amountMinor" in centavos (e.g. 10023).';
    }

    // Only reachable when both are set and disagree. Report the peso rendering
    // of each so the mismatch is legible rather than two bare integers.
    if (
      typeof amount === 'number' &&
      typeof amountMinor === 'number' &&
      Number.isSafeInteger(amount) &&
      Number.isSafeInteger(amountMinor)
    ) {
      return `amount (${minorToPesos(amount)}) and amountMinor (${minorToPesos(amountMinor)}) must be the same amount; send only one.`;
    }

    return 'amount and amountMinor must be the same amount; send only one.';
  }
}
