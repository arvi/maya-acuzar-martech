import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import {
  SendMoneyErrorCode,
  SendMoneyRuleViolation,
} from '../errors/send-money-error';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostFor(path: string) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ route: { path }, url: path }),
      getResponse: () => ({ status, json }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  it('returns the accumulated errors array for a rule violation', () => {
    const { host, status, json } = hostFor('/v1/send-money/resolve');
    const violation = new SendMoneyRuleViolation([
      {
        code: SendMoneyErrorCode.InsufficientFunds,
        message: 'Insufficient funds.',
        details: { balanceMinor: 100, requestedMinor: 500 },
      },
      {
        code: SendMoneyErrorCode.RecipientNotActive,
        message: 'Recipient cannot receive funds.',
      },
    ]);

    filter.catch(violation, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        message: 'Transfer cannot proceed.',
        data: {
          errors: [
            expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }),
            expect.objectContaining({ code: 'RECIPIENT_NOT_ACTIVE' }),
          ],
        },
      }),
    );
  });

  it('gives an ordinary HttpException a coded envelope', () => {
    const { host, status, json } = hostFor('/v1/send-money');

    filter.catch(new BadRequestException('Body is malformed.'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Body is malformed.',
        data: expect.objectContaining({ code: 'BAD_REQUEST' }),
      }),
    );
  });

  it('hides internals of an unknown throwable behind a 500', () => {
    const { host, status, json } = hostFor('/v1/send-money');

    filter.catch(new Error('connection string: postgres://user:pw@host'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.data).toEqual({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('leaves a failing /health probe in the Terminus shape', () => {
    const { host, json } = hostFor('/health');
    const probe = new BadRequestException({
      status: 'error',
      database: 'disconnected',
    });

    filter.catch(probe, host);

    expect(json).toHaveBeenCalledWith({
      status: 'error',
      database: 'disconnected',
    });
  });
});
