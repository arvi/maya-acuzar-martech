import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from '../accounts/accounts.module';
import { AccountLimit } from '../accounts/entities/account-limit.entity';
import { LedgerEntry } from '../ledger/entities/ledger-entry.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { Transfer } from '../transfers/entities/transfer.entity';
import { RecipientResolverService } from './recipient-resolver.service';
import { ResolutionTokenService } from './resolution-token.service';
import { SendMoneyController } from './send-money.controller';
import { SendMoneyService } from './send-money.service';
import { SendMoneyRulesService } from './send-money-rules.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transfer,
      LedgerEntry,
      OutboxEvent,
      AccountLimit,
    ]),
    JwtModule.register({}),
    AccountsModule,
  ],
  controllers: [SendMoneyController],
  providers: [
    SendMoneyService,
    SendMoneyRulesService,
    RecipientResolverService,
    ResolutionTokenService,
  ],
  // MeModule resolves a holder's single active account by the identical rule,
  // so /me and a transfer can never disagree about which account is "yours".
  exports: [RecipientResolverService],
})
export class SendMoneyModule {}
