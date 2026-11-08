import { sql, type Kysely } from 'kysely';

/**
 * Core schema (design §4). Everything that protects correctness lives here as SQL
 * so reviewers can see it in one place:
 *   - occupancies_no_overlap  : no two live sessions of a host overlap (buffers incl.)
 *   - occupancies_seats_*     : no group session over capacity
 *   - bookings_maintain_seats : the ONLY writer of occupancies.seats_taken
 *   - bookings_no_delete      : bookings are append-only (cancel/expire instead)
 *   - *_shape CHECKs          : columns required by each status (data shape, not transitions;
 *                               the transition guard lives in the service)
 *   - composite FKs           : a booking/occupancy can only point at its own host's rows
 *   - *_no_overlap (windows)  : availability windows on the same day cannot overlap
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE booking_status AS ENUM ('held', 'confirmed', 'cancelled', 'expired');

    -- Range over wall-clock times, so availability windows can use an exclusion constraint.
    CREATE TYPE timerange AS RANGE (subtype = time);

    -- ───────────────────────────── hosts ─────────────────────────────
    CREATE TABLE hosts (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug          text NOT NULL,
      name          text NOT NULL,
      email         text NOT NULL,
      password_hash text NOT NULL,
      timezone      text NOT NULL,          -- IANA; validated by the API with Intl
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hosts_slug_unique   UNIQUE (slug),
      CONSTRAINT hosts_email_unique  UNIQUE (email),
      CONSTRAINT hosts_slug_format   CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 64),
      CONSTRAINT hosts_email_lower   CHECK (email = lower(email) AND position('@' IN email) > 1),
      CONSTRAINT hosts_name_length   CHECK (length(name) BETWEEN 1 AND 200)
    );

    CREATE TABLE host_sessions (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id     uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      token_hash  bytea NOT NULL,          -- sha256(cookie value); raw value never stored
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      CONSTRAINT host_sessions_token_hash_unique UNIQUE (token_hash),
      CONSTRAINT host_sessions_token_hash_len    CHECK (length(token_hash) = 32)
    );
    CREATE INDEX host_sessions_host_idx ON host_sessions (host_id);

    -- ─────────────────────────── event types ─────────────────────────
    CREATE TABLE event_types (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id           uuid NOT NULL REFERENCES hosts(id),
      name              text NOT NULL,
      slug              text NOT NULL,
      duration_min      integer NOT NULL,
      capacity          integer NOT NULL DEFAULT 1,
      buffer_before_min integer NOT NULL DEFAULT 0,
      buffer_after_min  integer NOT NULL DEFAULT 0,
      min_notice_min    integer NOT NULL DEFAULT 0,
      horizon_days      integer NOT NULL DEFAULT 30,
      active            boolean NOT NULL DEFAULT true,
      created_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT event_types_host_slug_unique UNIQUE (host_id, slug),
      CONSTRAINT event_types_id_host_unique   UNIQUE (id, host_id),   -- target of composite FKs
      CONSTRAINT event_types_slug_format      CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 64),
      CONSTRAINT event_types_name_length      CHECK (length(name) BETWEEN 1 AND 200),
      CONSTRAINT event_types_duration_range   CHECK (duration_min BETWEEN 15 AND 120),
      CONSTRAINT event_types_capacity_min     CHECK (capacity >= 1),
      CONSTRAINT event_types_buffer_before    CHECK (buffer_before_min BETWEEN 0 AND 30),
      CONSTRAINT event_types_buffer_after     CHECK (buffer_after_min BETWEEN 0 AND 30),
      CONSTRAINT event_types_min_notice       CHECK (min_notice_min >= 0),
      CONSTRAINT event_types_horizon          CHECK (horizon_days BETWEEN 1 AND 365)
    );

    -- ─────────────────────────── availability ────────────────────────
    CREATE TABLE availability_rules (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id     uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      weekday     smallint NOT NULL,       -- ISO: 1 = Mon … 7 = Sun (= Luxon DateTime.weekday)
      start_time  time NOT NULL,
      end_time    time NOT NULL,
      CONSTRAINT availability_rules_weekday_iso CHECK (weekday BETWEEN 1 AND 7),
      CONSTRAINT availability_rules_time_order  CHECK (end_time > start_time),
      CONSTRAINT availability_rules_no_overlap  EXCLUDE USING gist (
        host_id WITH =, weekday WITH =, timerange(start_time, end_time) WITH &&)
    );

    -- One row per overridden date. kind = 'off' (day off) or 'custom' (own windows).
    CREATE TABLE date_overrides (
      host_id  uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      date     date NOT NULL,
      kind     text NOT NULL,
      CONSTRAINT date_overrides_pkey       PRIMARY KEY (host_id, date),
      CONSTRAINT date_overrides_kind_valid CHECK (kind IN ('off', 'custom')),
      CONSTRAINT date_overrides_kind_key   UNIQUE (host_id, date, kind)   -- target of the composite FK
    );

    -- Windows may only hang off a 'custom' override: the FK includes kind, and kind is pinned
    -- to 'custom' here, so a day-off date can never also have hours. Flipping an override from
    -- 'custom' to 'off' while windows exist fails the FK (ON UPDATE NO ACTION).
    CREATE TABLE date_override_windows (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id     uuid NOT NULL,
      date        date NOT NULL,
      kind        text NOT NULL DEFAULT 'custom',
      start_time  time NOT NULL,
      end_time    time NOT NULL,
      CONSTRAINT date_override_windows_kind_custom CHECK (kind = 'custom'),
      CONSTRAINT date_override_windows_time_order  CHECK (end_time > start_time),
      CONSTRAINT date_override_windows_override_fk FOREIGN KEY (host_id, date, kind)
        REFERENCES date_overrides (host_id, date, kind) ON DELETE CASCADE,
      CONSTRAINT date_override_windows_no_overlap  EXCLUDE USING gist (
        host_id WITH =, date WITH =, timerange(start_time, end_time) WITH &&)
    );

    -- ─────────────────────────── occupancies ─────────────────────────
    -- One row per occupied session of a host; Postgres enforces no-overlap + capacity here.
    CREATE TABLE occupancies (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id        uuid NOT NULL,
      event_type_id  uuid NOT NULL,
      start_at       timestamptz NOT NULL,
      end_at         timestamptz NOT NULL,
      blocked        tstzrange NOT NULL,    -- [start - buffer_before, end + buffer_after)
      capacity       integer NOT NULL,      -- snapshot of event_types.capacity
      seats_taken    integer NOT NULL DEFAULT 0,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT occupancies_id_host_unique        UNIQUE (id, host_id),
      CONSTRAINT occupancies_event_slot_unique     UNIQUE (event_type_id, start_at),
      CONSTRAINT occupancies_event_type_fk         FOREIGN KEY (event_type_id, host_id)
        REFERENCES event_types (id, host_id),
      CONSTRAINT occupancies_time_order            CHECK (end_at > start_at),
      CONSTRAINT occupancies_blocked_covers        CHECK (blocked @> tstzrange(start_at, end_at)),
      CONSTRAINT occupancies_capacity_min          CHECK (capacity >= 1),
      CONSTRAINT occupancies_seats_within_capacity CHECK (seats_taken BETWEEN 0 AND capacity),
      CONSTRAINT occupancies_no_overlap            EXCLUDE USING gist (
        host_id WITH =, blocked WITH &&) WHERE (seats_taken > 0)
    );

    -- ───────────────────────────── bookings ──────────────────────────
    CREATE TABLE bookings (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id            uuid NOT NULL,
      event_type_id      uuid NOT NULL,
      occupancy_id       uuid NOT NULL,
      status             booking_status NOT NULL,
      start_at           timestamptz NOT NULL,
      end_at             timestamptz NOT NULL,
      expires_at         timestamptz,
      client_ip          inet,
      guest_name         text,
      guest_email        text,
      guest_tz           text,
      manage_token_hash  bytea,
      cancel_reason      text,
      cancelled_by       text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      confirmed_at       timestamptz,
      cancelled_at       timestamptz,
      CONSTRAINT bookings_event_type_fk FOREIGN KEY (event_type_id, host_id)
        REFERENCES event_types (id, host_id),
      CONSTRAINT bookings_occupancy_fk  FOREIGN KEY (occupancy_id, host_id)
        REFERENCES occupancies (id, host_id),
      CONSTRAINT bookings_manage_token_hash_unique UNIQUE (manage_token_hash),
      CONSTRAINT bookings_manage_token_hash_len    CHECK (manage_token_hash IS NULL OR length(manage_token_hash) = 32),
      CONSTRAINT bookings_time_order               CHECK (end_at > start_at),
      CONSTRAINT bookings_cancelled_by_valid       CHECK (cancelled_by IS NULL OR cancelled_by IN ('host', 'guest')),
      -- Data shape per status (not transitions):
      CONSTRAINT bookings_held_shape      CHECK (status <> 'held' OR expires_at IS NOT NULL),
      CONSTRAINT bookings_confirmed_shape CHECK (status <> 'confirmed' OR (
        guest_name IS NOT NULL AND guest_email IS NOT NULL
        AND manage_token_hash IS NOT NULL AND confirmed_at IS NOT NULL)),
      CONSTRAINT bookings_cancelled_shape CHECK (status <> 'cancelled' OR (
        cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
    );
    CREATE INDEX bookings_occupancy_idx   ON bookings (occupancy_id);
    CREATE INDEX bookings_host_start_idx  ON bookings (host_id, start_at);
    CREATE INDEX bookings_held_expiry_idx ON bookings (host_id, expires_at) WHERE status = 'held';
    CREATE INDEX bookings_held_ip_idx     ON bookings (client_ip) WHERE status = 'held';

    CREATE TABLE booking_events (
      id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      booking_id   uuid NOT NULL REFERENCES bookings(id),
      type         text NOT NULL,
      from_status  booking_status,
      to_status    booking_status,
      payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
      at           timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX booking_events_booking_idx ON booking_events (booking_id);

    -- ─────────────────────── idempotency + outbox ────────────────────
    CREATE TABLE idempotency_keys (
      scope            text NOT NULL,
      key              text NOT NULL,
      request_hash     bytea NOT NULL,
      response_status  integer,
      response_body    jsonb,               -- never contains secrets (design §5.0)
      created_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT idempotency_keys_pkey      PRIMARY KEY (scope, key),
      CONSTRAINT idempotency_keys_key_len   CHECK (length(key) BETWEEN 8 AND 128),
      CONSTRAINT idempotency_keys_response  CHECK ((response_status IS NULL) = (response_body IS NULL))
    );
    CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

    CREATE TABLE notifications (
      id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      booking_id       uuid NOT NULL REFERENCES bookings(id),
      type             text NOT NULL,
      payload          jsonb NOT NULL,      -- never contains tokens (design §5.0)
      created_at       timestamptz NOT NULL DEFAULT now(),
      attempts         integer NOT NULL DEFAULT 0,
      next_attempt_at  timestamptz NOT NULL DEFAULT now(),
      delivered_at     timestamptz,
      last_error       text,
      CONSTRAINT notifications_type_valid CHECK (type IN ('booking.confirmed', 'booking.rescheduled', 'booking.cancelled'))
    );
    CREATE INDEX notifications_pending_idx ON notifications (next_attempt_at) WHERE delivered_at IS NULL;

    -- ───────────────────── seat counter (design §4.1) ─────────────────
    -- The only writer of occupancies.seats_taken. active := status IN ('held','confirmed').
    -- Release the old seat BEFORE claiming the new one, so a reschedule onto a session that
    -- overlaps only its own old session succeeds. Constraint violations raised by these UPDATEs
    -- (23P01 exclusion, 23514 check) surface from the INSERT/UPDATE on bookings.
    CREATE FUNCTION bookings_maintain_seats() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
      old_active boolean := TG_OP = 'UPDATE' AND OLD.status IN ('held', 'confirmed');
      new_active boolean := NEW.status IN ('held', 'confirmed');
      moved      boolean := TG_OP = 'UPDATE' AND NEW.occupancy_id <> OLD.occupancy_id;
    BEGIN
      IF old_active AND (NOT new_active OR moved) THEN
        UPDATE occupancies SET seats_taken = seats_taken - 1, updated_at = now()
         WHERE id = OLD.occupancy_id;
      END IF;
      IF new_active AND (NOT old_active OR moved) THEN
        UPDATE occupancies SET seats_taken = seats_taken + 1, updated_at = now()
         WHERE id = NEW.occupancy_id;
      END IF;
      RETURN NULL;
    END
    $fn$;

    CREATE TRIGGER bookings_maintain_seats
      AFTER INSERT OR UPDATE OF status, occupancy_id ON bookings
      FOR EACH ROW EXECUTE FUNCTION bookings_maintain_seats();

    -- Bookings are append-only history: DELETE would silently skip the seat counter, so it is
    -- refused outright. Cancel or expire instead. (TRUNCATE is not a row event; tests use it
    -- on bookings + occupancies together.)
    CREATE FUNCTION bookings_block_delete() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'bookings are append-only; cancel or expire booking % instead', OLD.id
        USING ERRCODE = 'restrict_violation';
    END
    $fn$;

    CREATE TRIGGER bookings_no_delete
      BEFORE DELETE ON bookings
      FOR EACH ROW EXECUTE FUNCTION bookings_block_delete();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS notifications, idempotency_keys, booking_events, bookings, occupancies,
      date_override_windows, date_overrides, availability_rules, event_types, host_sessions, hosts;
    DROP FUNCTION IF EXISTS bookings_maintain_seats();
    DROP FUNCTION IF EXISTS bookings_block_delete();
    DROP TYPE IF EXISTS timerange;
    DROP TYPE IF EXISTS booking_status;
  `.execute(db);
}
