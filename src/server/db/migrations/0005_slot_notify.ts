import { sql, type Kysely } from 'kysely';

/**
 * Live slot updates (Phase 14). Every change that can alter a host's offered slots fires
 * pg_notify('slots_changed', host_id) from a trigger, i.e. INSIDE the writing transaction:
 *  - Postgres delivers notifications only when that transaction COMMITS, so a rolled-back
 *    change never notifies (no false "slots changed").
 *  - Identical notifications in one transaction are delivered once, so a statement touching
 *    many rows of one host still sends one message.
 *  - Being a trigger, no write path can forget it.
 * The payload is only the host id: never booking or guest data.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION notify_slots_changed() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
      h uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.host_id ELSE NEW.host_id END;
    BEGIN
      PERFORM pg_notify('slots_changed', h::text);
      RETURN NULL;
    END
    $fn$;

    CREATE TRIGGER bookings_notify_slots AFTER INSERT OR UPDATE OF status, occupancy_id ON bookings
      FOR EACH ROW EXECUTE FUNCTION notify_slots_changed();
    CREATE TRIGGER waitlist_notify_slots AFTER INSERT OR UPDATE OF status ON waitlist_entries
      FOR EACH ROW EXECUTE FUNCTION notify_slots_changed();
    CREATE TRIGGER availability_rules_notify_slots AFTER INSERT OR UPDATE OR DELETE ON availability_rules
      FOR EACH ROW EXECUTE FUNCTION notify_slots_changed();
    CREATE TRIGGER date_overrides_notify_slots AFTER INSERT OR UPDATE OR DELETE ON date_overrides
      FOR EACH ROW EXECUTE FUNCTION notify_slots_changed();
    CREATE TRIGGER date_override_windows_notify_slots AFTER INSERT OR UPDATE OR DELETE ON date_override_windows
      FOR EACH ROW EXECUTE FUNCTION notify_slots_changed();
    CREATE TRIGGER event_types_notify_slots AFTER INSERT OR UPDATE ON event_types
      FOR EACH ROW EXECUTE FUNCTION notify_slots_changed();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS event_types_notify_slots ON event_types;
    DROP TRIGGER IF EXISTS date_override_windows_notify_slots ON date_override_windows;
    DROP TRIGGER IF EXISTS date_overrides_notify_slots ON date_overrides;
    DROP TRIGGER IF EXISTS availability_rules_notify_slots ON availability_rules;
    DROP TRIGGER IF EXISTS waitlist_notify_slots ON waitlist_entries;
    DROP TRIGGER IF EXISTS bookings_notify_slots ON bookings;
    DROP FUNCTION IF EXISTS notify_slots_changed();
  `.execute(db);
}
