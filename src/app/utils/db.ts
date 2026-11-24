import { AsyncLocalStorage } from "async_hooks";
import { QueryResult } from "pg";
import { pool } from "../../config/database";

// Diagnostic (off by default, DB_TRACE_NESTED=true): reports a query() that runs while the same
// request still holds a transaction connection. With the pool at 20 connections, 20 requests each
// holding one and waiting for a second one deadlock until the connect timeout.
const traceNested = process.env.DB_TRACE_NESTED === "true";
const inTransaction = new AsyncLocalStorage<boolean>();
const reported = new Set<string>();

// Helper function for queries
export const query = async (
  text: string,
  params?: any[],
): Promise<QueryResult> => {
  const start = Date.now();
  if (traceNested && inTransaction.getStore()) {
    const where = (new Error().stack ?? "").split("\n").slice(2, 7).filter((l) => !l.includes("node_modules") && !l.includes("utils/db.ts")).map((l) => l.trim()).join(" <- ");
    if (!reported.has(where)) {
      reported.add(where);
      console.warn("NESTED_QUERY_IN_TRANSACTION", where, "::", text.replace(/\s+/g, " ").slice(0, 90));
    }
  }
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    // console.log('Executed query', { text, duration, rows: result.rowCount });
    return result;
  } catch (error) {
    console.error("Query error:", { text, error });
    throw error;
  }
};

// Transaction helper
export const transaction = async <T>(
  callback: (client: any) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  // A checked-out client is not watched by the pool: if the database drops it (restart, failover) while
  // the code is busy elsewhere, its "error" event has no listener and Node would stop the whole server
  let broken = false;
  const onError = (error: Error) => {
    broken = true;
    console.error("❌ Database connection lost during a transaction:", error.message);
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    const result = traceNested ? await inTransaction.run(true, () => callback(client)) : await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is gone; the original error is the one to report
      broken = true;
    }
    throw error;
  } finally {
    client.removeListener("error", onError);
    // true = throw this connection away instead of returning it to the pool
    client.release(broken ? true : undefined);
  }
};
