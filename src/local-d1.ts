import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

const require = createRequire(import.meta.url);

type D1Value = null | number | string | { readonly $archastroBlob: Uint8Array };

interface StatementRequest {
  readonly sql: string;
  readonly params?: readonly D1Value[];
}

interface QueryRequest extends StatementRequest {
  readonly mode: "first" | "run" | "all" | "raw";
  readonly columnName?: string;
  readonly columnNames?: boolean;
}

export class LocalD1 {
  readonly #database: DatabaseSync;

  constructor() {
    // Loading node:sqlite emits an experimental warning on Node 24. Keep that
    // feature-specific module out of commands such as `version` that never use D1.
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (location: string) => DatabaseSync;
    };
    this.#database = new DatabaseSync(":memory:");
  }

  async query(input: unknown): Promise<unknown> {
    const request = validateQuery(input);
    const statement = this.#database.prepare(request.sql);
    const params = (request.params ?? []).map(decodeValue);
    const started = performance.now();
    if (request.mode === "run") {
      const result = statement.run(...params);
      return d1Result([], started, result.changes, result.lastInsertRowid);
    }

    const rows = statement.all(...params).map(normalizeRow);
    if (request.mode === "all") return d1Result(rows, started, 0, 0);
    if (request.mode === "first") {
      const row = rows[0];
      if (row === undefined) return null;
      if (request.columnName === undefined) return row;
      if (!Object.hasOwn(row, request.columnName)) {
        throw new Error(`D1 column not found: ${request.columnName}`);
      }
      return row[request.columnName];
    }
    const columns = statement.columns().map((column) => column.name);
    const rawRows = rows.map((row) => columns.map((column) => row[column]));
    return request.columnNames ? [columns, ...rawRows] : rawRows;
  }

  async batch(input: unknown): Promise<unknown[]> {
    const statements = validateBatch(input);
    this.#database.exec("BEGIN");
    try {
      const results = statements.map((request) => {
        const statement = this.#database.prepare(request.sql);
        const params = (request.params ?? []).map(decodeValue);
        const started = performance.now();
        if (statement.columns().length === 0) {
          const result = statement.run(...params);
          return d1Result([], started, result.changes, result.lastInsertRowid);
        }
        return d1Result(statement.all(...params).map(normalizeRow), started, 0, 0);
      });
      this.#database.exec("COMMIT");
      return results;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(input: unknown): Promise<{ count: number; duration: number }> {
    const request = validateStatement(input);
    const started = performance.now();
    this.#database.exec(request.sql);
    return {
      count: request.sql.split(";").filter((part) => part.trim() !== "").length,
      duration: performance.now() - started,
    };
  }

  close(): void {
    this.#database.close();
  }
}

function validateQuery(input: unknown): QueryRequest {
  const request = validateStatement(input) as Partial<QueryRequest>;
  if (!(["first", "run", "all", "raw"] as const).includes(request.mode!)) {
    throw new TypeError("invalid local D1 query mode");
  }
  if (request.columnName !== undefined && typeof request.columnName !== "string") {
    throw new TypeError("invalid local D1 column name");
  }
  if (request.columnNames !== undefined && typeof request.columnNames !== "boolean") {
    throw new TypeError("invalid local D1 raw options");
  }
  return request as QueryRequest;
}

function validateBatch(input: unknown): StatementRequest[] {
  const object = plainObject(input);
  if (!Array.isArray(object.statements)) {
    throw new TypeError("invalid local D1 batch");
  }
  return object.statements.map(validateStatement);
}

function validateStatement(input: unknown): StatementRequest {
  const object = plainObject(input);
  if (typeof object.sql !== "string" || object.sql.trim() === "") {
    throw new TypeError("local D1 SQL must be a non-empty string");
  }
  if (object.params !== undefined && !Array.isArray(object.params)) {
    throw new TypeError("invalid local D1 parameters");
  }
  return object as unknown as StatementRequest;
}

function plainObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("invalid local D1 input");
  }
  return input as Record<string, unknown>;
}

function decodeValue(value: D1Value): SQLInputValue {
  if (typeof value === "object" && value !== null) {
    if (
      Object.keys(value).length !== 1 ||
      !(value.$archastroBlob instanceof Uint8Array)
    ) {
      throw new TypeError("invalid local D1 value");
    }
    return value.$archastroBlob;
  }
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  throw new TypeError("invalid local D1 value");
}

function normalizeRow(row: Record<string, SQLInputValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? { $archastroBlob: value.slice() } : value,
    ]),
  );
}

function d1Result(
  results: Record<string, unknown>[],
  started: number,
  changes: number | bigint,
  lastInsertRowid: number | bigint,
) {
  return {
    success: true,
    results,
    meta: {
      duration: performance.now() - started,
      changes: Number(changes),
      last_row_id: Number(lastInsertRowid),
      rows_read: results.length,
      rows_written: Number(changes),
    },
  };
}
