import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { SendMoneyRuleViolation } from '../errors/send-money-error';
import { isHealthPath } from '../interceptors/response.interceptor';

/** HTTP status → stable machine-readable code for non-domain errors. */
const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const path: string = request.route?.path ?? request.url ?? '';

    // Health probes keep their own shape, failures included.
    if (isHealthPath(path)) {
      const status =
        exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.SERVICE_UNAVAILABLE;
      response
        .status(status)
        .json(
          exception instanceof HttpException
            ? exception.getResponse()
            : { status: 'error' },
        );
      return;
    }

    const { status, data, message } = this.describe(exception);

    response.status(status).json({
      statusCode: status,
      data,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  private describe(exception: unknown): {
    status: number;
    data: Record<string, unknown>;
    message: string;
  } {
    if (exception instanceof SendMoneyRuleViolation) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        data: { errors: exception.errors },
        message: exception.summary,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // Nest's built-in exceptions return either a string or
      // { statusCode, message, error }; class-validator returns message[].
      const detail =
        typeof payload === 'string'
          ? { message: payload }
          : (payload as Record<string, unknown>);

      const raw = detail.message;
      const message = Array.isArray(raw)
        ? 'Request validation failed.'
        : typeof raw === 'string'
          ? raw
          : exception.message;

      const code =
        (typeof detail.code === 'string' ? detail.code : undefined) ??
        STATUS_CODES[status] ??
        'ERROR';

      const { message: _omit, statusCode: _status, ...rest } = detail;

      return {
        status,
        data: {
          code,
          ...(Array.isArray(raw) ? { violations: raw } : {}),
          ...rest,
        },
        message,
      };
    }

    // Anything else is a bug. Log it with the stack; return nothing internal.
    this.logger.error(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception.stack : undefined,
    );

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      data: { code: 'INTERNAL_ERROR' },
      message: 'An unexpected error occurred.',
    };
  }
}
