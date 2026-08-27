import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountLimitsService } from './account-limits.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { Account } from './entities/account.entity';
import { AccountLimit } from './entities/account-limit.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Account, AccountLimit])],
  controllers: [AccountsController],
  providers: [AccountsService, AccountLimitsService],
  // TransfersModule enforces limits during posting, so it needs this service.
  exports: [AccountLimitsService],
})
export class AccountsModule {}
