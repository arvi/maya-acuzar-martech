import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedIdentity } from '../identity.types';

/**
 * The identity JwtAuthGuard attached. Handlers read this rather than
 * request.user, so a signature documents what the handler needs.
 */
export const CurrentIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedIdentity =>
    context.switchToHttp().getRequest().identity,
);
