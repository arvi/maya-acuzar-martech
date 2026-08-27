import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from '../accounts/accounts.module';
import { Account } from '../accounts/entities/account.entity';
import { SendMoneyModule } from '../send-money/send-money.module';
import { LimitUsageService } from './limit-usage.service';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { TransactionHistoryService } from './transaction-history.service';

/**
 * Token-addressed reads.
 *
 * Separate from AccountsModule, which is organised around an account named by
 * public_id — the addressing this module replaces.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Account]),
    AccountsModule,
    SendMoneyModule,
  ],
  controllers: [MeController],
  providers: [MeService, LimitUsageService, TransactionHistoryService],
  // The deferred service-to-service limits endpoint will consume this.
  exports: [LimitUsageService],
})
export class MeModule {}
