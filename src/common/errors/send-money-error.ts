import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Machine-readable reasons a send-money request cannot proceed.
 *
 * Phase one reports every applicable code at once; phase two re-checks the same
 * rules and reuses the same codes, so a client maps a code to a message once.
 */
export enum SendMoneyErrorCode {
  SenderNoActiveAccount = 'SENDER_NO_ACTIVE_ACCOUNT',
  SenderAmbiguousAccount = 'SENDER_AMBIGUOUS_ACCOUNT',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  SenderDailyLimitExceeded = 'SENDER_DAILY_LIMIT_EXCEEDED',
  SenderMonthlyLimitExceeded = 'SENDER_MONTHLY_LIMIT_EXCEEDED',
  RecipientNotFound = 'RECIPIENT_NOT_FOUND',
  RecipientNotActive = 'RECIPIENT_NOT_ACTIVE',
  RecipientNoActiveAccount = 'RECIPIENT_NO_ACTIVE_ACCOUNT',
  RecipientAmbiguousAccount = 'RECIPIENT_AMBIGUOUS_ACCOUNT',
  RecipientDailyLimitExceeded = 'RECIPIENT_DAILY_LIMIT_EXCEEDED',
  RecipientMonthlyLimitExceeded = 'RECIPIENT_MONTHLY_LIMIT_EXCEEDED',
  SelfTransferNotAllowed = 'SELF_TRANSFER_NOT_ALLOWED',
}

export interface SendMoneyError {
  code: SendMoneyErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Summary used when phase one rejects a request that was never valid. */
export const RESOLVE_FAILED_SUMMARY = 'Transfer cannot proceed.';

/**
 * Summary used when phase two rejects a request that passed phase one.
 *
 * The codes are identical in both phases, so the summary is the only thing
 * telling a client "your confirmation went stale" apart from "your request was
 * never valid".
 */
export const EXECUTE_STALE_SUMMARY =
  'Transfer no longer valid; please confirm again.';

/**
 * Carries every failed rule rather than the first one. A confirmation screen
 * has to show all of them at once, so throwing on the first violation would
 * make the client re-submit to discover the next.
 */
export class SendMoneyRuleViolation extends HttpException {
  constructor(
    readonly errors: SendMoneyError[],
    readonly summary: string = RESOLVE_FAILED_SUMMARY,
  ) {
    super({ errors }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
