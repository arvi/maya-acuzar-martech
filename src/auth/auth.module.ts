import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthIdentity } from '../holders/entities/auth-identity.entity';
import { DevTokenController } from './dev-token.controller';
import { DevTokenService } from './dev-token.service';
import { isProduction } from './jwt.config';
import { JwtAuthGuard } from './jwt-auth.guard';

// Registered only outside production. The route does not exist in a
// production build rather than existing behind a flag that could be flipped.
const devControllers = isProduction() ? [] : [DevTokenController];
const devProviders = isProduction() ? [] : [DevTokenService];

if (!isProduction()) {
  new Logger('AuthModule').warn(
    'POST /v1/dev/token is ENABLED and mints access tokens for any seeded identity without a password. Never run this configuration in production.',
  );
}

@Module({
  imports: [TypeOrmModule.forFeature([AuthIdentity]), JwtModule.register({})],
  controllers: [...devControllers],
  providers: [...devProviders, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}
