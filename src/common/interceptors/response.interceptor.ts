import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { RESPONSE_MESSAGE_KEY } from '../decorators/response-message.decorator';

export interface ApiEnvelope<T> {
  statusCode: number;
  data: T;
  message: string;
  timestamp: string;
}

/**
 * Health probes are consumed by infrastructure that expects Terminus' own
 * shape, so wrapping them would break liveness checks.
 *
 * Matched on the route path rather than by substring, so an endpoint like
 * /v1/accounts/health-report is not excluded by accident.
 */
export function isHealthPath(path: string): boolean {
  return path === '/health' || path.startsWith('/health/');
}

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const path: string = request.route?.path ?? request.url ?? '';

    if (isHealthPath(path)) {
      return next.handle();
    }

    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'OK';

    return next.handle().pipe(
      map((data) => ({
        // Read from the response rather than hardcoded, so a 201 stays a 201.
        statusCode: http.getResponse().statusCode,
        data,
        message,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
