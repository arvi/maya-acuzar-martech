import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

function contextFor(path: string, statusCode = 200): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({ route: { path }, url: path }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

const next = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('ResponseInterceptor', () => {
  let interceptor: ResponseInterceptor;

  beforeEach(() => {
    const reflector = new Reflector();
    interceptor = new ResponseInterceptor(reflector);
  });

  it('wraps the payload in the envelope', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(contextFor('/v1/accounts/x'), next({ a: 1 })),
    );

    expect(result).toEqual({
      statusCode: 200,
      data: { a: 1 },
      message: 'OK',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('reports the real status code, not a hardcoded 200', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(contextFor('/v1/send-money', 201), next({})),
    );

    expect(result).toMatchObject({ statusCode: 201 });
  });

  it('leaves /health untouched so probes keep their shape', async () => {
    const payload = { status: 'ok', database: 'connected' };

    const result = await lastValueFrom(
      interceptor.intercept(contextFor('/health'), next(payload)),
    );

    expect(result).toBe(payload);
  });

  it('still wraps a path that merely contains "health"', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(contextFor('/v1/accounts/health-report'), next({})),
    );

    expect(result).toMatchObject({ statusCode: 200, data: {} });
  });
});
