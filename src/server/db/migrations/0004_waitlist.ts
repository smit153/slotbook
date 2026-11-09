import { sql, type Kysely } from 'kysely';

/**
 * Waitlist (design §13). An offer IS a held booking linked to its entry, so the seat trigger,
 * the exclusion/capacity constraints and the expiry/confirm paths all apply unchanged.
 *  - waitlist_entries: FIFO by `seq`; one ACTIVE entry per email per slot; append-only.
 *  - bookings.waitlist_entry_id: the offer (or the booking it became). Offers carry no
 *    client_ip, so they never count toward the per-IP hold cap.
 *  - notifications: + 'waitlist.offered' (outbox row for a future email dispatcher).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE waitlist_status AS ENUM ('waiting', 'offered', 'booked', 'lapsed', 'left', 'closed');

    CREATE TABLE waitlist_entries (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seq            bigint GENERATED ALWAYS AS IDENTITY,
      host_id        uuid NOT NULL,
      event_type_id  uuid NOT NULL,
      start_at       timestamptz NOT NULL,
      name           text NOT NULL,
      email          text NOT NULL,
      guest_tz       text NOT NULL,
      client_ip      inet,
      status         waitlist_status NOT NULL DEFAULT 'waiting',
      created_at     timestamptz NOT NULL DEFAULT now(),
      offered_at     timestamptz,
      resolved_at    timestamptz,
      CONSTRAINT waitlist_entries_seq_unique     UNIQUE (seq),
      CONSTRAINT waitlist_entries_event_type_fk  FOREIGN KEY (event_type_id, host_id)
        REFERENCES event_types (id, host_id),
      CONSTRAINT waitlist_entries_email_lower    CHECK (email = lower(email) AND position('@' IN email) > 1),
      CONSTRAINT waitlist_entries_name_length    CHECK (length(name) BETWEEN 1 AND 200),
      CONSTRAINT waitlist_entries_offered_shape  CHECK (status <> 'offered' OR offered_at IS NOT NULL),
      CONSTRAINT waitlist_entries_final_shape    CHECK (status IN ('waiting', 'offered') OR resolved_at IS NOT NULL)
    );
    -- One ACTIVE entry per email per slot (rejoining after lapsing or leaving is allowed).
    CREATE UNIQUE INDEX waitlist_entries_one_active_per_email
      ON waitlist_entries (event_type_id, start_at, email) WHERE status IN ('waiting', 'offered');
    -- FIFO lookups for the handoff, and "does this host have anyone waiting at all?".
    CREATE INDEX waitlist_entries_waiting_fifo ON waitlist_entries (event_type_id, start_at, seq) WHERE status = 'waiting';
    CREATE INDEX waitlist_entries_waiting_host ON waitlist_entries (host_id) WHERE status = 'waiting';
    CREATE INDEX waitlist_entries_active_ip    ON waitlist_entries (client_ip) WHERE status IN ('waiting', 'offered');

    CREATE FUNCTION waitlist_block_delete() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'waitlist entries are append-only; leave or close entry % instead', OLD.id
        USING ERRCODE = 'restrict_violation';
    END
    $fn$;
    CREATE TRIGGER waitlist_entries_no_delete
      BEFORE DELETE ON waitlist_entries
      FOR EACH ROW EXECUTE FUNCTION waitlist_block_delete();

    ALTER TABLE bookings ADD COLUMN waitlist_entry_id uuid REFERENCES waitlist_entries (id);
    ALTER TABLE bookings ADD CONSTRAINT bookings_waitlist_entry_unique UNIQUE (waitlist_entry_id);
    ALTER TABLE bookings ADD CONSTRAINT bookings_offer_has_no_ip CHECK (waitlist_entry_id IS NULL OR client_ip IS NULL);

    ALTER TABLE notifications DROP CONSTRAINT notifications_type_valid;
    ALTER TABLE notifications ADD CONSTRAINT notifications_type_valid
      CHECK (type IN ('booking.confirmed', 'booking.rescheduled', 'booking.cancelled', 'waitlist.offered'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE notifications DROP CONSTRAINT notifications_type_valid;
    ALTER TABLE notifications ADD CONSTRAINT notifications_type_valid
      CHECK (type IN ('booking.confirmed', 'booking.rescheduled', 'booking.cancelled'));
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_offer_has_no_ip;
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_waitlist_entry_unique;
    ALTER TABLE bookings DROP COLUMN IF EXISTS waitlist_entry_id;
    DROP TRIGGER IF EXISTS waitlist_entries_no_delete ON waitlist_entries;
    DROP FUNCTION IF EXISTS waitlist_block_delete();
    DROP TABLE IF EXISTS waitlist_entries;
    DROP TYPE IF EXISTS waitlist_status;
  `.execute(db);
}
