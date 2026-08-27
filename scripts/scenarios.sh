#!/usr/bin/env bash
# Self-asserting walkthrough of the send-money flow.
#
# Each scenario prints its request, the envelope it got back, and PASS/FAIL.
# `all` exits non-zero if anything diverges, so this is an acceptance suite
# rather than a demo reel.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:${API_HOST_PORT:-3000}}"

# Only used by scenario_daily_reset, which talks to Postgres directly via
# `docker exec` to backdate and clean up ledger rows. The container name is a
# fixed project constant (docker-compose.yml's `container_name`), not an
# environment-dependent value, so it is hardcoded rather than read from env.
PG_CONTAINER="maya_arvi_martech_postgres"
POSTGRES_USER="${POSTGRES_USER:-sml_user}"
POSTGRES_DB="${POSTGRES_DB:-sml_db}"

PASSED=0
FAILED=0

command -v jq >/dev/null 2>&1 || {
  echo "jq is required. Install with: brew install jq (macOS) or apt-get install jq" >&2
  exit 1
}

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }

pass() { PASSED=$((PASSED + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

# Mints an access token. The evaluator never handles one by hand — resolution
# tokens live 120 seconds and manual paste between two calls is error-prone.
token_for() {
  curl -s -X POST "$BASE_URL/v1/dev/token" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"$1\"}" | jq -r '.data.accessToken'
}

# resolve <token> <recipient-type> <recipient-value> <amount> [note]
resolve() {
  local note_json=""
  [ -n "${5:-}" ] && note_json=",\"note\":\"$5\""

  curl -s -w '\n%{http_code}' -X POST "$BASE_URL/v1/send-money/resolve" \
    -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"recipient\":{\"type\":\"$2\",\"value\":\"$3\"},\"amount\":\"$4\"$note_json}"
}

# execute <token> <resolution-token> <idempotency-key>
execute() {
  curl -s -w '\n%{http_code}' -X POST "$BASE_URL/v1/send-money" \
    -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -H "Idempotency-Key: $3" \
    -d "{\"resolutionToken\":\"$2\"}"
}

status_of() { tail -n1 <<<"$1"; }
body_of()   { sed '$d' <<<"$1"; }

expect_status() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label — expected HTTP $expected, got $actual"
  fi
}

expect_code() {
  local body="$1" code="$2"
  if jq -e --arg c "$code" '.data.errors[]? | select(.code == $c)' >/dev/null <<<"$body"; then
    pass "reported $code"
  else
    fail "expected error code $code; got $(jq -c '.data.errors // .data' <<<"$body")"
  fi
}

# psql <sql> — runs one statement against the shared Postgres container as
# the app's own role. Only scenario_daily_reset uses this.
psql_exec() {
  # head -1: an INSERT ... RETURNING prints the returned value followed by a
  # command-tag line ("INSERT 0 1") even under -t, so only the first line is
  # the actual result.
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1" | head -1
}

scenario_happy() {
  bold "happy — Adelaida sends PHP 1,500.00 to Ethan"
  local token response body status
  token=$(token_for adelaida.magtalas)

  info "POST /v1/send-money/resolve"
  response=$(resolve "$token" username ethan.delrosario 1500.00 "Lunch")
  status=$(status_of "$response"); body=$(body_of "$response")
  expect_status "$status" 200 "resolve"

  jq -c '.data | {recipient, amount, expiresAt}' <<<"$body" | sed 's/^/  /'

  local rt; rt=$(jq -r '.data.resolutionToken' <<<"$body")

  info "POST /v1/send-money"
  response=$(execute "$token" "$rt" "$(uuidgen)")
  status=$(status_of "$response"); body=$(body_of "$response")
  expect_status "$status" 201 "execute"

  jq -c '.data' <<<"$body" | sed 's/^/  /'
  info "Cross-check: docs/SEND_MONEY.md § happy"
}

scenario_insufficient_funds() {
  bold "insufficient-funds — Abigail (PHP 1,999.99) tries to send PHP 5,000.00"
  local token response body
  token=$(token_for abigail.lim)
  response=$(resolve "$token" username ethan.delrosario 5000.00)
  expect_status "$(status_of "$response")" 422 "resolve rejected"
  body=$(body_of "$response")
  expect_code "$body" INSUFFICIENT_FUNDS
}

scenario_sender_limit() {
  bold "sender-limit — build up usage, then cross the PHP 50,000 daily cap"
  local token rt response body key
  token=$(token_for arturo.montenegro)

  # Recipient is richard.lim, not ethan.delrosario: the happy scenario
  # already credits Ethan PHP 1,500.00 earlier in the same 'all' run, and
  # 1,500.00 + 49,900.00 would trip Ethan's own recipient daily cap before
  # this scenario gets to test Arturo's sender cap. richard.lim is never a
  # recipient in any other scenario, so his headroom is untouched here.
  info "Sending 49,900.00 to reach just under the cap"
  response=$(resolve "$token" username richard.lim 49900.00)
  if [ "$(status_of "$response")" != "200" ]; then
    fail "setup transfer rejected: $(jq -c '.data' <<<"$(body_of "$response")")"
    return
  fi
  rt=$(jq -r '.data.resolutionToken' <<<"$(body_of "$response")")
  execute "$token" "$rt" "$(uuidgen)" >/dev/null

  info "Now 100.00 lands exactly on the limit — inclusive, so it passes"
  response=$(resolve "$token" username richard.lim 100.00)
  expect_status "$(status_of "$response")" 200 "boundary amount allowed"
  rt=$(jq -r '.data.resolutionToken' <<<"$(body_of "$response")")
  execute "$token" "$rt" "$(uuidgen)" >/dev/null

  info "One more centavo is over"
  response=$(resolve "$token" username richard.lim 0.01)
  expect_status "$(status_of "$response")" 422 "over-limit rejected"
  expect_code "$(body_of "$response")" SENDER_DAILY_LIMIT_EXCEEDED
}

scenario_recipient_limit() {
  bold "recipient-limit — fill Joy's inbound headroom, then exceed it"
  local token rt response
  token=$(token_for richard.lim)

  info "Crediting Joy 50,000.00 to consume her daily receiving limit"
  response=$(resolve "$token" username joy.fabregas 50000.00)
  if [ "$(status_of "$response")" = "200" ]; then
    rt=$(jq -r '.data.resolutionToken' <<<"$(body_of "$response")")
    execute "$token" "$rt" "$(uuidgen)" >/dev/null
  fi

  info "A further 100.00 exceeds what she may receive today"
  response=$(resolve "$token" username joy.fabregas 100.00)
  expect_status "$(status_of "$response")" 422 "recipient over limit"
  expect_code "$(body_of "$response")" RECIPIENT_DAILY_LIMIT_EXCEEDED
}

scenario_recipient_not_found() {
  bold "recipient-not-found — an unknown username"
  local response
  response=$(resolve "$(token_for adelaida.magtalas)" username no.such.person 100.00)
  expect_status "$(status_of "$response")" 422 "rejected"
  expect_code "$(body_of "$response")" RECIPIENT_NOT_FOUND
}

scenario_recipient_suspended() {
  bold "recipient-suspended — Bobbie Salazar cannot receive"
  local response
  response=$(resolve "$(token_for adelaida.magtalas)" username bobbie.salazar 100.00)
  expect_status "$(status_of "$response")" 422 "rejected"
  expect_code "$(body_of "$response")" RECIPIENT_NOT_ACTIVE
}

scenario_sender_suspended() {
  bold "sender-suspended — Bobbie's token is rejected by the guard"
  local token response body
  token=$(token_for bobbie.salazar)
  info "A token IS minted for a suspended holder; the guard is what rejects it"

  response=$(resolve "$token" username ethan.delrosario 100.00)
  expect_status "$(status_of "$response")" 403 "guard rejected"
  body=$(body_of "$response")

  if [ "$(jq -r '.data.code' <<<"$body")" = "IDENTITY_NOT_ACTIVE" ]; then
    pass "reported IDENTITY_NOT_ACTIVE"
  else
    fail "expected IDENTITY_NOT_ACTIVE; got $(jq -c '.data' <<<"$body")"
  fi
}

scenario_self_transfer() {
  bold "self-transfer — sending to your own username"
  local response
  response=$(resolve "$(token_for adelaida.magtalas)" username adelaida.magtalas 100.00)
  expect_status "$(status_of "$response")" 422 "rejected"
  expect_code "$(body_of "$response")" SELF_TRANSFER_NOT_ALLOWED
}

scenario_multi_error() {
  bold "multi-error — several conditions fail in one call"
  local response body count
  response=$(resolve "$(token_for abigail.lim)" username bobbie.salazar 999999.00)
  expect_status "$(status_of "$response")" 422 "rejected"
  body=$(body_of "$response")

  count=$(jq '.data.errors | length' <<<"$body")
  if [ "$count" -ge 2 ]; then
    pass "returned $count codes in one response"
    jq -r '.data.errors[] | "    - \(.code): \(.message)"' <<<"$body"
  else
    fail "expected at least 2 error codes, got $count"
  fi
}

scenario_expired_token() {
  bold "expired-token — a confirmation left too long (takes ~2 minutes)"
  local token rt response
  token=$(token_for adelaida.magtalas)
  response=$(resolve "$token" username ethan.delrosario 100.00)
  rt=$(jq -r '.data.resolutionToken' <<<"$(body_of "$response")")

  info "Waiting 125s for the 120s token to expire..."
  sleep 125

  response=$(execute "$token" "$rt" "$(uuidgen)")
  expect_status "$(status_of "$response")" 403 "expired token rejected"

  if [ "$(jq -r '.data.code' <<<"$(body_of "$response")")" = "RESOLUTION_TOKEN_EXPIRED" ]; then
    pass "reported RESOLUTION_TOKEN_EXPIRED"
  else
    fail "expected RESOLUTION_TOKEN_EXPIRED"
  fi
}

scenario_replay() {
  bold "replay — the same Idempotency-Key twice moves money once"
  local token rt key first second
  token=$(token_for adelaida.magtalas)
  key=$(uuidgen)

  rt=$(jq -r '.data.resolutionToken' \
    <<<"$(body_of "$(resolve "$token" username ethan.delrosario 250.00)")")

  first=$(jq -r '.data.reference' <<<"$(body_of "$(execute "$token" "$rt" "$key")")")
  second=$(jq -r '.data.reference' <<<"$(body_of "$(execute "$token" "$rt" "$key")")")

  if [ "$first" = "$second" ] && [ "$first" != "null" ]; then
    pass "both calls returned reference $first"
  else
    fail "expected the same reference twice, got '$first' and '$second'"
  fi
  info "Cross-check: SELECT count(*) FROM transfers WHERE idempotency_key = '$key'; -- expect 1"
}

scenario_daily_reset() {
  bold "daily-reset — a backdated debit is excluded from today's limit usage"
  local holder_id account_id dest_id backdated_id response status body key

  holder_id=$(psql_exec "SELECT h.id FROM account_holders h WHERE h.display_name = 'Montenegro Industries'")
  account_id=$(psql_exec "SELECT a.id FROM accounts a WHERE a.account_holder_id = $holder_id")
  dest_id=$(psql_exec "SELECT a.id FROM accounts a JOIN account_holders h ON h.id = a.account_holder_id WHERE h.display_name = 'Ethan Del Rosario'")

  if [ -z "$holder_id" ] || [ -z "$account_id" ] || [ -z "$dest_id" ]; then
    fail "could not resolve Montenegro Industries / Ethan Del Rosario account ids via psql"
    return
  fi

  # A fresh public_id/idempotency_key per invocation, so re-running this
  # scenario never collides with a row left behind by an earlier run and the
  # unconditional cleanup below only ever touches rows this run created.
  backdated_id=$(psql_exec "SELECT gen_random_uuid()")
  key="scenario-daily-reset-$(date +%s)-$$"

  info "Backdating a PHP 49,999.00 debit to 2 days ago via docker exec ... psql"
  # A fixed "2 days ago" is a simplification versus the e2e test in
  # test/send-money.e2e-spec.ts ('excludes a ledger entry from a previous
  # day/month...'), which computes the offset dynamically to stay correct
  # on the 1st/2nd of the month. This scenario is run manually/on demand
  # rather than repeatedly in CI, so that edge case is not worth the extra
  # complexity here.
  local transfer_id
  transfer_id=$(psql_exec "
    INSERT INTO transfers
      (public_id, source_account_id, destination_account_id, amount_minor,
       status, posted_at, note, idempotency_key)
    VALUES ('$backdated_id', $account_id, $dest_id, 4999900,
            'posted', now() - interval '2 days', 'Backdated daily boundary fixture (scenarios.sh)', '$key')
    RETURNING id;
  ")

  psql_exec "
    INSERT INTO ledger_entries (transfer_id, account_id, direction, amount_minor, posted_at)
    VALUES
      ($transfer_id, $account_id, 'debit',  4999900, now() - interval '2 days'),
      ($transfer_id, $dest_id,    'credit', 4999900, now() - interval '2 days');
  " >/dev/null
  psql_exec "UPDATE accounts SET balance_minor = balance_minor - 4999900 WHERE id = $account_id" >/dev/null
  psql_exec "UPDATE accounts SET balance_minor = balance_minor + 4999900 WHERE id = $dest_id" >/dev/null

  info "This would have blown today's PHP 50,000.00 daily cap if wrongly counted"
  info "POST /v1/send-money/resolve — Arturo sends PHP 100.00 to Ethan"
  response=$(resolve "$(token_for arturo.montenegro)" username ethan.delrosario 100.00)
  status=$(status_of "$response"); body=$(body_of "$response")

  # A SENDER_DAILY_LIMIT_EXCEEDED here almost always means Arturo's headroom
  # was already spent by sender-limit, which fills his cap to the boundary on
  # purpose — not that the day window is broken. Say so, because the bare
  # "expected 200, got 422" sends you looking in the wrong place.
  if [ "$status" = "422" ] &&
     jq -e '.data.errors[]? | select(.code == "SENDER_DAILY_LIMIT_EXCEEDED")' >/dev/null <<<"$body"; then
    fail "Arturo has no headroom left today — run this before sender-limit, or reset with 'docker compose down -v && docker compose up -d --build'"
  else
    expect_status "$status" 200 "resolve succeeds (backdated debit excluded from today's usage)"
  fi

  info "Cross-check the Asia/Manila day boundary yourself:"
  info "  SELECT le.direction, sum(le.amount_minor) AS used_minor"
  info "    FROM ledger_entries le"
  info "   WHERE le.account_id = $account_id"
  info "     AND le.transfer_id IS NOT NULL"
  info "     AND le.posted_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila'"
  info "   GROUP BY le.direction; -- the backdated 49,999.00 debit must NOT appear"

  info "Cleaning up: reversing the backdated pair (ledger_entries is append-only; no deletes)"
  # transfer_id = NULL keeps this reversal invisible to getUsage()'s
  # `transfer_id IS NOT NULL` filter, so it cannot itself pollute any
  # scenario that runs after it. The transfers row for $backdated_id is kept
  # (ON DELETE RESTRICT from ledger_entries) but its effect on balances and
  # limit usage is fully undone by this reversal.
  psql_exec "
    INSERT INTO ledger_entries (transfer_id, account_id, direction, amount_minor)
    VALUES
      (NULL, $account_id, 'credit', 4999900),
      (NULL, $dest_id,    'debit',  4999900);
  " >/dev/null
  psql_exec "UPDATE accounts SET balance_minor = balance_minor + 4999900 WHERE id = $account_id" >/dev/null
  psql_exec "UPDATE accounts SET balance_minor = balance_minor - 4999900 WHERE id = $dest_id" >/dev/null
  info "Reversal posted for transfer $backdated_id"
}

ALL_SCENARIOS=(
  happy insufficient_funds daily_reset sender_limit recipient_limit
  recipient_not_found recipient_suspended sender_suspended
  self_transfer multi_error replay
)

run_all() {
  local include_slow="${1:-}"

  for name in "${ALL_SCENARIOS[@]}"; do
    "scenario_$name"
    echo
  done

  if [ "$include_slow" = "--slow" ]; then
    scenario_expired_token
    echo
  fi

  bold "Summary: $PASSED passed, $FAILED failed"
  if [ "$include_slow" != "--slow" ]; then
    info "Skipped: expired-token (costs ~2 minutes). Run './scripts/scenarios.sh all --slow' to include it."
  fi
  [ "$FAILED" -eq 0 ]
}

case "${1:-}" in
  happy)               scenario_happy ;;
  insufficient-funds)  scenario_insufficient_funds ;;
  sender-limit)        scenario_sender_limit ;;
  recipient-limit)     scenario_recipient_limit ;;
  daily-reset)         scenario_daily_reset ;;
  recipient-not-found) scenario_recipient_not_found ;;
  recipient-suspended) scenario_recipient_suspended ;;
  sender-suspended)    scenario_sender_suspended ;;
  self-transfer)       scenario_self_transfer ;;
  multi-error)         scenario_multi_error ;;
  expired-token)       scenario_expired_token ;;
  replay)              scenario_replay ;;
  all)                 run_all "${2:-}" ;;
  *)
    echo "Usage: $0 <scenario|all [--slow]>"
    echo
    echo "Scenarios: happy insufficient-funds sender-limit recipient-limit"
    echo "           daily-reset recipient-not-found recipient-suspended"
    echo "           sender-suspended self-transfer multi-error expired-token replay"
    echo
    echo "Most scenarios assume a freshly seeded database:"
    echo "  docker compose down -v && docker compose up -d"
    exit 1
    ;;
esac

[ "$FAILED" -eq 0 ]
