import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from './accounts/accounts.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AccountHolder } from './holders/entities/account-holder.entity';
import { AuthIdentity } from './holders/entities/auth-identity.entity';
import { CorporateHolder } from './holders/entities/corporate-holder.entity';
import { CorporateSignatory } from './holders/entities/corporate-signatory.entity';
import { IndividualHolder } from './holders/entities/individual-holder.entity';
import { MeModule } from './me/me.module';
import { SendMoneyModule } from './send-money/send-money.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,

    // The holder entities have no endpoints of their own in this slice, but the
    // send-money path resolves relations through them, so their metadata still
    // has to be registered.
    TypeOrmModule.forFeature([
      AccountHolder,
      IndividualHolder,
      CorporateHolder,
      CorporateSignatory,
      AuthIdentity,
    ]),

    AuthModule,
    HealthModule,
    AccountsModule,
    SendMoneyModule,
    MeModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
