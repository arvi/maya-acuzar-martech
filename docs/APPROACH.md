# Approach on Technical Homework

1. Research about the topic.
2. Choose an opinionated tech stack (early decided on Spec-driven development) - NestJS (along with PostGres and TypeORM)
3. Scaffold and Tooling
3. Database-first schema approach. Migrations are hand-written DDL. Used Claude to generate TypeORM entities.
4. Use Claude Code to create spec based on own judgement spec e.g

```md
Send Money Flow: Two Phase



1. Create interceptor, exclude '/health'. Shape should be { statusCode, data, message, timestamp } where the response is in "data"

2. Add seed data where user is not active "Bobbie Salazar" e.g suspended

3. User log in to the system. No signup/signin in this app. Simulate via /dev/token which generates JWT Keycloak mimicked

4. The access token is used across all endpoints

5. To send money, authorized

User enters the ff:

- the amount to send

- username or mobile number (client side validation already determines the type so will pass in both type and value) of the recipient.

- An optional note can be included (not yet in schema include in migration, see transfers or ledger_entries table).



System checks the ff:

- access token/authorized (user is active; add a seed data where user is not active "Bobbie Salazar"); idempotency key is also passed.

- check if amount is "not greater than user's balance", "not exceeding daily/monthly limit which is inclusive"

- recipient account resolution on given username/mobile number; a corporate signatory would be pointing to the corporate holder id (a.k.a account holder id)

- check that recipient account is not suspended or closed

- check if amount is "not greater than recipient's balance", "not exceeding daily/monthly limit which is inclusive"

- if all conditions passed, return a status ok to endpoint. this is the first phase (In UI, client clicks next button). Will send back a short-lived resolution token jwt (when decrypted in final phase, retrieves note value, note is one of the key/value pair) that will be used by API consumer on final phase.

- if some of the conditions not met, set an error code for each condition and a message and return as response respecting shape in interceptor



Final send money phase

- access token/authorized (user is active; add a seed data where user is not active "Bobbie Salazar"); idempotency key is also passed.

- short-lived resolution token (when decrypted, retrieves note value, note is one of the key/value pair, determines if "short-lived" is expired)

- records transaction (debit/credit) on respective tables ledger_entries, transfers, outbox_events

- System responds account details (name, amount) and transfer reference (public id)
```







