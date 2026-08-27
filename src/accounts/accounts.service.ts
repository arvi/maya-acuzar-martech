import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from './entities/account.entity';

/**
 * Account reads for internal callers.
 *
 * There is no public_id lookup any more: account identity is never an API
 * input, and the read endpoints that took one were replaced by /v1/me.
 */
@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  findByHolder(accountHolderId: number): Promise<Account[]> {
    return this.accountRepository.find({ where: { accountHolderId } });
  }
}
