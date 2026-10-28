// Splits a SQL file into the statements Zetaris takes one at a time. Ported from
// split_statements in zetaris/getting-started (scripts/zetaris_sql.py, Apache-2.0):
// semicolons inside quotes do not split, comments are dropped, and the CREATE TABLEs
// after COMPILE USL ... DDL stay in that statement, because a multi-table USL is sent whole.

export function splitStatements(text: string): string[] {
  const statements: string[] = [];
  let buf = "";
  let quote: string | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
      buf += c;
    } else if (text.startsWith("--", i)) {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    } else if (c === ";") {
      push(statements, buf);
      buf = "";
    } else {
      buf += c;
    }
    i += 1;
  }
  push(statements, buf);
  return statements;
}

function push(statements: string[], raw: string): void {
  const statement = raw.trim();
  if (!statement) return;
  const last = statements.at(-1);
  if (statement.toUpperCase().startsWith("CREATE TABLE") && last?.toUpperCase().startsWith("COMPILE USL")) {
    statements[statements.length - 1] = `${last};\n${statement}`;
  } else {
    statements.push(statement);
  }
}

// Statements that remove something or change who can reach it.
const DESTRUCTIVE = /^\s*(DROP|REMOVE|DELETE|TRUNCATE|GRANT|REVOKE)\b/i;

export const isDestructive = (statement: string): boolean => DESTRUCTIVE.test(statement);
