import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountLimitsService } from './account-limits.service';
import { AccountsService } from './accounts.service';
import { Account } from './entities/account.entity';
import { AccountLimit } from './entities/account-limit.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Account, AccountLimit])],
  providers: [AccountsService, AccountLimitsService],
  // SendMoneyModule enforces limits during posting and MeModule reports them,
  // so both need this service.
  exports: [AccountLimitsService, AccountsService],
})
export class AccountsModule {}
