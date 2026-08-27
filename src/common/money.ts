/**
 * Money is stored and computed in centavos (integer minor units).
 * Uses decimal strings instead of floating-point arithmetic to avoid rounding errors.
 */

export const MINOR_UNIT_SCALE = 2;

const MINOR_UNITS_PER_MAJOR = 100;

/**
 * Accepts only plain decimal amounts with an optional sign and up to two
 * decimal places. Rejects exponents, leading decimals, and thousands separators.
 */
const PESO_AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export class InvalidMoneyAmountError extends Error {}

/**
 * Parses a peso amount into centavos, exactly.
 *
 * @throws InvalidMoneyAmountError if the amount has more than two decimal
 * places, or is not a plain decimal number.
 */
export function pesosToMinor(input: string | number): number {
  const raw =
    typeof input === 'number' ? numberToDecimalString(input) : input.trim();

  if (!PESO_AMOUNT_PATTERN.test(raw)) {
    throw new InvalidMoneyAmountError(
      `Invalid amount "${raw}". Expected pesos with at most ${MINOR_UNIT_SCALE} decimal places, e.g. "100.23".`,
    );
  }

  const negative = raw.startsWith('-');
  const [major, minor = ''] = (negative ? raw.slice(1) : raw).split('.');

  // Pad so '.5' and '.50' both mean 50 centavos rather than 5.
  const centavos =
    Number(major) * MINOR_UNITS_PER_MAJOR +
    Number(minor.padEnd(MINOR_UNIT_SCALE, '0'));

  if (!Number.isSafeInteger(centavos)) {
    throw new InvalidMoneyAmountError(
      `Amount "${raw}" is too large to represent exactly in centavos.`,
    );
  }

  return negative ? -centavos : centavos;
}

/**
 * Renders centavos as a fixed two-decimal peso string, e.g. 10023 → '100.23'.
 */
export function minorToPesos(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new InvalidMoneyAmountError(
      `Cannot format ${minor}: centavo amounts must be safe integers.`,
    );
  }

  // Slice the integer rather than dividing, so no float is involved
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(MINOR_UNIT_SCALE + 1, '0');
  const major = digits.slice(0, -MINOR_UNIT_SCALE);
  const fraction = digits.slice(-MINOR_UNIT_SCALE);

  return `${sign}${major}.${fraction}`;
}

/**
 * Converts a JavaScript number to a plain decimal string.
 * Rejects exponent notation to prevent ambiguous or unsafe money values.
 */
function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new InvalidMoneyAmountError(`Invalid amount "${value}".`);
  }

  const text = String(value);
  if (text.includes('e') || text.includes('E')) {
    throw new InvalidMoneyAmountError(
      `Invalid amount "${text}". Exponent notation is not accepted; write the amount in full, e.g. "100.23".`,
    );
  }

  return text;
}
