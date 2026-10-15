#!/usr/bin/env bash
# A local Postgres to develop against, so nobody has to point tests at a real database.
# Idempotent: run it as often as you like.
set -u
export PATH=/usr/lib/postgresql/16/bin:$PATH
PGDATA=/var/tmp/erp-pg
PORT=5433
SOCK=/var/tmp

if [ ! -d "$PGDATA/base" ]; then
  mkdir -p "$PGDATA"; chown postgres "$PGDATA" 2>/dev/null; chmod 700 "$PGDATA"
  su postgres -c "PATH=$PATH initdb -D $PGDATA -U erp --auth=trust" >/dev/null 2>&1
fi

if ! pg_isready -h "$SOCK" -p "$PORT" -q 2>/dev/null; then
  su postgres -c "PATH=$PATH pg_ctl -D $PGDATA -l /var/tmp/erp-pg.log -o '-p $PORT -k $SOCK' start" >/dev/null 2>&1
  for i in 1 2 3 4 5 6 7 8 9 10; do pg_isready -h "$SOCK" -p "$PORT" -q && break; sleep 1; done
fi

psql -h "$SOCK" -p "$PORT" -U erp -d postgres -tAc "select 1 from pg_database where datname='erp_dev'" \
  | grep -q 1 || createdb -h "$SOCK" -p "$PORT" -U erp erp_dev

# The schema is generated, so reapplying it is how you pick up a column added to Schema.gs.
node "$(dirname "$0")/schema.js" | psql -h "$SOCK" -p "$PORT" -U erp -d erp_dev -q 2>/dev/null

echo 'export DATABASE_URL="postgres://erp@/erp_dev?host=/var/tmp&port=5433"'
