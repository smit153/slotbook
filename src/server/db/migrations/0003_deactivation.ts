import { sql, type Kysely } from 'kysely';

/**
 * Deactivate, never delete (design §4.2). Bookings are append-only, so the rows they
 * depend on (event types, hosts) must not disappear either:
 *  - hosts get an `active` flag (event_types already has one)
 *  - DELETE on hosts and event_types is refused, like DELETE on bookings
 * Config tables that hold no booking data (sessions, availability, overrides) can still be
 * deleted and keep their ON DELETE CASCADE from hosts — but since host DELETE is refused,
 * that cascade only matters to admin operations run with the trigger disabled.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE hosts ADD COLUMN active boolean NOT NULL DEFAULT true;

    CREATE FUNCTION block_delete_deactivate_instead() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION '% rows cannot be deleted; set active = false instead (id %)', TG_TABLE_NAME, OLD.id
        USING ERRCODE = 'restrict_violation';
    END
    $fn$;

    CREATE TRIGGER hosts_no_delete
      BEFORE DELETE ON hosts
      FOR EACH ROW EXECUTE FUNCTION block_delete_deactivate_instead();

    CREATE TRIGGER event_types_no_delete
      BEFORE DELETE ON event_types
      FOR EACH ROW EXECUTE FUNCTION block_delete_deactivate_instead();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS event_types_no_delete ON event_types;
    DROP TRIGGER IF EXISTS hosts_no_delete ON hosts;
    DROP FUNCTION IF EXISTS block_delete_deactivate_instead();
    ALTER TABLE hosts DROP COLUMN IF EXISTS active;
  `.execute(db);
}
