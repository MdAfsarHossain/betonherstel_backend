import { Pool } from "pg";
import dotenv from "dotenv";
import { relationEventTypes } from "../app/modules/relation/relation.interface";
import { notificationTypes } from "../app/modules/messages/notification.types";

// Enum values as an SQL list: 'NOTE', 'OTHER', ... (constants from the code, never user input)
const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

// The timeline events, and the notification kinds. OTHER is a fallback for an old row whose value is not known any
// more; the code never writes it. Both lists live in the code, so a new kind compiles everywhere it is used.
const eventValues = sqlList(relationEventTypes);
const notificationValues = sqlList([...notificationTypes, "OTHER"]);

// Creates an enum with these values, or adds the values an existing one does not have yet (ADD VALUE IF NOT
// EXISTS, outside a transaction so the new value can be used at once). Used for lists that grow with the code.
const ensureEnum = async (client: any, name: string, values: readonly string[]) => {
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${name}') THEN
            CREATE TYPE "${name}" AS ENUM (${sqlList(values)});
        END IF;
    END $$;
  `);
  const known = await client.query(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1`,
    [name],
  );
  const knownNames = new Set(known.rows.map((row: any) => row.enumlabel));
  for (const value of values) {
    if (!knownNames.has(value)) {
      await client.query(`ALTER TYPE "${name}" ADD VALUE IF NOT EXISTS '${value}'`);
    }
  }
};

interface IEnumColumn {
  column: string;
  type: string;
  // the column's default, given again as the enum value (the old VARCHAR default cannot be cast on its own)
  default?: string;
}

// A database made before an enum has its column as VARCHAR + a CHECK named `<table>_<column>_check`: turn the columns
// into the enums once. All of one table's columns are converted in ONE `ALTER TABLE` (the table is rewritten once)
// and inside ONE transaction, so a row that does not fit the enum rolls everything back instead of leaving a half
// converted table. Rows keep their value. `dropConstraints` are other constraints that read the column (they are
// dropped first); `afterSql` makes them again, against the enum. A no-op (and quick) once the columns are enums.
// Names are constants from the code, never user input.
const convertColumnsToEnums = async (
  client: any,
  table: string,
  columns: IEnumColumn[],
  options: { dropConstraints?: string[]; afterSql?: string[] } = {},
) => {
  const found = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[]) AND data_type = 'character varying'`,
    [table, columns.map((c) => c.column)],
  );
  const todo = columns.filter((c) => found.rows.some((row: any) => row.column_name === c.column));
  if (todo.length === 0) return false;

  await client.query("BEGIN");
  try {
    for (const name of options.dropConstraints ?? []) {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`);
    }
    for (const c of todo) {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_${c.column}_check`);
      if (c.default) await client.query(`ALTER TABLE ${table} ALTER COLUMN ${c.column} DROP DEFAULT`);
    }
    await client.query(
      `ALTER TABLE ${table} ${todo.map((c) => `ALTER COLUMN ${c.column} TYPE "${c.type}" USING ${c.column}::"${c.type}"`).join(", ")}`,
    );
    for (const c of todo) {
      if (c.default) await client.query(`ALTER TABLE ${table} ALTER COLUMN ${c.column} SET DEFAULT '${c.default}'`);
    }
    for (const sql of options.afterSql ?? []) await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return true;
};

dotenv.config();

// Connection pool for regular queries (using pooled connection)
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  // Maximum number of clients in the pool. Supabase's pooler (Supavisor, session mode) only allows `pool_size`
  // clients (often 15) and answers EMAXCONNSESSION above it, so stay below it: DB_POOL_MAX (default 10).
  // With several server instances, each has its own pool: use floor(pool_size / instances).
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true, // Keep connections alive
  keepAliveInitialDelayMillis: 10000, // Initial delay for keepalive
  statement_timeout: 30000, // Statement timeout (30 seconds)
  query_timeout: 20000, // Query timeout (20 seconds)
};

// Direct connection for migrations (using direct URL)
const directPoolConfig = {
  connectionString: process.env.DIRECT_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: Number(process.env.DIRECT_POOL_MAX) || 2, // only used for the schema setup at start-up
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
  keepAlive: true,
};

// Create connection pools
export const pool = new Pool(poolConfig);
export const directPool = new Pool(directPoolConfig);

// A connection that the database drops (restart, failover, network blip) emits "error" on its client.
// The pool listens while a client is idle, and pool.query() listens only until the FIRST error; a dying
// connection often emits a second one ("Connection terminated unexpectedly"). An "error" event nobody
// listens to is uncaught in Node and the whole server exits. So every client gets a permanent listener
// when it is created; the pool then discards the dead connection and opens a new one on the next query.
pool.on("connect", (client) => {
  client.on("error", (error) => {
    console.error("❌ Database connection error (the connection is replaced):", error.message);
  });
});
directPool.on("connect", (client) => {
  client.on("error", (error) => {
    console.error("❌ Direct database connection error:", error.message);
  });
});
pool.on("error", (error) => {
  console.error("❌ Database pool error (connection dropped, will reconnect):", error.message);
});
directPool.on("error", (error) => {
  console.error("❌ Direct database pool error:", error.message);
});

// Test database connection
export const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log("✅ Database connected successfully via pooled connection");
    client.release();

    const directClient = await directPool.connect();
    console.log("✅ Direct database connection successful");
    directClient.release();

    return true;
  } catch (error) {
    console.error("❌ Database connection error:", error);
    return false;
  }
};

const createEnumsWithDOBlock = async (client: any) => {
  await client.query(`
    DO $$ 
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlanType') THEN
            CREATE TYPE "PlanType" AS ENUM ('PREMIUM', 'FREE');
        END IF;
    END $$;
  `);

  await client.query(`
    DO $$ 
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role') THEN
            CREATE TYPE "Role" AS ENUM ('SUPERADMIN', 'ADMIN', 'USER', 'BUSINESS', 'OFFICE', 'FIELD', 'CUSTOMER', 'SUBCONTRACTOR');
        END IF;
    END $$;
  `);

  await client.query(`
    DO $$ 
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserStatus') THEN
            CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'BLOCKED', 'AVAILABLE', 'UNAVAILABLE');
        END IF;
    END $$;
  `);

  // -- CRM roles (SRS 3.1): ADMIN = Beheerder, OFFICE = Kantoor, FIELD = Uitvoerder,
  // -- CUSTOMER = Klant, SUBCONTRACTOR = Onderaannemer.
  // -- (New enum values cannot be used inside the same transaction that adds them.)
  // await client.query(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'OFFICE';`);
  // await client.query(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FIELD';`);
  // await client.query(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CUSTOMER';`);
  // await client.query(
  //   `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUBCONTRACTOR';`,
  // );

  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Language') THEN
            CREATE TYPE "Language" AS ENUM ('NL', 'EN');
        END IF;
    END $$;
  `);

  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RelationType') THEN
            CREATE TYPE "RelationType" AS ENUM ('PRIVATE', 'BUSINESS', 'VVE', 'SUPPLIER', 'SUBCONTRACTOR');
        END IF;
    END $$;
  `);

  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppointmentType') THEN
            CREATE TYPE "AppointmentType" AS ENUM ('INSPECTION', 'PROJECT_WORK', 'MAINTENANCE', 'INTERNAL');
        END IF;
    END $$;
  `);

  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppointmentStatus') THEN
            CREATE TYPE "AppointmentStatus" AS ENUM ('PLANNED', 'COMPLETED', 'CANCELLED');
        END IF;
    END $$;
  `);

  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QuoteStatus') THEN
            CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');
        END IF;
    END $$;
  `);

  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InquirySource') THEN
            CREATE TYPE "InquirySource" AS ENUM ('FORM', 'WEBHOOK', 'PORTAL', 'PHONE', 'EMAIL', 'OTHER');
        END IF;
    END $$;
  `);

  // Uren: what kind of hours an entry is, and where it is in the weekly approval
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TimeEntryType') THEN
            CREATE TYPE "TimeEntryType" AS ENUM ('WORK', 'TRAVEL', 'INSPECTION', 'INTERNAL');
        END IF;
    END $$;
  `);
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TimeEntryStatus') THEN
            CREATE TYPE "TimeEntryStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');
        END IF;
    END $$;
  `);

  // Inkoop: a supplier's invoice (Ontvangen -> Goedgekeurd -> Betaald, or VOID for a mistake)
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SupplierInvoiceStatus') THEN
            CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('RECEIVED', 'APPROVED', 'PAID', 'VOID');
        END IF;
    END $$;
  `);

  // Uitbesteden: an assignment to a subcontractor, and how the subcontractor's answer reached us
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubcontractAssignmentStatus') THEN
            CREATE TYPE "SubcontractAssignmentStatus" AS ENUM ('DRAFT', 'SENT', 'CONFIRMED', 'DECLINED', 'COMPLETED', 'INVOICED', 'CANCELLED');
        END IF;
    END $$;
  `);
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubcontractResponseVia') THEN
            CREATE TYPE "SubcontractResponseVia" AS ENUM ('PHONE', 'EMAIL', 'IN_PERSON', 'OTHER', 'PORTAL');
        END IF;
    END $$;
  `);

  // Every kind of event on a relation's timeline. The list lives in the code (relation.interface.ts), so a new kind
  // of event compiles everywhere it is used; here it is created, and values that were added to the list later are
  // added to an existing database (ADD VALUE IF NOT EXISTS, outside a transaction so the value can be used at once).
  await ensureEnum(client, "RelationEventType", relationEventTypes);

  // Notifications: what a notification is about (the list is notification.types.ts, plus the OTHER fallback)
  await ensureEnum(client, "NotificationType", [...notificationTypes, "OTHER"]);

  // Projecten: the folders of a project's files (before / during / after the work, or general)
  await ensureEnum(client, "ProjectFileFolder", ["BEFORE", "DURING", "AFTER", "GENERAL"]);

  // Facturen: what kind of document an invoice is, where it came from, whether it is issued, and where it is in
  // being paid (`payment_status` is empty for a draft)
  await ensureEnum(client, "InvoiceKind", ["STANDARD", "INSTALMENT", "FINAL", "CREDIT_NOTE"]);
  await ensureEnum(client, "InvoiceSource", ["MANUAL", "QUOTE", "PROJECT", "INSTALMENT", "FINAL", "CREDIT"]);
  await ensureEnum(client, "InvoiceStatus", ["DRAFT", "ISSUED"]);
  await ensureEnum(client, "InvoicePaymentStatus", ["OPEN", "PARTIALLY_PAID", "PAID", "CREDITED"]);
  await ensureEnum(client, "InvoiceLineType", ["MANUAL", "QUOTE", "PROJECT", "HOURS", "INSTALMENT", "DEDUCTION", "CREDIT"]);
  await ensureEnum(client, "InvoicePaymentMethod", ["MOLLIE", "BANK", "OTHER"]);
  await ensureEnum(client, "InvoiceReminderKind", ["AUTOMATIC", "MANUAL"]);
  await ensureEnum(client, "InvoiceReminderStatus", ["SENT", "SKIPPED"]);

  // E-mail: the result of sending one (the email log)
  await ensureEnum(client, "EmailStatus", ["SENT", "FAILED"]);

  // Abonnementen: whether the customer's direct-debit set-up was asked for by the office or the customer
  await ensureEnum(client, "DirectDebitRequestedVia", ["OFFICE", "PORTAL"]);

  // Catalogus: what a catalogue item is (a material, a labour rate or a service)
  await ensureEnum(client, "CatalogueItemType", ["MATERIAL", "LABOUR", "SERVICE"]);

  // Acties: a task is open or done, and was made by a person or automatically for an event
  await ensureEnum(client, "ActionStatus", ["OPEN", "DONE"]);
  await ensureEnum(client, "ActionSource", ["MANUAL", "AUTOMATIC"]);

  // Chat: a project's channels (customer, internal, one per subcontractor) and the staff conversations (one-to-one, group)
  await ensureEnum(client, "ChatChannelKind", ["CUSTOMER", "INTERNAL", "SUBCONTRACTOR", "DIRECT", "GROUP"]);

  // Offertes: how an acceptance reached us (the customer portal, or the office records it)
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QuoteAcceptedVia') THEN
            CREATE TYPE "QuoteAcceptedVia" AS ENUM ('PORTAL', 'PHONE', 'EMAIL', 'IN_PERSON', 'OTHER');
        END IF;
    END $$;
  `);

  // Inkoop: a purchase order to a supplier (Concept -> Besteld -> Deels/Geheel ontvangen, or Geannuleerd)
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PurchaseOrderStatus') THEN
            CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');
        END IF;
    END $$;
  `);

  // Werkbon status: Open -> In uitvoering -> Afgerond -> Gecontroleerd (the order is the workflow)
  await client.query(`
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkOrderStatus') THEN
            CREATE TYPE "WorkOrderStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CHECKED');
        END IF;
    END $$;
  `);

  // await client.query(`
  //   ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'TRANSLATOR';
  // `);

  // await client.query(`
  //   ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'CONFIRMED';
  // `);
};

// Renames legacy camelCase timestamp columns ("createdAt"/"updatedAt") to
// snake_case on every public table that still has them. Idempotent: a no-op
// once applied, and skipped per-table if the snake_case column already exists.
const renameTimestampColumnsToSnakeCase = async (client: any) => {
  await client.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.column_name IN ('createdAt', 'updatedAt')
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = r.table_name
            AND column_name = CASE r.column_name
              WHEN 'createdAt' THEN 'created_at' ELSE 'updated_at' END
        ) THEN
          EXECUTE format(
            'ALTER TABLE public.%I RENAME COLUMN %I TO %I',
            r.table_name,
            r.column_name,
            CASE r.column_name WHEN 'createdAt' THEN 'created_at' ELSE 'updated_at' END
          );
        END IF;
      END LOOP;
    END $$;
  `);
};

// The columns below were originally created as `TIMESTAMP` (no time zone).
// Postgres/Supabase writes CURRENT_TIMESTAMP using the session's (UTC)
// timezone with no offset marker, so the raw stored digits are correct UTC —
// but `pg`'s driver has no way to know that, and constructs the returned JS
// Date using the *server process's* local timezone instead, silently
// shifting every timestamp by that offset. Converting the columns to
// `TIMESTAMPTZ` fixes this permanently. `AT TIME ZONE 'UTC'` on the existing
// naive values reinterprets those already-correct UTC digits as UTC instants
// (not a re-shift), so this is safe to run against tables with existing
// rows. Guarded by an information_schema check so it's a no-op once applied.
const migrateNaiveTimestampColumnsToTz = async (client: any) => {
  const columnsByTable: Record<string, string[]> = {
    users: ["created_at", "updated_at"],
    // blogs: ["created_at", "updated_at", "published_at"],
    // newsLetter: ["created_at", "updated_at"],
    // activityLog: ["created_at", "updated_at"],
    // otp: ["created_at", "updated_at", "expiry"],
    // notary: ["created_at", "updated_at"],
    // legal: ["created_at", "updated_at"],
    // accountant: ["created_at", "updated_at"],
    // translators: ["created_at", "updated_at"],
    // translator_bookings: ["created_at", "updated_at"],
    // documents: ["created_at", "updated_at"],
    // appointments: ["created_at", "updated_at", "start_date", "end_date"],
    // progress: ["created_at", "updated_at"],
    // chat_rooms: ["created_at", "updated_at"],
    // chat_messages: ["created_at", "updated_at"],
    // custom_pages: ["created_at", "updated_at"],
    // custom_page_people: ["created_at", "updated_at"],
    // custom_page_uploads: ["created_at"],
    // custom_page_checklist: ["created_at", "updated_at"],
    // custom_page_calendar: ["created_at", "appointment_at"],
    // custom_page_notes: ["created_at", "updated_at"],
  };

  for (const [table, columns] of Object.entries(columnsByTable)) {
    for (const column of columns) {
      await client.query(
        `
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}'
              AND column_name = '${column}'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE "${table}"
              ALTER COLUMN "${column}" TYPE TIMESTAMPTZ
              USING "${column}" AT TIME ZONE 'UTC';
          END IF;
        END $$;
        `,
      );
    }
  }
};

// Supabase's Data API (PostgREST) exposes any public-schema table with no
// RLS to anon/authenticated API callers. This app only talks to Postgres
// through this pool (never through the Data API), and the role behind
// DIRECT_URL/DATABASE_URL owns these tables so it bypasses RLS — enabling it
// here only closes off the public Data API, it does not affect this backend.
const enableRowLevelSecurity = async (client: any) => {
  await client.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
      END LOOP;
    END $$;
  `);
};

// Initialize database tables
export const initDatabase = async () => {
  const client = await directPool.connect();
  try {
    await client.query("BEGIN");
    // -- ============================================================
    // -- ENUMS
    // -- ============================================================

    // Create all ENUM types
    console.log("📝 Creating ENUM types...");

    // Method 1: Using function
    //   await createAllEnums(client);

    // OR Method 2: Using DO blocks
    await createEnumsWithDOBlock(client);

    console.log("✅ ENUM types created successfully");

    // -- ============================================================
    // -- TABLES
    // -- ============================================================

    // -- Users (staff + portal logins; business data lives in `relations`)
    await client.query(`CREATE TABLE IF NOT EXISTS users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    VARCHAR(255) NOT NULL,
  phone_number            VARCHAR(50),
  email                   VARCHAR(255) UNIQUE NOT NULL,
  password                TEXT,
  address                 TEXT,
  avatar                  TEXT,
  fcm_token               TEXT,
  date_of_birth           VARCHAR(50),
  is_email_verified       BOOLEAN DEFAULT false,
  is_verified             BOOLEAN DEFAULT false,
  is_active               BOOLEAN DEFAULT true,
  role                    "Role" DEFAULT 'USER',
  status                  "UserStatus" DEFAULT 'PENDING',
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);

    // Drop columns from the old SaaS/marketplace design that the CRM never uses.
    // (is_social/is_public/is_online/last_active: unused; stripe/mollie customer ids:
    // Mollie customers will be stored per relation; plan_type/start_date/
    // next_payment_date: old premium-plan billing, replaced by the Abonnementen module.)
    // Dropping a column also drops its index. Irreversible: back up before migrating.
    await client.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS is_social,
        DROP COLUMN IF EXISTS is_public,
        DROP COLUMN IF EXISTS is_online,
        DROP COLUMN IF EXISTS last_active,
        DROP COLUMN IF EXISTS stripe_customer_id,
        DROP COLUMN IF EXISTS mollie_customer_id,
        DROP COLUMN IF EXISTS plan_type,
        DROP COLUMN IF EXISTS start_date,
        DROP COLUMN IF EXISTS next_payment_date;
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_users_role             ON users (role);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_users_status           ON users (status);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_users_is_active        ON users (is_active);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_users_created_at       ON users (created_at);`,
    );

    // FR-I18N-02: preferred interface language per user (Dutch is the default)
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language "Language" DEFAULT 'NL';`,
    );

    // -- Relaties (contacts: customers, VvE, suppliers, subcontractors)
    await client.query(`CREATE TABLE IF NOT EXISTS relations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                    "RelationType" NOT NULL,
  name                    VARCHAR(255) NOT NULL,
  email                   VARCHAR(255),
  phone                   VARCHAR(50),
  kvk_number              VARCHAR(8),
  vat_number              VARCHAR(20),
  iban                    VARCHAR(34),
  payment_term_days       INTEGER CHECK (payment_term_days IS NULL OR payment_term_days BETWEEN 0 AND 365),
  invoice_email           VARCHAR(255),
  preferred_language      "Language" NOT NULL DEFAULT 'NL',
  billing_street          VARCHAR(255),
  billing_house_number    VARCHAR(20),
  billing_postcode        VARCHAR(12),
  billing_city            VARCHAR(100),
  billing_country         VARCHAR(2) NOT NULL DEFAULT 'NL',
  notes                   TEXT,
  snelstart_relation_id   VARCHAR(100),
  is_active               BOOLEAN NOT NULL DEFAULT true,
  is_imported             BOOLEAN NOT NULL DEFAULT false,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relations_type        ON relations (type);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relations_is_active   ON relations (is_active);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relations_created_at  ON relations (created_at);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relations_name_lower  ON relations (LOWER(name));`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relations_email_lower ON relations (LOWER(email));`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relations_kvk_number  ON relations (kvk_number);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relations_billing_pc  ON relations (UPPER(REPLACE(billing_postcode, ' ', '')));`,
    );

    // -- Relation contact persons (FR-REL-02)
    await client.query(`CREATE TABLE IF NOT EXISTS relation_contacts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  name                    VARCHAR(255) NOT NULL,
  role                    VARCHAR(100),
  phone                   VARCHAR(50),
  email                   VARCHAR(255),
  is_primary              BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relation_contacts_relation ON relation_contacts (relation_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relation_contacts_email    ON relation_contacts (LOWER(email));`,
    );
    // At most one primary contact per relation
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_relation_contacts_primary ON relation_contacts (relation_id) WHERE is_primary;`,
    );

    // -- Relation object addresses / work locations (FR-REL-03)
    await client.query(`CREATE TABLE IF NOT EXISTS relation_addresses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  label                   VARCHAR(100),
  street                  VARCHAR(255) NOT NULL,
  house_number            VARCHAR(20) NOT NULL,
  postcode                VARCHAR(12) NOT NULL,
  city                    VARCHAR(100) NOT NULL,
  country                 VARCHAR(2) NOT NULL DEFAULT 'NL',
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relation_addresses_relation ON relation_addresses (relation_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relation_addresses_pc_nr    ON relation_addresses (UPPER(REPLACE(postcode, ' ', '')), LOWER(house_number));`,
    );

    // -- Relation timeline (FR-REL-05): notes plus events logged by other modules
    await client.query(`CREATE TABLE IF NOT EXISTS relation_timeline (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  event_type              "RelationEventType" NOT NULL,
  entity_type             VARCHAR(50),
  entity_id               UUID,
  title                   VARCHAR(255) NOT NULL,
  description             TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  actor_id                UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    // A database made before the enum has event_type as VARCHAR(50): turn it into the enum once. A row whose type is
    // not a known event (the code never wrote one) becomes OTHER and keeps its old name in metadata, so nothing is
    // lost and the start-up is never stopped by it. A no-op once the column is the enum.
    const timelineIsText = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'relation_timeline'
         AND column_name = 'event_type' AND data_type = 'character varying'`,
    );
    if (timelineIsText.rows.length > 0) {
      await client.query(
        `UPDATE relation_timeline
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('original_event_type', event_type), event_type = 'OTHER'
         WHERE event_type NOT IN (${eventValues})`,
      );
      await client.query(
        `ALTER TABLE relation_timeline ALTER COLUMN event_type TYPE "RelationEventType" USING event_type::"RelationEventType"`,
      );
    }
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_relation_timeline_relation ON relation_timeline (relation_id, created_at DESC);`,
    );

    // -- Two-factor authentication (FR-AUTH-04). The secret is stored encrypted.
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS password_changed_at        TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS two_factor_secret          TEXT,
        ADD COLUMN IF NOT EXISTS two_factor_enabled         BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS two_factor_recovery_codes  TEXT[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS two_factor_last_step       BIGINT;
    `);

    // -- Password reset links (FR-AUTH-03). Only the SHA-256 hash of the token is stored.
    await client.query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash              TEXT NOT NULL UNIQUE,
  expires_at              TIMESTAMPTZ NOT NULL,
  used_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id);`,
    );

    // -- Company settings: a single row (id = 1) used on every document and email (FR-SET-01/02)
    await client.query(`CREATE TABLE IF NOT EXISTS company_settings (
  id                          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name                VARCHAR(255) NOT NULL DEFAULT 'Betonherstel.nl',
  email                       VARCHAR(255),
  phone                       VARCHAR(50),
  website                     VARCHAR(255),
  street                      VARCHAR(255),
  house_number                VARCHAR(20),
  postcode                    VARCHAR(12),
  city                        VARCHAR(100),
  country                     VARCHAR(2) NOT NULL DEFAULT 'NL',
  kvk_number                  VARCHAR(8),
  vat_number                  VARCHAR(20),
  iban                        VARCHAR(34),
  bic                         VARCHAR(11),
  bank_name                   VARCHAR(100),
  logo_url                    TEXT,
  default_payment_term_days   INTEGER NOT NULL DEFAULT 30 CHECK (default_payment_term_days BETWEEN 0 AND 365),
  quote_validity_days         INTEGER NOT NULL DEFAULT 30 CHECK (quote_validity_days BETWEEN 1 AND 365),
  quote_followup_days         INTEGER NOT NULL DEFAULT 7 CHECK (quote_followup_days BETWEEN 1 AND 90),
  reminder_days_after_due     INTEGER[] NOT NULL DEFAULT '{7,14,30}',
  vat_rates                   JSONB NOT NULL DEFAULT '[
    {"code":"21","label":"BTW 21%","rate":21,"reverse_charge":false},
    {"code":"9","label":"BTW 9%","rate":9,"reverse_charge":false},
    {"code":"0","label":"BTW 0%","rate":0,"reverse_charge":false},
    {"code":"VERLEGD","label":"BTW verlegd","rate":0,"reverse_charge":true}
  ]',
  number_formats              JSONB NOT NULL DEFAULT '{
    "inquiry":"AA-{YYYY}-{NNNN}",
    "project":"PR-{YYYY}-{NNNN}",
    "assignment":"SA-{YYYY}-{NNNN}",
    "subscription":"AB-{YYYY}-{NNNN}",
    "quote":"OFF-{YYYY}-{NNNN}",
    "invoice":"{YYYY}-{NNNN}",
    "credit_note":"CN-{YYYY}-{NNNN}",
    "work_order":"WB-{YYYY}-{NNNN}",
    "purchase_order":"PO-{YYYY}-{NNNN}"
  }',
  updated_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    // Client details from the SRS; the rest is filled in from Settings
    await client.query(`
      INSERT INTO company_settings (id, street, house_number, postcode, city, kvk_number)
      VALUES (1, 'Gouderakstraat', '42 B', '3079 DB', 'Rotterdam', '78445221')
      ON CONFLICT (id) DO NOTHING;
    `);

    // -- Gapless document numbers (FR-INV-04): one counter per document type and period
    await client.query(`CREATE TABLE IF NOT EXISTS document_sequences (
  doc_type                VARCHAR(30) NOT NULL,
  period                  VARCHAR(10) NOT NULL,
  last_number             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type, period)
);`);

    // -- Email templates edited in Settings (FR-SET-03). A missing row means "use the built-in default".
    await client.query(`CREATE TABLE IF NOT EXISTS email_templates (
  template_key            VARCHAR(50) NOT NULL,
  language                "Language" NOT NULL,
  subject                 VARCHAR(255) NOT NULL,
  body_html               TEXT NOT NULL,
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (template_key, language)
);`);

    // -- Every email the CRM sends, linked to the record it belongs to (FR-MSG-02)
    await client.query(`CREATE TABLE IF NOT EXISTS email_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email                VARCHAR(255) NOT NULL,
  subject                 VARCHAR(255) NOT NULL,
  template_key            VARCHAR(50),
  language                "Language",
  status                  "EmailStatus" NOT NULL,
  error                   TEXT,
  related_type            VARCHAR(50),
  related_id              UUID,
  sent_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await convertColumnsToEnums(client, "email_log", [{ column: "status", type: "EmailStatus" }]);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_email_log_related ON email_log (related_type, related_id, created_at DESC);`,
    );

    // -- Audit log of changes to financial records and settings (FR-SET-06)
    await client.query(`CREATE TABLE IF NOT EXISTS audit_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id                UUID REFERENCES users(id) ON DELETE SET NULL,
  action                  VARCHAR(30) NOT NULL,
  entity_type             VARCHAR(50) NOT NULL,
  entity_id               VARCHAR(100),
  changes                 JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, created_at DESC);`,
    );

    // Databases created before the inquiry module have no "inquiry" number format
    await client.query(`
      UPDATE company_settings
      SET number_formats = jsonb_build_object('inquiry', 'AA-{YYYY}-{NNNN}') || number_formats
      WHERE NOT (number_formats ? 'inquiry');
    `);
    // …and databases created before the project module have no "project" format
    await client.query(`
      UPDATE company_settings
      SET number_formats = jsonb_build_object('project', 'PR-{YYYY}-{NNNN}') || number_formats
      WHERE NOT (number_formats ? 'project');
    `);
    // ...and before subcontracting there was no "assignment" format
    await client.query(`
      UPDATE company_settings
      SET number_formats = jsonb_build_object('assignment', 'SA-{YYYY}-{NNNN}') || number_formats
      WHERE NOT (number_formats ? 'assignment');
    `);
    // ...and before the maintenance contracts there was no "subscription" format
    await client.query(`
      UPDATE company_settings
      SET number_formats = jsonb_build_object('subscription', 'AB-{YYYY}-{NNNN}') || number_formats
      WHERE NOT (number_formats ? 'subscription');
    `);

    // -- Service types (FR-SET-04): what Betonherstel.nl does. Used by inquiries now,
    // -- and by quotations and projects later. Edited in Settings.
    await client.query(`CREATE TABLE IF NOT EXISTS service_types (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                     VARCHAR(50) NOT NULL UNIQUE,
  label_nl                VARCHAR(100) NOT NULL,
  label_en                VARCHAR(100) NOT NULL,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(`
      INSERT INTO service_types (key, label_nl, label_en, sort_order) VALUES
        ('concrete_repair',     'Betonherstel',                'Concrete repair',       10),
        ('balcony_renovation',  'Balkonrenovatie',             'Balcony renovation',    20),
        ('floors_coatings',     'Kunststofvloeren en coatings','Synthetic floors and coatings', 30),
        ('joint_sealing',       'Voegwerk en kitwerk',         'Joint sealing',         40),
        ('facade_cleaning',     'Gevelreiniging',              'Facade cleaning',       50),
        ('impregnation',        'Impregneren',                 'Impregnation',          60),
        ('other',               'Overig',                      'Other',                 99)
      ON CONFLICT (key) DO NOTHING;
    `);

    // -- Inquiry statuses (FR-REQ-03): configurable. `kind` drives behaviour
    // -- (NEW = start of the pipeline, WON/LOST = closed, a lost reason is required for LOST).
    // -- System statuses are used by the code and cannot be removed or deactivated.
    await client.query(`CREATE TABLE IF NOT EXISTS inquiry_statuses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                     VARCHAR(50) NOT NULL UNIQUE,
  label_nl                VARCHAR(100) NOT NULL,
  label_en                VARCHAR(100) NOT NULL,
  kind                    VARCHAR(4) NOT NULL CHECK (kind IN ('NEW', 'OPEN', 'WON', 'LOST')),
  color                   VARCHAR(7) NOT NULL DEFAULT '#6b7280',
  sort_order              INTEGER NOT NULL DEFAULT 0,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  is_system               BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(`
      INSERT INTO inquiry_statuses (key, label_nl, label_en, kind, color, sort_order, is_system) VALUES
        ('nieuw',             'Nieuw',             'New',                 'NEW',  '#2563eb', 10, true),
        ('in_behandeling',    'In behandeling',    'In progress',         'OPEN', '#d97706', 20, false),
        ('schouw_gepland',    'Schouw gepland',    'Inspection planned',  'OPEN', '#7c3aed', 30, true),
        ('offerte_verstuurd', 'Offerte verstuurd', 'Quotation sent',      'OPEN', '#0891b2', 40, true),
        ('gewonnen',          'Gewonnen',          'Won',                 'WON',  '#16a34a', 50, true),
        ('verloren',          'Verloren',          'Lost',                'LOST', '#dc2626', 60, true)
      ON CONFLICT (key) DO NOTHING;
    `);

    // -- Inquiries / Aanvragen (SRS 4.4)
    await client.query(`CREATE TABLE IF NOT EXISTS inquiries (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               VARCHAR(30) NOT NULL UNIQUE,
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE RESTRICT,
  status_id               UUID NOT NULL REFERENCES inquiry_statuses(id),
  service_type_id         UUID REFERENCES service_types(id) ON DELETE SET NULL,
  source                  "InquirySource" NOT NULL,
  external_ref            VARCHAR(255),
  contact_name            VARCHAR(255) NOT NULL,
  contact_email           VARCHAR(255),
  contact_phone           VARCHAR(50),
  description             TEXT,
  street                  VARCHAR(255),
  house_number            VARCHAR(20),
  postcode                VARCHAR(12),
  city                    VARCHAR(100),
  country                 VARCHAR(2) NOT NULL DEFAULT 'NL',
  language                "Language" NOT NULL DEFAULT 'NL',
  lost_reason             TEXT,
  assigned_to             UUID REFERENCES users(id) ON DELETE SET NULL,
  first_opened_at         TIMESTAMPTZ,
  first_opened_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at               TIMESTAMPTZ,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT inquiries_contact_check CHECK (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_inquiries_status      ON inquiries (status_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_inquiries_relation    ON inquiries (relation_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_inquiries_created_at  ON inquiries (created_at DESC);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_inquiries_assigned_to ON inquiries (assigned_to);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_inquiries_unopened    ON inquiries (created_at DESC) WHERE first_opened_at IS NULL;`,
    );
    // The same website delivery (webhook retry, form double-submit) never creates two inquiries
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiries_external_ref ON inquiries (source, external_ref) WHERE external_ref IS NOT NULL;`,
    );

    // -- Photos / files uploaded with an inquiry (FR-REQ-02)
    await client.query(`CREATE TABLE IF NOT EXISTS inquiry_photos (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id              UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  file_url                TEXT NOT NULL,
  storage_key             TEXT NOT NULL,
  file_name               VARCHAR(255) NOT NULL,
  mime_type               VARCHAR(100) NOT NULL,
  size_bytes              INTEGER NOT NULL,
  uploaded_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_inquiry_photos_inquiry ON inquiry_photos (inquiry_id);`,
    );

    // -- Website webhook (FR-HOOK-01..06): one settings row (secret stored encrypted,
    // -- field mapping, on/off) and a log of every delivery, including rejected ones.
    await client.query(`CREATE TABLE IF NOT EXISTS website_webhook_settings (
  id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  secret_encrypted    TEXT,
  secret_hint         VARCHAR(8),
  secret_rotated_at   TIMESTAMPTZ,
  field_mapping       JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_language    "Language" NOT NULL DEFAULT 'NL',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `INSERT INTO website_webhook_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;`,
    );
    await client.query(`CREATE TABLE IF NOT EXISTS website_webhook_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status           VARCHAR(20) NOT NULL
                   CHECK (status IN ('ACCEPTED', 'DUPLICATE', 'REJECTED', 'INVALID', 'INACTIVE', 'ERROR')),
  http_status      INTEGER NOT NULL,
  inquiry_id       UUID REFERENCES inquiries(id) ON DELETE SET NULL,
  external_ref     VARCHAR(255),
  ip               VARCHAR(64),
  content_type     VARCHAR(100),
  payload_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
  error            TEXT
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_website_webhook_log_received ON website_webhook_log (received_at DESC);`,
    );

    // -- Catalogue (FR-QUO-03): standard materials, labour rates and services
    // -- that are reused as quotation lines. Prices are per unit, excluding VAT.
    // -- The table used to be called articles: an old one is renamed, so no data is lost.
    await client.query(`
      DO $$ BEGIN
        IF to_regclass('public.articles') IS NOT NULL AND to_regclass('public.catalogue_items') IS NULL THEN
          ALTER TABLE articles RENAME TO catalogue_items;
        END IF;
      END $$;
    `);
    await client.query(`CREATE TABLE IF NOT EXISTS catalogue_items (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    VARCHAR(50) UNIQUE,
  name                    VARCHAR(255) NOT NULL,
  description             TEXT,
  type                    "CatalogueItemType" NOT NULL DEFAULT 'MATERIAL',
  unit                    VARCHAR(10) NOT NULL DEFAULT 'piece' CHECK (unit IN ('m', 'm2', 'm3', 'piece', 'hour', 'lump_sum')),
  unit_price              NUMERIC(12,2) NOT NULL DEFAULT 0,
  cost_price              NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_code                VARCHAR(20) NOT NULL DEFAULT '21',
  service_type_id         UUID REFERENCES service_types(id) ON DELETE SET NULL,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    // The table was called articles once: a renamed old table keeps its check under the old name
    await convertColumnsToEnums(client, "catalogue_items", [{ column: "type", type: "CatalogueItemType", default: "MATERIAL" }], {
      dropConstraints: ["articles_type_check"],
    });
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_catalogue_items_name_lower ON catalogue_items (LOWER(name));`,
    );

    // -- Reusable quotation texts per service type and language (FR-QUO-05).
    // -- A row without a service type is the general text for that language.
    await client.query(`CREATE TABLE IF NOT EXISTS quote_templates (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type_id         UUID REFERENCES service_types(id) ON DELETE CASCADE,
  language                "Language" NOT NULL,
  intro_text              TEXT,
  scope_text              TEXT,
  conditions_text         TEXT,
  warranty_text           TEXT,
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_templates ON quote_templates (COALESCE(service_type_id, '00000000-0000-0000-0000-000000000000'::uuid), language);`,
    );

    // -- Quotations / Offertes (SRS 4.7). Each revision is its own row with the same
    // -- number; only one revision per number is current (FR-QUO-11).
    await client.query(`CREATE TABLE IF NOT EXISTS quotes (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  VARCHAR(30) NOT NULL,
  revision                INTEGER NOT NULL DEFAULT 1,
  is_current              BOOLEAN NOT NULL DEFAULT true,
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE RESTRICT,
  inquiry_id              UUID REFERENCES inquiries(id) ON DELETE SET NULL,
  service_type_id         UUID REFERENCES service_types(id) ON DELETE SET NULL,
  title                   VARCHAR(255) NOT NULL,
  language                "Language" NOT NULL DEFAULT 'NL',
  status                  "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
  recipient_name          VARCHAR(255),
  recipient_email         VARCHAR(255),
  street                  VARCHAR(255),
  house_number            VARCHAR(20),
  postcode                VARCHAR(12),
  city                    VARCHAR(100),
  country                 VARCHAR(2) NOT NULL DEFAULT 'NL',
  valid_until             DATE NOT NULL,
  intro_text              TEXT,
  scope_text              TEXT,
  conditions_text         TEXT,
  warranty_text           TEXT,
  internal_notes          TEXT,
  total_excl_vat          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_vat               NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_incl_vat          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_cost              NUMERIC(14,2) NOT NULL DEFAULT 0,
  sent_at                 TIMESTAMPTZ,
  sent_to                 VARCHAR(255),
  pdf_data                BYTEA,
  accepted_at             TIMESTAMPTZ,
  accepted_by_name        VARCHAR(255),
  accepted_via            "QuoteAcceptedVia",
  accepted_ip             VARCHAR(45),
  terms_accepted          BOOLEAN NOT NULL DEFAULT false,
  rejected_at             TIMESTAMPTZ,
  reject_reason           TEXT,
  expired_at              TIMESTAMPTZ,
  follow_up_reminded_at   TIMESTAMPTZ,
  superseded_at           TIMESTAMPTZ,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT quotes_number_revision UNIQUE (number, revision)
);`);
    // A database made before the enum has accepted_via as VARCHAR(10) + a CHECK (so only the five known values):
    // turn it into the enum once. quotes.status is already the "QuoteStatus" enum. A no-op once it is the enum.
    await client.query(`
      DO $$
      BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'quotes' AND column_name = 'accepted_via'
                       AND data_type = 'character varying') THEN
              ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_accepted_via_check;
              ALTER TABLE quotes ALTER COLUMN accepted_via TYPE "QuoteAcceptedVia" USING accepted_via::"QuoteAcceptedVia";
          END IF;
      END $$;
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_quotes_current ON quotes (number) WHERE is_current;`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_quotes_relation   ON quotes (relation_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_quotes_inquiry    ON quotes (inquiry_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_quotes_status     ON quotes (status);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_quotes_created_at ON quotes (created_at DESC);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_quotes_open_valid ON quotes (valid_until) WHERE status = 'SENT' AND is_current;`,
    );

    await client.query(`CREATE TABLE IF NOT EXISTS quote_sections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id                UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  title                   VARCHAR(255),
  sort_order              INTEGER NOT NULL DEFAULT 0
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_quote_sections_quote ON quote_sections (quote_id);`,
    );

    // A line keeps its own copy of price, unit and VAT rate: changing the catalogue or
    // the VAT settings later never changes a quotation that was already made.
    await client.query(`CREATE TABLE IF NOT EXISTS quote_lines (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id                UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  section_id              UUID NOT NULL REFERENCES quote_sections(id) ON DELETE CASCADE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  catalogue_item_id              UUID REFERENCES catalogue_items(id) ON DELETE SET NULL,
  description             TEXT NOT NULL,
  quantity                NUMERIC(12,3) NOT NULL,
  unit                    VARCHAR(10) NOT NULL CHECK (unit IN ('m', 'm2', 'm3', 'piece', 'hour', 'lump_sum')),
  unit_price              NUMERIC(12,2) NOT NULL,
  cost_price              NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_code                VARCHAR(20) NOT NULL,
  vat_rate                NUMERIC(5,2) NOT NULL,
  vat_reverse_charge      BOOLEAN NOT NULL DEFAULT false,
  line_total              NUMERIC(14,2) NOT NULL,
  line_cost               NUMERIC(14,2) NOT NULL
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quote_lines (quote_id);`,
    );

    // Photos and files shown with the quotation (FR-QUO-07). Revisions share the stored file.
    await client.query(`CREATE TABLE IF NOT EXISTS quote_attachments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id                UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  file_url                TEXT NOT NULL,
  storage_key             TEXT NOT NULL,
  file_name               VARCHAR(255) NOT NULL,
  mime_type               VARCHAR(100) NOT NULL,
  size_bytes              INTEGER NOT NULL,
  uploaded_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_quote_attachments_quote ON quote_attachments (quote_id);`,
    );

    // -- Planning / appointments (SRS 4.9). One row per appointment; multi-day work is a
    // -- single row spanning several days (FR-PLAN-04). Times are absolute (TIMESTAMPTZ);
    // -- an all-day appointment runs from Amsterdam midnight to the next Amsterdam midnight.
    // -- Project work will also link to a project once the Projects module exists.
    await client.query(`CREATE TABLE IF NOT EXISTS appointments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                    "AppointmentType" NOT NULL,
  status                  "AppointmentStatus" NOT NULL DEFAULT 'PLANNED',
  title                   VARCHAR(255) NOT NULL,
  starts_at               TIMESTAMPTZ NOT NULL,
  ends_at                 TIMESTAMPTZ NOT NULL,
  all_day                 BOOLEAN NOT NULL DEFAULT false,
  relation_id             UUID REFERENCES relations(id) ON DELETE RESTRICT,
  inquiry_id              UUID REFERENCES inquiries(id) ON DELETE SET NULL,
  street                  VARCHAR(255),
  house_number            VARCHAR(20),
  postcode                VARCHAR(12),
  city                    VARCHAR(100),
  country                 VARCHAR(2) NOT NULL DEFAULT 'NL',
  notes                   TEXT,
  confirmation_sent_at    TIMESTAMPTZ,
  confirmed_starts_at     TIMESTAMPTZ,
  confirmed_ends_at       TIMESTAMPTZ,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT appointments_time_check CHECK (ends_at > starts_at),
  CONSTRAINT appointments_customer_check CHECK (type = 'INTERNAL' OR relation_id IS NOT NULL)
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_appointments_starts_at ON appointments (starts_at);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_appointments_ends_at   ON appointments (ends_at);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_appointments_relation  ON appointments (relation_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_appointments_inquiry   ON appointments (inquiry_id);`,
    );

    // One or more employees per appointment (FR-PLAN-03)
    await client.query(`CREATE TABLE IF NOT EXISTS appointment_assignees (
  appointment_id          UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (appointment_id, user_id)
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_appointment_assignees_user ON appointment_assignees (user_id);`,
    );

    // The secret in each user's iCal subscription link (FR-PLAN-08). Only its SHA-256 hash is stored.
    await client.query(`CREATE TABLE IF NOT EXISTS calendar_tokens (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash              TEXT NOT NULL UNIQUE,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);

    // -- Project statuses (FR-PRJ-02): configurable. `kind` drives behaviour
    // -- (NEW = where a project starts, CLOSED = finished). System statuses are used by
    // -- the code (and later by invoicing) and cannot be removed or deactivated.
    await client.query(`CREATE TABLE IF NOT EXISTS project_statuses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                     VARCHAR(50) NOT NULL UNIQUE,
  label_nl                VARCHAR(100) NOT NULL,
  label_en                VARCHAR(100) NOT NULL,
  kind                    VARCHAR(6) NOT NULL CHECK (kind IN ('NEW', 'OPEN', 'CLOSED')),
  color                   VARCHAR(7) NOT NULL DEFAULT '#6b7280',
  sort_order              INTEGER NOT NULL DEFAULT 0,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  is_system               BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(`
      INSERT INTO project_statuses (key, label_nl, label_en, kind, color, sort_order, is_system) VALUES
        ('gepland',        'Gepland',        'Planned',     'NEW',    '#2563eb', 10, true),
        ('in_uitvoering',  'In uitvoering',  'In progress', 'OPEN',   '#d97706', 20, true),
        ('opgeleverd',     'Opgeleverd',     'Delivered',   'OPEN',   '#7c3aed', 30, true),
        ('gefactureerd',   'Gefactureerd',   'Invoiced',    'OPEN',   '#0891b2', 40, true),
        ('afgesloten',     'Afgesloten',     'Closed',      'CLOSED', '#16a34a', 50, true)
      ON CONFLICT (key) DO NOTHING;
    `);

    // -- Projects / Projecten (SRS 4.8): an accepted quotation turned into a job to execute.
    // -- Totals are stored (like quotations) and recalculated whenever lines change.
    await client.query(`CREATE TABLE IF NOT EXISTS projects (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  VARCHAR(30) NOT NULL UNIQUE,
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE RESTRICT,
  quote_id                UUID REFERENCES quotes(id) ON DELETE SET NULL,
  inquiry_id              UUID REFERENCES inquiries(id) ON DELETE SET NULL,
  service_type_id         UUID REFERENCES service_types(id) ON DELETE SET NULL,
  status_id               UUID NOT NULL REFERENCES project_statuses(id),
  title                   VARCHAR(255) NOT NULL,
  description             TEXT,
  street                  VARCHAR(255),
  house_number            VARCHAR(20),
  postcode                VARCHAR(12),
  city                    VARCHAR(100),
  country                 VARCHAR(2) NOT NULL DEFAULT 'NL',
  planned_start           DATE,
  planned_end             DATE,
  contact_name            VARCHAR(255),
  contact_email           VARCHAR(255),
  contact_phone           VARCHAR(50),
  project_manager_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  internal_notes          TEXT,
  budget_excl_vat         NUMERIC(14,2) NOT NULL DEFAULT 0,
  budget_vat              NUMERIC(14,2) NOT NULL DEFAULT 0,
  budget_incl_vat         NUMERIC(14,2) NOT NULL DEFAULT 0,
  budget_cost             NUMERIC(14,2) NOT NULL DEFAULT 0,
  additional_excl_vat     NUMERIC(14,2) NOT NULL DEFAULT 0,
  additional_vat          NUMERIC(14,2) NOT NULL DEFAULT 0,
  additional_incl_vat     NUMERIC(14,2) NOT NULL DEFAULT 0,
  additional_cost         NUMERIC(14,2) NOT NULL DEFAULT 0,
  closed_at               TIMESTAMPTZ,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT projects_planned_dates_check CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start)
);`);
    // A quotation becomes at most one project
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_quote ON projects (quote_id) WHERE quote_id IS NOT NULL;`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_projects_relation   ON projects (relation_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_projects_status     ON projects (status_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects (created_at DESC);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_projects_manager    ON projects (project_manager_id);`,
    );

    // Budget lines (copied from the accepted quotation) and additional work (meerwerk,
    // FR-PRJ-05). A line keeps its own copy of price and VAT, like a quotation line.
    await client.query(`CREATE TABLE IF NOT EXISTS project_lines (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                    VARCHAR(10) NOT NULL CHECK (kind IN ('BUDGET', 'ADDITIONAL')),
  section_title           VARCHAR(255),
  sort_order              INTEGER NOT NULL DEFAULT 0,
  catalogue_item_id              UUID REFERENCES catalogue_items(id) ON DELETE SET NULL,
  description             TEXT NOT NULL,
  quantity                NUMERIC(12,3) NOT NULL,
  unit                    VARCHAR(10) NOT NULL CHECK (unit IN ('m', 'm2', 'm3', 'piece', 'hour', 'lump_sum')),
  unit_price              NUMERIC(12,2) NOT NULL,
  cost_price              NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_code                VARCHAR(20) NOT NULL,
  vat_rate                NUMERIC(5,2) NOT NULL,
  vat_reverse_charge      BOOLEAN NOT NULL DEFAULT false,
  line_total              NUMERIC(14,2) NOT NULL,
  line_cost               NUMERIC(14,2) NOT NULL,
  added_by                UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_project_lines_project ON project_lines (project_id, kind, sort_order);`,
    );

    // Documents and photos in folders (FR-PRJ-06), each shareable with the customer
    // and / or a subcontractor (their portals show only what is shared)
    await client.query(`CREATE TABLE IF NOT EXISTS project_files (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder                      "ProjectFileFolder" NOT NULL DEFAULT 'GENERAL',
  file_url                    TEXT NOT NULL,
  storage_key                 TEXT NOT NULL,
  file_name                   VARCHAR(255) NOT NULL,
  mime_type                   VARCHAR(100) NOT NULL,
  size_bytes                  INTEGER NOT NULL,
  caption                     VARCHAR(255),
  share_with_customer         BOOLEAN NOT NULL DEFAULT false,
  share_with_subcontractor    BOOLEAN NOT NULL DEFAULT false,
  uploaded_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    // A database made before the enum has folder as VARCHAR(10) + a CHECK: turn it into the enum once (rows keep
    // their value, the index on (project_id, folder, created_at) is rebuilt by Postgres). A no-op once it is the enum.
    await client.query(`
      DO $$
      BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'project_files' AND column_name = 'folder'
                       AND data_type = 'character varying') THEN
              ALTER TABLE project_files DROP CONSTRAINT IF EXISTS project_files_folder_check;
              ALTER TABLE project_files ALTER COLUMN folder DROP DEFAULT;
              ALTER TABLE project_files ALTER COLUMN folder TYPE "ProjectFileFolder" USING folder::"ProjectFileFolder";
              ALTER TABLE project_files ALTER COLUMN folder SET DEFAULT 'GENERAL';
          END IF;
      END $$;
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files (project_id, folder, created_at);`,
    );

    // Project work appointments belong to a project (planning module)
    await client.query(
      `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_appointments_project ON appointments (project_id);`,
    );

    // -- Work orders / Werkbonnen (SRS 4.10): the job sheet the field crew completes on
    // -- their phone. Statuses: OPEN -> IN_PROGRESS -> COMPLETED (Afgerond) -> CHECKED (Gecontroleerd).
    await client.query(`CREATE TABLE IF NOT EXISTS work_orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  VARCHAR(30) NOT NULL UNIQUE,
  project_id              UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  appointment_id          UUID REFERENCES appointments(id) ON DELETE SET NULL,
  title                   VARCHAR(255) NOT NULL,
  instructions            TEXT,
  status                  "WorkOrderStatus" NOT NULL DEFAULT 'OPEN',
  planned_date            DATE,
  street                  VARCHAR(255),
  house_number            VARCHAR(20),
  postcode                VARCHAR(12),
  city                    VARCHAR(100),
  country                 VARCHAR(2) NOT NULL DEFAULT 'NL',
  work_performed          TEXT,
  crew_notes              TEXT,
  internal_notes          TEXT,
  started_at              TIMESTAMPTZ,
  started_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at            TIMESTAMPTZ,
  completed_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  checked_at              TIMESTAMPTZ,
  checked_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  signed_by_name          VARCHAR(255),
  signed_at               TIMESTAMPTZ,
  signature_png           BYTEA,
  pdf_data                BYTEA,
  pdf_generated_at        TIMESTAMPTZ,
  sent_to_customer_at     TIMESTAMPTZ,
  sent_to                 VARCHAR(255),
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    // A database made before the enum has status as VARCHAR(12) + a CHECK: turn it into the enum once (the rows keep
    // their value, the index on status is rebuilt by Postgres). A no-op once the column is the enum.
    await client.query(`
      DO $$
      BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'work_orders' AND column_name = 'status'
                       AND data_type = 'character varying') THEN
              ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
              ALTER TABLE work_orders ALTER COLUMN status DROP DEFAULT;
              ALTER TABLE work_orders ALTER COLUMN status TYPE "WorkOrderStatus" USING status::"WorkOrderStatus";
              ALTER TABLE work_orders ALTER COLUMN status SET DEFAULT 'OPEN';
          END IF;
      END $$;
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_work_orders_project ON work_orders (project_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_work_orders_status  ON work_orders (status);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_work_orders_appointment ON work_orders (appointment_id);`,
    );

    await client.query(`CREATE TABLE IF NOT EXISTS work_order_assignees (
  work_order_id           UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (work_order_id, user_id)
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_work_order_assignees_user ON work_order_assignees (user_id);`,
    );

    await client.query(`CREATE TABLE IF NOT EXISTS work_order_checklist (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id           UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  text                    VARCHAR(500) NOT NULL,
  is_required             BOOLEAN NOT NULL DEFAULT true,
  is_done                 BOOLEAN NOT NULL DEFAULT false,
  done_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  done_at                 TIMESTAMPTZ
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_work_order_checklist_wo ON work_order_checklist (work_order_id, sort_order);`,
    );

    // Materials: what the office expects (quantity_planned) and what the crew used.
    // client_id makes a retried (offline) upload of a crew-added material idempotent.
    await client.query(`CREATE TABLE IF NOT EXISTS work_order_materials (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id           UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  catalogue_item_id              UUID REFERENCES catalogue_items(id) ON DELETE SET NULL,
  description             VARCHAR(500) NOT NULL,
  unit                    VARCHAR(10) NOT NULL CHECK (unit IN ('m', 'm2', 'm3', 'piece', 'hour', 'lump_sum')),
  quantity_planned        NUMERIC(12,3) NOT NULL DEFAULT 0,
  quantity_used           NUMERIC(12,3),
  note                    VARCHAR(500),
  added_by_crew           BOOLEAN NOT NULL DEFAULT false,
  client_id               UUID,
  UNIQUE (work_order_id, client_id)
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_work_order_materials_wo ON work_order_materials (work_order_id, sort_order);`,
    );

    // Lines used to point at an "article": the column is now catalogue_item_id
    await client.query(`
      DO $$
      DECLARE t text;
      BEGIN
        FOREACH t IN ARRAY ARRAY['quote_lines', 'project_lines', 'work_order_materials'] LOOP
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name = 'article_id')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name = 'catalogue_item_id') THEN
            EXECUTE format('ALTER TABLE %I RENAME COLUMN article_id TO catalogue_item_id', t);
          END IF;
        END LOOP;
      END $$;
    `);
    await client.query(
      `UPDATE audit_log SET entity_type = 'catalogue_item' WHERE entity_type = 'article';`,
    );

    // -- Time registration / Uren (SRS 4.11): every hour worked, on a project, on a work order
    // -- or internal. Hours written on a work order (FR-WO-05) are rows here too. The table used
    // -- to be called work_order_hours (work order module only): an old one is renamed, so no
    // -- data is lost, and brought up to date below.
    await client.query(`
      DO $$ BEGIN
        IF to_regclass('public.work_order_hours') IS NOT NULL AND to_regclass('public.time_entries') IS NULL THEN
          ALTER TABLE work_order_hours RENAME TO time_entries;
        END IF;
      END $$;
    `);
    await client.query(`CREATE TABLE IF NOT EXISTS time_entries (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              UUID REFERENCES projects(id) ON DELETE RESTRICT,
  work_order_id           UUID REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  work_date               DATE NOT NULL,
  minutes                 INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  entry_type              "TimeEntryType" NOT NULL DEFAULT 'WORK',
  is_billable             BOOLEAN NOT NULL DEFAULT true,
  note                    VARCHAR(500),
  client_id               UUID,
  started_at              TIMESTAMPTZ,
  ended_at                TIMESTAMPTZ,
  status                  "TimeEntryStatus" NOT NULL DEFAULT 'SUBMITTED',
  reject_reason           VARCHAR(500),
  approved_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at             TIMESTAMPTZ,
  cost_rate_cents         INTEGER,
  sales_rate_cents        INTEGER,
  cost_cents              INTEGER,
  sales_cents             INTEGER,
  invoice_id              UUID,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    // An old work_order_hours table gets the columns it lacks
    for (const column of [
      `project_id UUID REFERENCES projects(id) ON DELETE RESTRICT`,
      `started_at TIMESTAMPTZ`,
      `ended_at TIMESTAMPTZ`,
      `status "TimeEntryStatus" NOT NULL DEFAULT 'SUBMITTED'`,
      `reject_reason VARCHAR(500)`,
      `approved_by UUID REFERENCES users(id) ON DELETE SET NULL`,
      `approved_at TIMESTAMPTZ`,
      `cost_rate_cents INTEGER`,
      `sales_rate_cents INTEGER`,
      `cost_cents INTEGER`,
      `sales_cents INTEGER`,
      `invoice_id UUID`,
      `updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`,
    ]) {
      await client.query(
        `ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS ${column};`,
      );
    }
    await client.query(
      `ALTER TABLE time_entries ALTER COLUMN work_order_id DROP NOT NULL;`,
    );
    await client.query(`
      UPDATE time_entries t SET project_id = w.project_id
      FROM work_orders w WHERE t.work_order_id = w.id AND t.project_id IS NULL;
    `);
    await client.query(
      `ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS work_order_hours_entry_type_check;`,
    );
    await client.query(
      `ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS work_order_hours_work_order_id_client_id_key;`,
    );
    // A database made before the enums has entry_type / status as VARCHAR(10) + a CHECK each: turn them into the
    // enums once (rows keep their value; the indexes are rebuilt by Postgres). The project-required check is
    // dropped first and made again below, so it is written against the enum. A no-op once they are enums.
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'time_entries' AND column_name = 'entry_type'
                     AND data_type = 'character varying') THEN
          ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_project_required;
          ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_entry_type_check;
          ALTER TABLE time_entries ALTER COLUMN entry_type DROP DEFAULT;
          ALTER TABLE time_entries ALTER COLUMN entry_type TYPE "TimeEntryType" USING entry_type::"TimeEntryType";
          ALTER TABLE time_entries ALTER COLUMN entry_type SET DEFAULT 'WORK';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'time_entries' AND column_name = 'status'
                     AND data_type = 'character varying') THEN
          ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_status_check;
          ALTER TABLE time_entries ALTER COLUMN status DROP DEFAULT;
          ALTER TABLE time_entries ALTER COLUMN status TYPE "TimeEntryStatus" USING status::"TimeEntryStatus";
          ALTER TABLE time_entries ALTER COLUMN status SET DEFAULT 'SUBMITTED';
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_project_required') THEN
          ALTER TABLE time_entries ADD CONSTRAINT time_entries_project_required
            CHECK (entry_type = 'INTERNAL' OR project_id IS NOT NULL);
        END IF;
      END $$;
    `);
    // A phone retrying an upload must not double an entry: the key is per employee
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_time_entries_user_client ON time_entries (user_id, client_id) WHERE client_id IS NOT NULL;`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_time_entries_user_date ON time_entries (user_id, work_date);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries (project_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_time_entries_work_order ON time_entries (work_order_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_time_entries_status_date ON time_entries (status, work_date);`,
    );

    // Cost and sales rate per employee per hour, in cents, valid from a date (FR-HRS-04).
    // Approving an entry copies the rate in force on its work date onto the entry.
    await client.query(`CREATE TABLE IF NOT EXISTS employee_rates (
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effective_from          DATE NOT NULL,
  cost_rate_cents         INTEGER NOT NULL CHECK (cost_rate_cents >= 0),
  sales_rate_cents        INTEGER NOT NULL CHECK (sales_rate_cents >= 0),
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, effective_from)
);`);

    // The running start/stop timer: at most one per employee (FR-HRS-01)
    await client.query(`CREATE TABLE IF NOT EXISTS time_timers (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  project_id              UUID REFERENCES projects(id) ON DELETE CASCADE,
  work_order_id           UUID REFERENCES work_orders(id) ON DELETE CASCADE,
  entry_type              VARCHAR(10) NOT NULL DEFAULT 'WORK',
  is_billable             BOOLEAN NOT NULL DEFAULT true,
  note                    VARCHAR(500),
  started_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

    // -- Invoices / Facturen (SRS 4.14): invoices, instalment and final invoices, credit notes.
    // -- A draft has no number: the number is given when it is issued (in the same transaction as
    // -- the PDF), so numbers never have gaps (FR-INV-04). An issued invoice is locked (FR-INV-06).
    await client.query(`CREATE TABLE IF NOT EXISTS invoices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  VARCHAR(30) UNIQUE,
  kind                    "InvoiceKind" NOT NULL,
  source                  "InvoiceSource" NOT NULL,
  status                  "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  payment_status          "InvoicePaymentStatus",
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE RESTRICT,
  project_id              UUID REFERENCES projects(id) ON DELETE RESTRICT,
  quote_id                UUID REFERENCES quotes(id) ON DELETE SET NULL,
  credit_for_id           UUID REFERENCES invoices(id) ON DELETE RESTRICT,
  language                "Language" NOT NULL DEFAULT 'NL',
  title                   VARCHAR(255),
  recipient_name          VARCHAR(255),
  recipient_email         VARCHAR(255),
  customer_name           VARCHAR(255),
  customer_street         VARCHAR(255),
  customer_house_number   VARCHAR(20),
  customer_postcode       VARCHAR(12),
  customer_city           VARCHAR(100),
  customer_country        VARCHAR(2),
  customer_vat_number     VARCHAR(20),
  customer_kvk_number     VARCHAR(8),
  invoice_date            DATE,
  due_date                DATE,
  payment_term_days       INTEGER NOT NULL DEFAULT 30 CHECK (payment_term_days BETWEEN 0 AND 365),
  instalment_number       INTEGER,
  instalment_percentage   NUMERIC(6,3),
  intro_text              TEXT,
  footer_text             TEXT,
  internal_notes          TEXT,
  credit_reason           TEXT,
  total_excl_vat          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_vat               NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_incl_vat          NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_amount             NUMERIC(14,2) NOT NULL DEFAULT 0,
  credited_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_at                 TIMESTAMPTZ,
  issued_at               TIMESTAMPTZ,
  issued_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  sent_at                 TIMESTAMPTZ,
  sent_to                 VARCHAR(255),
  pdf_data                BYTEA,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    // A database made before the enums has kind, source, status and payment_status as VARCHAR + a CHECK each: turn
    // them into the enums once (rows keep their value; the index on (status, payment_status) is rebuilt by Postgres).
    // The four columns are converted in ONE statement, so the table (with the stored PDFs) is rewritten only once.
    // A no-op once they are enums. (The trigger that refuses deleting an issued invoice reads status at run time.)
    await client.query(`
      DO $$
      DECLARE
          clauses text := '';
          col record;
      BEGIN
          FOR col IN
              SELECT * FROM (VALUES
                  ('kind', 'InvoiceKind'), ('source', 'InvoiceSource'),
                  ('status', 'InvoiceStatus'), ('payment_status', 'InvoicePaymentStatus')
              ) AS c(name, enum_type)
              WHERE EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = c.name
                              AND data_type = 'character varying')
          LOOP
              EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS %I', 'invoices_' || col.name || '_check');
              clauses := clauses || CASE WHEN clauses = '' THEN '' ELSE ', ' END
                         || format('ALTER COLUMN %I TYPE %I USING %I::%I', col.name, col.enum_type, col.name, col.enum_type);
          END LOOP;
          IF clauses <> '' THEN
              ALTER TABLE invoices ALTER COLUMN status DROP DEFAULT;
              EXECUTE 'ALTER TABLE invoices ' || clauses;
              ALTER TABLE invoices ALTER COLUMN status SET DEFAULT 'DRAFT';
          END IF;
      END $$;
    `);
    for (const index of [
      `CREATE INDEX IF NOT EXISTS idx_invoices_relation ON invoices (relation_id);`,
      `CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices (project_id);`,
      `CREATE INDEX IF NOT EXISTS idx_invoices_quote ON invoices (quote_id);`,
      `CREATE INDEX IF NOT EXISTS idx_invoices_credit_for ON invoices (credit_for_id);`,
      `CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status, payment_status);`,
      `CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices (due_date);`,
      `CREATE INDEX IF NOT EXISTS idx_invoices_invoice_date ON invoices (invoice_date DESC);`,
    ]) {
      await client.query(index);
    }

    await client.query(`CREATE TABLE IF NOT EXISTS invoice_lines (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id              UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  section_title           VARCHAR(255),
  line_type               "InvoiceLineType" NOT NULL DEFAULT 'MANUAL',
  catalogue_item_id       UUID REFERENCES catalogue_items(id) ON DELETE SET NULL,
  credits_line_id         UUID REFERENCES invoice_lines(id) ON DELETE RESTRICT,
  description             TEXT NOT NULL,
  quantity                NUMERIC(12,3) NOT NULL,
  unit                    VARCHAR(10) NOT NULL CHECK (unit IN ('m', 'm2', 'm3', 'piece', 'hour', 'lump_sum')),
  unit_price              NUMERIC(12,2) NOT NULL,
  vat_code                VARCHAR(20) NOT NULL,
  vat_rate                NUMERIC(5,2) NOT NULL,
  vat_reverse_charge      BOOLEAN NOT NULL DEFAULT false,
  line_total              NUMERIC(14,2) NOT NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await convertColumnsToEnums(client, "invoice_lines", [{ column: "line_type", type: "InvoiceLineType", default: "MANUAL" }]);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (invoice_id, sort_order);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_invoice_lines_credits ON invoice_lines (credits_line_id);`,
    );

    // Money received on an invoice: through Mollie, or recorded by hand (FR-INV-10)
    await client.query(`CREATE TABLE IF NOT EXISTS invoice_payments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id              UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount                  NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method                  "InvoicePaymentMethod" NOT NULL,
  mollie_payment_id       VARCHAR(50) UNIQUE,
  paid_at                 TIMESTAMPTZ NOT NULL,
  reference               VARCHAR(255),
  recorded_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await convertColumnsToEnums(client, "invoice_payments", [{ column: "method", type: "InvoicePaymentMethod" }]);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments (invoice_id);`,
    );

    // Every Mollie payment link made for an invoice (a reminder gets a fresh one)
    await client.query(`CREATE TABLE IF NOT EXISTS invoice_payment_links (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id              UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  mollie_payment_id       VARCHAR(50) NOT NULL UNIQUE,
  checkout_url            TEXT NOT NULL,
  amount                  NUMERIC(14,2) NOT NULL,
  status                  VARCHAR(12) NOT NULL DEFAULT 'open',
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_invoice_payment_links_invoice ON invoice_payment_links (invoice_id, created_at DESC);`,
    );

    // Payment reminders (FR-INV-11). days_after_due is NULL for a reminder sent by hand.
    await client.query(`CREATE TABLE IF NOT EXISTS invoice_reminders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id              UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  days_after_due          INTEGER,
  kind                    "InvoiceReminderKind" NOT NULL DEFAULT 'AUTOMATIC',
  status                  "InvoiceReminderStatus" NOT NULL DEFAULT 'SENT',
  sent_to                 VARCHAR(255),
  payment_link_id         UUID REFERENCES invoice_payment_links(id) ON DELETE SET NULL,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  sent_at                 TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (invoice_id, days_after_due)
);`);
    await convertColumnsToEnums(client, "invoice_reminders", [
      { column: "kind", type: "InvoiceReminderKind", default: "AUTOMATIC" },
      { column: "status", type: "InvoiceReminderStatus", default: "SENT" },
    ]);

    // The Mollie API key, encrypted (NFR-SEC-07). One row.
    await client.query(`CREATE TABLE IF NOT EXISTS mollie_settings (
  id                      BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  api_key_encrypted       TEXT NOT NULL,
  mode                    VARCHAR(4) NOT NULL CHECK (mode IN ('test', 'live')),
  key_hint                VARCHAR(8) NOT NULL,
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);

    // Lines and hours that are on an invoice are marked, so nothing is invoiced twice
    await client.query(
      `ALTER TABLE project_lines ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL;`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_project_lines_invoice ON project_lines (invoice_id);`,
    );
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_invoice_fk') THEN
          ALTER TABLE time_entries ADD CONSTRAINT time_entries_invoice_fk
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_time_entries_invoice ON time_entries (invoice_id);`,
    );

    // -- Subscriptions / Abonnementen (SRS 4.15): recurring maintenance contracts. Billed in
    // -- advance on each billing date; the invoice is made and issued by the billing job.
    await client.query(`CREATE TABLE IF NOT EXISTS subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  VARCHAR(30) NOT NULL UNIQUE,
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE RESTRICT,
  title                   VARCHAR(255) NOT NULL,
  description             TEXT,
  street                  VARCHAR(255),
  house_number            VARCHAR(20),
  postcode                VARCHAR(12),
  city                    VARCHAR(100),
  country                 VARCHAR(2) NOT NULL DEFAULT 'NL',
  amount_excl_vat         NUMERIC(14,2) NOT NULL CHECK (amount_excl_vat > 0),
  vat_code                VARCHAR(20) NOT NULL,
  billing_interval        VARCHAR(10) NOT NULL CHECK (billing_interval IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  start_date              DATE NOT NULL,
  end_date                DATE,
  anchor_day              SMALLINT NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  next_billing_date       DATE,
  status                  VARCHAR(8) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'ENDED')),
  payment_term_days       INTEGER NOT NULL DEFAULT 14 CHECK (payment_term_days BETWEEN 0 AND 120),
  use_direct_debit        BOOLEAN NOT NULL DEFAULT TRUE,
  language                "Language" NOT NULL DEFAULT 'NL',
  visits_per_year         SMALLINT NOT NULL DEFAULT 0 CHECK (visits_per_year IN (0, 1, 2, 3, 4, 6, 12)),
  first_visit_date        DATE,
  visit_assignee_ids      UUID[] NOT NULL DEFAULT '{}',
  internal_notes          TEXT,
  paused_at               TIMESTAMPTZ,
  ended_at                TIMESTAMPTZ,
  end_reason              TEXT,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT subscriptions_visits_check CHECK (visits_per_year = 0 OR first_visit_date IS NOT NULL),
  CONSTRAINT subscriptions_dates_check CHECK (end_date IS NULL OR end_date >= start_date)
);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_relation ON subscriptions (relation_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_billing ON subscriptions (status, next_billing_date);`);

    // One row per billed period: the unique key is what makes the billing job safe to repeat
    await client.query(`CREATE TABLE IF NOT EXISTS subscription_billings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id         UUID NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL,
  status                  VARCHAR(8) NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED', 'ISSUED', 'SKIPPED')),
  invoice_id              UUID REFERENCES invoices(id) ON DELETE SET NULL,
  collection              VARCHAR(14) CHECK (collection IN ('DIRECT_DEBIT', 'PAYMENT_LINK')),
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subscription_id, period_start)
);`);

    // Maintenance visits made as planning appointments (FR-ABO-06), once per date
    await client.query(`CREATE TABLE IF NOT EXISTS subscription_visits (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id         UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  visit_date              DATE NOT NULL,
  appointment_id          UUID REFERENCES appointments(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subscription_id, visit_date)
);`);

    // SEPA direct debit through Mollie (FR-ABO-03): one Mollie customer and one mandate per
    // relation, used for all its contracts. Only ids and a masked account are kept.
    await client.query(`CREATE TABLE IF NOT EXISTS relation_direct_debit (
  relation_id             UUID PRIMARY KEY REFERENCES relations(id) ON DELETE CASCADE,
  mollie_customer_id      VARCHAR(50) NOT NULL,
  mandate_id              VARCHAR(50),
  mandate_status          VARCHAR(12),
  mandate_method          VARCHAR(30),
  consumer_name           VARCHAR(255),
  consumer_account_hint   VARCHAR(40),
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(`CREATE TABLE IF NOT EXISTS direct_debit_setups (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  mollie_payment_id       VARCHAR(50) NOT NULL UNIQUE,
  checkout_url            TEXT NOT NULL,
  status                  VARCHAR(12) NOT NULL DEFAULT 'open',
  requested_via           "DirectDebitRequestedVia" NOT NULL DEFAULT 'OFFICE',
  requested_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await convertColumnsToEnums(client, "direct_debit_setups", [{ column: "requested_via", type: "DirectDebitRequestedVia", default: "OFFICE" }]);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_direct_debit_setups_relation ON direct_debit_setups (relation_id, created_at DESC);`);

    // Invoices that come from a contract, collections by direct debit, and reversals
    await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id) ON DELETE RESTRICT;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_invoices_subscription ON invoices (subscription_id);`);
    await client.query(`ALTER TABLE invoice_payment_links ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'LINK';`);
    await client.query(`ALTER TABLE invoice_payment_links ADD COLUMN IF NOT EXISTS failure_reason TEXT;`);
    await client.query(`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;`);
    await client.query(`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS reversal_reason TEXT;`);

    // Issued invoices are never deleted (NFR-REL-03): the database refuses it too
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_issued_invoice_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'ISSUED' THEN
          RAISE EXCEPTION 'An issued invoice cannot be deleted';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(
      `DROP TRIGGER IF EXISTS trg_prevent_issued_invoice_delete ON invoices;`,
    );
    await client.query(`
      CREATE TRIGGER trg_prevent_issued_invoice_delete
      BEFORE DELETE ON invoices
      FOR EACH ROW EXECUTE FUNCTION prevent_issued_invoice_delete();
    `);

    // -- Purchasing / Inkoop (SRS 4.12): purchase orders to suppliers and the suppliers' invoices.
    // -- A draft purchase order has no number; it gets one when it is ordered.
    await client.query(`CREATE TABLE IF NOT EXISTS purchase_orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  VARCHAR(30) UNIQUE,
  status                  "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
  supplier_id             UUID NOT NULL REFERENCES relations(id) ON DELETE RESTRICT,
  project_id              UUID REFERENCES projects(id) ON DELETE RESTRICT,
  title                   VARCHAR(255),
  supplier_reference      VARCHAR(100),
  language                "Language" NOT NULL DEFAULT 'NL',
  order_date              DATE,
  expected_delivery_date  DATE,
  delivery_street         VARCHAR(255),
  delivery_house_number   VARCHAR(20),
  delivery_postcode       VARCHAR(12),
  delivery_city           VARCHAR(100),
  delivery_country        VARCHAR(2),
  recipient_name          VARCHAR(255),
  recipient_email         VARCHAR(255),
  notes                   TEXT,
  internal_notes          TEXT,
  total_excl_vat          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_vat               NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_incl_vat          NUMERIC(14,2) NOT NULL DEFAULT 0,
  ordered_at              TIMESTAMPTZ,
  ordered_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  sent_at                 TIMESTAMPTZ,
  sent_to                 VARCHAR(255),
  received_at             TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  cancel_reason           TEXT,
  pdf_data                BYTEA,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    // A database made before the enum has status as VARCHAR(20) + a CHECK: turn it into the enum once (rows keep
    // their value, the index on status is rebuilt by Postgres). A no-op once the column is the enum.
    await client.query(`
      DO $$
      BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'status'
                       AND data_type = 'character varying') THEN
              ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
              ALTER TABLE purchase_orders ALTER COLUMN status DROP DEFAULT;
              ALTER TABLE purchase_orders ALTER COLUMN status TYPE "PurchaseOrderStatus" USING status::"PurchaseOrderStatus";
              ALTER TABLE purchase_orders ALTER COLUMN status SET DEFAULT 'DRAFT';
          END IF;
      END $$;
    `);
    for (const index of [
      `CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders (supplier_id);`,
      `CREATE INDEX IF NOT EXISTS idx_purchase_orders_project ON purchase_orders (project_id);`,
      `CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders (status);`,
    ]) {
      await client.query(index);
    }

    await client.query(`CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id       UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  catalogue_item_id       UUID REFERENCES catalogue_items(id) ON DELETE SET NULL,
  description             TEXT NOT NULL,
  quantity                NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit                    VARCHAR(10) NOT NULL CHECK (unit IN ('m', 'm2', 'm3', 'piece', 'hour', 'lump_sum')),
  unit_price              NUMERIC(12,2) NOT NULL,
  vat_code                VARCHAR(20) NOT NULL,
  vat_rate                NUMERIC(5,2) NOT NULL,
  vat_reverse_charge      BOOLEAN NOT NULL DEFAULT false,
  line_total              NUMERIC(14,2) NOT NULL,
  quantity_received       NUMERIC(12,3) NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON purchase_order_lines (purchase_order_id, sort_order);`,
    );

    // The suppliers' invoices (Ontvangen -> Goedgekeurd -> Betaald). The document is kept in the
    // database so it can be exported later and is retained with the record (NFR-REL-03).
    await client.query(`CREATE TABLE IF NOT EXISTS supplier_invoices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id             UUID NOT NULL REFERENCES relations(id) ON DELETE RESTRICT,
  purchase_order_id       UUID REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  project_id              UUID REFERENCES projects(id) ON DELETE RESTRICT,
  invoice_number          VARCHAR(60) NOT NULL,
  invoice_date            DATE NOT NULL,
  due_date                DATE,
  amount_excl_vat         NUMERIC(14,2) NOT NULL,
  vat_amount              NUMERIC(14,2) NOT NULL,
  amount_incl_vat         NUMERIC(14,2) NOT NULL,
  vat_code                VARCHAR(20),
  status                  "SupplierInvoiceStatus" NOT NULL DEFAULT 'RECEIVED',
  description             TEXT,
  internal_notes          TEXT,
  file_data               BYTEA,
  file_name               VARCHAR(255),
  file_mime               VARCHAR(100),
  file_size               INTEGER,
  received_at             TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  recorded_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at             TIMESTAMPTZ,
  paid_at                 DATE,
  payment_reference       VARCHAR(255),
  voided_at               TIMESTAMPTZ,
  void_reason             TEXT,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_invoices_amounts_check CHECK (amount_incl_vat = amount_excl_vat + vat_amount)
);`);
    // A database made before the enum has status as VARCHAR(10) + a CHECK: turn it into the enum once (rows keep
    // their value). The unique number index has `WHERE status <> 'VOID'`, so it is dropped first and made again
    // just below. A no-op once the column is the enum.
    await client.query(`
      DO $$
      BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'supplier_invoices' AND column_name = 'status'
                       AND data_type = 'character varying') THEN
              DROP INDEX IF EXISTS uq_supplier_invoices_number;
              ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_status_check;
              ALTER TABLE supplier_invoices ALTER COLUMN status DROP DEFAULT;
              ALTER TABLE supplier_invoices ALTER COLUMN status TYPE "SupplierInvoiceStatus" USING status::"SupplierInvoiceStatus";
              ALTER TABLE supplier_invoices ALTER COLUMN status SET DEFAULT 'RECEIVED';
          END IF;
      END $$;
    `);
    // The same supplier cannot send the same number twice (a voided entry frees its number)
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoices_number ON supplier_invoices (supplier_id, LOWER(invoice_number)) WHERE status <> 'VOID';`,
    );
    for (const index of [
      `CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices (supplier_id);`,
      `CREATE INDEX IF NOT EXISTS idx_supplier_invoices_project ON supplier_invoices (project_id);`,
      `CREATE INDEX IF NOT EXISTS idx_supplier_invoices_po ON supplier_invoices (purchase_order_id);`,
      `CREATE INDEX IF NOT EXISTS idx_supplier_invoices_status ON supplier_invoices (status, due_date);`,
      `CREATE INDEX IF NOT EXISTS idx_supplier_invoices_date ON supplier_invoices (invoice_date DESC);`,
    ]) {
      await client.query(index);
    }

    // -- Subcontracting / Uitbesteden (SRS 4.13): a part of a project given to a subcontractor.
    // -- A draft (Concept) has no number; it gets one when it is sent (Verstuurd).
    await client.query(`CREATE TABLE IF NOT EXISTS subcontract_assignments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  VARCHAR(30) UNIQUE,
  status                  "SubcontractAssignmentStatus" NOT NULL DEFAULT 'DRAFT',
  project_id              UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  subcontractor_id        UUID NOT NULL REFERENCES relations(id) ON DELETE RESTRICT,
  title                   VARCHAR(255) NOT NULL,
  scope_description       TEXT NOT NULL,
  agreed_price_excl_vat   NUMERIC(14,2) NOT NULL CHECK (agreed_price_excl_vat > 0),
  vat_code                VARCHAR(20) NOT NULL,
  vat_rate                NUMERIC(5,2) NOT NULL,
  vat_reverse_charge      BOOLEAN NOT NULL DEFAULT false,
  planned_start           DATE,
  planned_end             DATE,
  work_street             VARCHAR(255),
  work_house_number       VARCHAR(20),
  work_postcode           VARCHAR(12),
  work_city               VARCHAR(100),
  work_country            VARCHAR(2),
  language                "Language" NOT NULL DEFAULT 'NL',
  recipient_name          VARCHAR(255),
  recipient_email         VARCHAR(255),
  internal_notes          TEXT,
  sent_at                 TIMESTAMPTZ,
  sent_to                 VARCHAR(255),
  pdf_data                BYTEA,
  responded_at            TIMESTAMPTZ,
  response_via            "SubcontractResponseVia",
  response_comment        TEXT,
  proposed_start          DATE,
  proposed_end            DATE,
  response_recorded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  progress_percent        INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  completed_at            TIMESTAMPTZ,
  completed_note          TEXT,
  cancelled_at            TIMESTAMPTZ,
  cancel_reason           TEXT,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT subcontract_planned_dates_check CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start)
);`);
    // A database made before the enums has status as VARCHAR(10) + a CHECK and response_via as a plain VARCHAR(10):
    // turn both into the enums once (rows keep their value; a response_via that is not one of the known channels,
    // which the API never wrote, becomes OTHER instead of stopping the start-up). A no-op once they are enums.
    await client.query(`
      DO $$
      BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'subcontract_assignments' AND column_name = 'status'
                       AND data_type = 'character varying') THEN
              ALTER TABLE subcontract_assignments DROP CONSTRAINT IF EXISTS subcontract_assignments_status_check;
              ALTER TABLE subcontract_assignments ALTER COLUMN status DROP DEFAULT;
              ALTER TABLE subcontract_assignments ALTER COLUMN status TYPE "SubcontractAssignmentStatus" USING status::"SubcontractAssignmentStatus";
              ALTER TABLE subcontract_assignments ALTER COLUMN status SET DEFAULT 'DRAFT';
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'subcontract_assignments' AND column_name = 'response_via'
                       AND data_type = 'character varying') THEN
              ALTER TABLE subcontract_assignments ALTER COLUMN response_via TYPE "SubcontractResponseVia" USING (
                CASE
                  WHEN response_via IS NULL OR btrim(response_via) = '' THEN NULL
                  WHEN upper(btrim(response_via)) IN ('PHONE', 'EMAIL', 'IN_PERSON', 'OTHER', 'PORTAL') THEN upper(btrim(response_via))::"SubcontractResponseVia"
                  ELSE 'OTHER'::"SubcontractResponseVia"
                END);
          END IF;
      END $$;
    `);
    for (const index of [
      `CREATE INDEX IF NOT EXISTS idx_subcontract_project ON subcontract_assignments (project_id);`,
      `CREATE INDEX IF NOT EXISTS idx_subcontract_subcontractor ON subcontract_assignments (subcontractor_id);`,
      `CREATE INDEX IF NOT EXISTS idx_subcontract_status ON subcontract_assignments (status);`,
    ]) {
      await client.query(index);
    }

    // Progress reports on an assignment (FR-SUBP-05): recorded by the office for now, by the
    // subcontractor in their portal later
    await client.query(`CREATE TABLE IF NOT EXISTS subcontract_progress (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id           UUID NOT NULL REFERENCES subcontract_assignments(id) ON DELETE CASCADE,
  percent                 INTEGER NOT NULL CHECK (percent BETWEEN 0 AND 100),
  note                    TEXT,
  reported_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_subcontract_progress_assignment ON subcontract_progress (assignment_id, created_at);`,
    );

    // A subcontractor's invoice is a supplier invoice that belongs to an assignment (FR-SUB-04):
    // the same recording, approval and payment steps
    await client.query(
      `ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS subcontract_assignment_id UUID REFERENCES subcontract_assignments(id) ON DELETE RESTRICT;`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_supplier_invoices_assignment ON supplier_invoices (subcontract_assignment_id);`,
    );

    // Crew photos and the completed work order PDF live in the project's files
    await client.query(
      `ALTER TABLE project_files ADD COLUMN IF NOT EXISTS work_order_id UUID REFERENCES work_orders(id) ON DELETE SET NULL;`,
    );
    await client.query(
      `ALTER TABLE project_files ADD COLUMN IF NOT EXISTS subcontract_assignment_id UUID REFERENCES subcontract_assignments(id) ON DELETE SET NULL;`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_project_files_assignment ON project_files (subcontract_assignment_id);`,
    );

    // -- Acties / tasks (SRS 4.16, FR-MSG-03/04): created by people or automatically for key events.
    // -- An automatic task has an auto_key, unique while the task exists, so an event never makes two.
    await client.query(`CREATE TABLE IF NOT EXISTS actions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                   VARCHAR(255) NOT NULL,
  description             TEXT,
  status                  "ActionStatus" NOT NULL DEFAULT 'OPEN',
  due_date                DATE,
  assignee_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  source                  "ActionSource" NOT NULL DEFAULT 'MANUAL',
  auto_type               VARCHAR(40),
  auto_key                VARCHAR(120),
  entity_type             VARCHAR(30),
  entity_id               UUID,
  completed_at            TIMESTAMPTZ,
  completed_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  completion_note         TEXT,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT actions_entity_pair_check CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
  CONSTRAINT actions_auto_check CHECK ((source = 'AUTOMATIC') = (auto_type IS NOT NULL))
);`);
    // A database made before the enums has status and source as VARCHAR(10) + a CHECK each: turn both into the enums
    // once. The check that reads `source` is dropped first and made again against the enum.
    await convertColumnsToEnums(
      client,
      "actions",
      [
        { column: "status", type: "ActionStatus", default: "OPEN" },
        { column: "source", type: "ActionSource", default: "MANUAL" },
      ],
      {
        dropConstraints: ["actions_auto_check"],
        afterSql: [`ALTER TABLE actions ADD CONSTRAINT actions_auto_check CHECK ((source = 'AUTOMATIC') = (auto_type IS NOT NULL))`],
      },
    );
    for (const index of [
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_actions_auto_key ON actions (auto_key) WHERE auto_key IS NOT NULL;`,
      `CREATE INDEX IF NOT EXISTS idx_actions_assignee_status ON actions (assignee_id, status, due_date);`,
      `CREATE INDEX IF NOT EXISTS idx_actions_status_due ON actions (status, due_date);`,
      `CREATE INDEX IF NOT EXISTS idx_actions_entity ON actions (entity_type, entity_id);`,
    ]) {
      await client.query(index);
    }

    // -- Customer portal (SRS 4.18): a portal user is a user (role CUSTOMER) that belongs to one relation.
    // -- Several users may belong to the same relation (FR-PORT-02). The same link serves the
    // -- subcontractor portal later (role SUBCONTRACTOR).
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS relation_id        UUID REFERENCES relations(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS last_login_at      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS portal_invited_at  TIMESTAMPTZ;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_relation ON users (relation_id);`);
    // A portal user without a relation would see nothing, or worse: enforced in the database too.
    // NOT VALID: applies to new and changed rows, so an older database with odd rows still migrates.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_portal_relation_check') THEN
          ALTER TABLE users ADD CONSTRAINT users_portal_relation_check
            CHECK (role::text NOT IN ('CUSTOMER', 'SUBCONTRACTOR') OR relation_id IS NOT NULL) NOT VALID;
        END IF;
      END $$;
    `);

    // Messages between a customer and the office, per project (FR-PORT-08)
    await client.query(`CREATE TABLE IF NOT EXISTS portal_messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  sender_type             VARCHAR(8) NOT NULL CHECK (sender_type IN ('CUSTOMER', 'OFFICE')),
  author_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  body                    TEXT NOT NULL,
  read_by_customer_at     TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_portal_messages_project ON portal_messages (project_id, created_at);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_portal_messages_relation ON portal_messages (relation_id, created_at DESC);`,
    );

    // Messages between a subcontractor and the office, per assignment (FR-SUBP-07)
    await client.query(`CREATE TABLE IF NOT EXISTS assignment_messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id           UUID NOT NULL REFERENCES subcontract_assignments(id) ON DELETE CASCADE,
  relation_id             UUID NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  sender_type             VARCHAR(13) NOT NULL CHECK (sender_type IN ('SUBCONTRACTOR', 'OFFICE')),
  author_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  body                    TEXT NOT NULL,
  read_by_subcontractor_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_assignment_messages_assignment ON assignment_messages (assignment_id, created_at);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_assignment_messages_relation ON assignment_messages (relation_id, created_at DESC);`,
    );

    // -- SnelStart accounting integration (SRS 4.21): one settings row (keys encrypted), the mapping of CRM VAT
    // -- codes and revenue / cost categories to SnelStart ledger accounts, the queue of records to send, and a log
    // -- of every action. Bookings go from the CRM to SnelStart; the CRM never edits or deletes one afterwards.
    await client.query(`CREATE TABLE IF NOT EXISTS snelstart_settings (
  id                        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  connection_key_encrypted  TEXT,
  subscription_key_encrypted TEXT,
  key_hint                  VARCHAR(8),
  connection_status         VARCHAR(12) NOT NULL DEFAULT 'DISCONNECTED' CHECK (connection_status IN ('DISCONNECTED', 'CONNECTED', 'ERROR')),
  last_error                TEXT,
  last_checked_at           TIMESTAMPTZ,
  connected_at              TIMESTAMPTZ,
  is_enabled                BOOLEAN NOT NULL DEFAULT FALSE,
  sync_interval_minutes     INTEGER NOT NULL DEFAULT 15 CHECK (sync_interval_minutes BETWEEN 1 AND 1440),
  vat_mapping               JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at              TIMESTAMPTZ,
  sync_lock_until           TIMESTAMPTZ,
  retry_after               TIMESTAMPTZ,
  updated_by                UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at                TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(`INSERT INTO snelstart_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;`);
    await client.query(`CREATE TABLE IF NOT EXISTS snelstart_ledger_map (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    VARCHAR(7) NOT NULL CHECK (kind IN ('REVENUE', 'COST')),
  vat_code                VARCHAR(20) NOT NULL,
  service_type_key        VARCHAR(50),
  grootboek_id            VARCHAR(64) NOT NULL,
  grootboek_number        INTEGER,
  grootboek_name          VARCHAR(255),
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT snelstart_ledger_map_service_check CHECK (service_type_key IS NULL OR kind = 'REVENUE')
);`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_snelstart_ledger_map ON snelstart_ledger_map (kind, vat_code, COALESCE(service_type_key, ''));`,
    );
    await client.query(`CREATE TABLE IF NOT EXISTS snelstart_sync_items (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type             VARCHAR(16) NOT NULL CHECK (entity_type IN ('SALES_INVOICE', 'PURCHASE_INVOICE')),
  entity_id               UUID NOT NULL,
  status                  VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED')),
  step                    VARCHAR(10) NOT NULL DEFAULT 'BOOKING' CHECK (step IN ('BOOKING', 'DOCUMENT', 'DONE')),
  attempts                INTEGER NOT NULL DEFAULT 0,
  next_attempt_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  snelstart_id            VARCHAR(64),
  relation_snelstart_id   VARCHAR(64),
  last_error              TEXT,
  last_error_code         VARCHAR(20),
  open_balance            NUMERIC(14,2),
  balance_checked_at      TIMESTAMPTZ,
  queued_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  sent_at                 TIMESTAMPTZ,
  UNIQUE (entity_type, entity_id)
);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_snelstart_items_due ON snelstart_sync_items (status, next_attempt_at);`);
    await client.query(`CREATE TABLE IF NOT EXISTS snelstart_sync_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id                 UUID REFERENCES snelstart_sync_items(id) ON DELETE SET NULL,
  entity_type             VARCHAR(16),
  entity_id               UUID,
  action                  VARCHAR(24) NOT NULL,
  status                  VARCHAR(6) NOT NULL CHECK (status IN ('OK', 'FAILED', 'INFO')),
  message                 TEXT,
  details                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_snelstart_log_created ON snelstart_sync_log (created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_snelstart_log_entity ON snelstart_sync_log (entity_type, entity_id, created_at DESC);`);

    // -- Project chat: one set of channels per project. CUSTOMER (the customer + office), INTERNAL
    // -- (office + field crew) and one SUBCONTRACTOR channel per subcontractor company. It replaces
    // -- portal_messages and assignment_messages, whose rows are copied below (the old tables stay).
    await client.query(`CREATE TABLE IF NOT EXISTS chat_channels (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                    "ChatChannelKind" NOT NULL,
  relation_id             UUID REFERENCES relations(id) ON DELETE CASCADE,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chat_channels_relation_check CHECK ((kind = 'SUBCONTRACTOR') = (relation_id IS NOT NULL))
);`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channels ON chat_channels (project_id, kind, COALESCE(relation_id, '00000000-0000-0000-0000-000000000000'::uuid));`,
    );
    // Field crew added by hand (planned crew need no row: they are found through the planning)
    await client.query(`CREATE TABLE IF NOT EXISTS chat_members (
  channel_id              UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by                UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id)
);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);`);
    await client.query(`CREATE TABLE IF NOT EXISTS chat_messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id              UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  author_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  body                    TEXT NOT NULL DEFAULT '',
  client_id               VARCHAR(64),
  legacy_ref              VARCHAR(60) UNIQUE,
  edited_at               TIMESTAMPTZ,
  deleted_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages (channel_id, created_at DESC, id DESC);`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_client ON chat_messages (author_id, client_id) WHERE client_id IS NOT NULL;`);
    // Where each person has read up to, and when they were last emailed about this channel
    await client.query(`CREATE TABLE IF NOT EXISTS chat_reads (
  channel_id              UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at            TIMESTAMPTZ,
  last_emailed_at         TIMESTAMPTZ,
  PRIMARY KEY (channel_id, user_id)
);`);
    // Files sent in the chat are project files that belong to a message. They are never "shared":
    // only the people in that channel can see them, through the chat.
    await client.query(`ALTER TABLE project_files ADD COLUMN IF NOT EXISTS chat_message_id UUID REFERENCES chat_messages(id) ON DELETE CASCADE;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_files_chat ON project_files (chat_message_id) WHERE chat_message_id IS NOT NULL;`);

    // -- Staff chat: DIRECT (two employees) and GROUP (named, several employees) conversations. They belong to no
    // -- project, and only the people in `chat_members` can see them (not even the Beheerder).
    await client.query(`ALTER TABLE chat_channels ALTER COLUMN project_id DROP NOT NULL;`);
    // A database made before the enum has kind as VARCHAR(13) + a CHECK (with 3 or 5 kinds): turn it into the enum
    // once. The two checks that read `kind` are dropped first and made again against the enum (the project check
    // is made just below). A no-op once the column is the enum.
    await convertColumnsToEnums(client, "chat_channels", [{ column: "kind", type: "ChatChannelKind" }], {
      dropConstraints: ["chat_channels_relation_check", "chat_channels_project_check"],
      afterSql: [
        `ALTER TABLE chat_channels ADD CONSTRAINT chat_channels_relation_check CHECK ((kind = 'SUBCONTRACTOR') = (relation_id IS NOT NULL))`,
      ],
    });
    await client.query(`ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS title VARCHAR(120);`);
    await client.query(`ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;`);
    await client.query(`ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS direct_key VARCHAR(80);`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_channels_project_check') THEN
          ALTER TABLE chat_channels ADD CONSTRAINT chat_channels_project_check
            CHECK ((kind IN ('DIRECT', 'GROUP')) = (project_id IS NULL));
        END IF;
      END $$;
    `);
    // One DIRECT chat per pair of people (the two ids sorted and joined)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_direct_key ON chat_channels (direct_key) WHERE direct_key IS NOT NULL;`);
    await client.query(`ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT false;`);

    // Every project gets its customer and internal channels
    await client.query(`
      INSERT INTO chat_channels (project_id, kind)
      SELECT p.id, k.kind FROM projects p CROSS JOIN (VALUES ('CUSTOMER'::"ChatChannelKind"), ('INTERNAL'::"ChatChannelKind")) AS k(kind)
      ON CONFLICT DO NOTHING;
    `);
    // Copy the old customer <-> office messages and subcontractor <-> office messages once. They count as
    // read for the people they were for, so nobody gets a wall of unread dots.
    await client.query(`
      WITH moved AS (
        INSERT INTO chat_messages (channel_id, author_id, body, created_at, legacy_ref)
        SELECT c.id, pm.author_id, pm.body, pm.created_at, 'portal:' || pm.id
        FROM portal_messages pm JOIN chat_channels c ON c.project_id = pm.project_id AND c.kind = 'CUSTOMER'
        ON CONFLICT (legacy_ref) DO NOTHING
        RETURNING channel_id
      )
      INSERT INTO chat_reads (channel_id, user_id, last_read_at)
      SELECT DISTINCT c.id, u.id, CURRENT_TIMESTAMP
      FROM moved mv
      JOIN chat_channels c ON c.id = mv.channel_id
      JOIN projects p ON p.id = c.project_id
      JOIN users u ON u.relation_id = p.relation_id AND u.role::text = 'CUSTOMER'
      ON CONFLICT DO NOTHING;
    `);
    await client.query(`
      INSERT INTO chat_channels (project_id, kind, relation_id)
      SELECT DISTINCT sa.project_id, 'SUBCONTRACTOR'::"ChatChannelKind", am.relation_id
      FROM assignment_messages am JOIN subcontract_assignments sa ON sa.id = am.assignment_id
      ON CONFLICT DO NOTHING;
    `);
    await client.query(`
      WITH moved AS (
        INSERT INTO chat_messages (channel_id, author_id, body, created_at, legacy_ref)
        SELECT c.id, am.author_id, am.body, am.created_at, 'assignment:' || am.id
        FROM assignment_messages am
        JOIN subcontract_assignments sa ON sa.id = am.assignment_id
        JOIN chat_channels c ON c.project_id = sa.project_id AND c.kind = 'SUBCONTRACTOR' AND c.relation_id = am.relation_id
        ON CONFLICT (legacy_ref) DO NOTHING
        RETURNING channel_id
      )
      INSERT INTO chat_reads (channel_id, user_id, last_read_at)
      SELECT DISTINCT c.id, u.id, CURRENT_TIMESTAMP
      FROM moved mv
      JOIN chat_channels c ON c.id = mv.channel_id
      JOIN users u ON u.relation_id = c.relation_id AND u.role::text = 'SUBCONTRACTOR'
      ON CONFLICT DO NOTHING;
    `);

    // -- Berichten (SRS 4.16, FR-MSG-01): direct messages between employees, and comments on a record
    await client.query(`CREATE TABLE IF NOT EXISTS messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    VARCHAR(10) NOT NULL CHECK (kind IN ('DIRECT', 'COMMENT')),
  author_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  recipient_id            UUID REFERENCES users(id) ON DELETE CASCADE,
  subject                 VARCHAR(255),
  body                    TEXT NOT NULL,
  entity_type             VARCHAR(30),
  entity_id               UUID,
  read_at                 TIMESTAMPTZ,
  edited_at               TIMESTAMPTZ,
  deleted_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT messages_shape_check CHECK (
    (kind = 'DIRECT' AND recipient_id IS NOT NULL AND entity_type IS NULL AND entity_id IS NULL)
    OR (kind = 'COMMENT' AND recipient_id IS NULL AND entity_type IS NOT NULL AND entity_id IS NOT NULL)
  )
);`);
    await client.query(`CREATE TABLE IF NOT EXISTS message_mentions (
  message_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);`);
    for (const index of [
      `CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient_id, created_at DESC) WHERE kind = 'DIRECT';`,
      `CREATE INDEX IF NOT EXISTS idx_messages_author ON messages (author_id, created_at DESC) WHERE kind = 'DIRECT';`,
      `CREATE INDEX IF NOT EXISTS idx_messages_entity ON messages (entity_type, entity_id, created_at) WHERE kind = 'COMMENT';`,
    ]) {
      await client.query(index);
    }

    // A chat copied from the old direct messages is as old as its first message (not as old as the copy), so the chat
    // list, which puts the newest activity first, does not treat every old conversation as brand new
    await client.query(`
      UPDATE chat_channels c SET created_at = f.first_at
      FROM (SELECT m.channel_id, MIN(m.created_at) AS first_at FROM chat_messages m
            WHERE m.legacy_ref LIKE 'dm:%' GROUP BY m.channel_id) f
      WHERE c.id = f.channel_id AND c.kind = 'DIRECT' AND c.created_at > f.first_at;
    `);
    // The old direct messages (inbox / sent) move into DIRECT chats once. Safe to repeat: a message that was copied
    // has its `legacy_ref` ('dm:<id>'), and nothing is done when there is nothing left to copy.
    const pendingDirect = await client.query(`
      SELECT 1 FROM messages m
      WHERE m.kind = 'DIRECT' AND m.author_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.legacy_ref = 'dm:' || m.id)
      LIMIT 1;
    `);
    if (pendingDirect.rows.length > 0) {
      const pairKey = `LEAST(m.author_id::text, m.recipient_id::text) || ':' || GREATEST(m.author_id::text, m.recipient_id::text)`;
      await client.query(`
        INSERT INTO chat_channels (kind, direct_key, created_at)
        SELECT 'DIRECT'::"ChatChannelKind", ${pairKey}, MIN(m.created_at) FROM messages m WHERE m.kind = 'DIRECT' AND m.author_id IS NOT NULL
        GROUP BY ${pairKey}
        ON CONFLICT DO NOTHING;
      `);
      await client.query(`
        INSERT INTO chat_members (channel_id, user_id)
        SELECT DISTINCT c.id, x.user_id::uuid
        FROM messages m
        JOIN chat_channels c ON c.direct_key = ${pairKey}
        CROSS JOIN LATERAL (VALUES (m.author_id), (m.recipient_id)) AS x(user_id)
        WHERE m.kind = 'DIRECT' AND m.author_id IS NOT NULL
        ON CONFLICT DO NOTHING;
      `);
      await client.query(`
        INSERT INTO chat_messages (channel_id, author_id, body, created_at, edited_at, deleted_at, legacy_ref)
        SELECT c.id, m.author_id,
               CASE WHEN COALESCE(btrim(m.subject), '') <> '' THEN m.subject || E'\n\n' || m.body ELSE m.body END,
               m.created_at, m.edited_at, m.deleted_at, 'dm:' || m.id
        FROM messages m JOIN chat_channels c ON c.direct_key = ${pairKey}
        WHERE m.kind = 'DIRECT' AND m.author_id IS NOT NULL
        ON CONFLICT (legacy_ref) DO NOTHING;
      `);
      // Read up to just before the first message the person had not opened (everything, when they opened all)
      await client.query(`
        INSERT INTO chat_reads (channel_id, user_id, last_read_at)
        SELECT c.id, m.recipient_id,
               COALESCE(MIN(m.created_at) FILTER (WHERE m.read_at IS NULL AND m.deleted_at IS NULL) - interval '1 microsecond', MAX(m.created_at))
        FROM messages m JOIN chat_channels c ON c.direct_key = ${pairKey}
        WHERE m.kind = 'DIRECT' AND m.author_id IS NOT NULL
        GROUP BY c.id, m.recipient_id
        ON CONFLICT (channel_id, user_id) DO NOTHING;
      `);
    }

    // -- Notifications (FR-MSG-05): the in-app list, and what each user wants (in the app / by email)
    await client.query(`CREATE TABLE IF NOT EXISTS notifications (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                    "NotificationType" NOT NULL,
  title                   VARCHAR(255) NOT NULL,
  body                    TEXT,
  entity_type             VARCHAR(30),
  entity_id               UUID,
  data                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id                UUID REFERENCES users(id) ON DELETE SET NULL,
  read_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notifications_entity_pair_check CHECK ((entity_type IS NULL) = (entity_id IS NULL))
);`);
    await client.query(`CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                    VARCHAR(30) NOT NULL,
  in_app                  BOOLEAN NOT NULL DEFAULT true,
  email                   BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, type)
);`);
    // A database made before the enum has type as VARCHAR(30): turn it into the enum once. A row whose type is not a
    // known kind (the code never wrote one) becomes OTHER and keeps its old name in data, so nothing is lost and the
    // start-up is never stopped by it. A no-op once the column is the enum.
    const notificationsAreText = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notifications'
         AND column_name = 'type' AND data_type = 'character varying'`,
    );
    if (notificationsAreText.rows.length > 0) {
      await client.query(
        `UPDATE notifications
         SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('original_type', type), type = 'OTHER'
         WHERE type NOT IN (${notificationValues})`,
      );
      await client.query(`ALTER TABLE notifications ALTER COLUMN type TYPE "NotificationType" USING type::"NotificationType"`);
    }
    for (const index of [
      `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications (user_id, entity_type, entity_id) WHERE read_at IS NULL;`,
    ]) {
      await client.query(index);
    }
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_project_files_work_order ON project_files (work_order_id);`,
    );

    // await client.query(`
    //  ALTER TABLE users
    //  ADD COLUMN IF NOT EXISTS staff_list uuid ARRAY DEFAULT '{}';
    // `);

    // await client.query(`
    //  ALTER TABLE users
    //  ADD COLUMN IF NOT EXISTS custom_fields jsonb DEFAULT '{}';
    // `);

    // -- ============================================================

    // -- FIX: naive TIMESTAMP columns -> TIMESTAMPTZ (see comment above)
    // -- ============================================================

    console.log("📝 Migrating naive timestamp columns to TIMESTAMPTZ...");
    await renameTimestampColumnsToSnakeCase(client);
    await migrateNaiveTimestampColumnsToTz(client);
    console.log("✅ Timestamp columns migrated successfully");

    // -- ============================================================
    // -- FIX: enable RLS on every public table (Supabase Data API advisory)
    // -- ============================================================

    console.log("📝 Enabling Row Level Security on all public tables...");
    await enableRowLevelSecurity(client);
    console.log("✅ Row Level Security enabled successfully");

    // -- ============================================================

    await client.query("COMMIT");
    console.log("✅ Database tables and triggers created successfully");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Database initialization error:", error);
    throw error;
  } finally {
    client.release();
  }
};

// Close all database connections
export const closeDatabase = async () => {
  await pool.end();
  await directPool.end();
  console.log("Database connections closed");
};
