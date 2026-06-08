/**
 * Visual-editor write-back.
 *
 * Given a source file and a `data-bf-loc` (line:col of a JSXOpeningElement, as
 * stamped by the dev-time Babel plugin), apply a className change by *splicing
 * the original source string* at the precise node offsets. We parse only to
 * locate offsets — we never regenerate the file — so diffs stay minimal and the
 * user's formatting is untouched. No Prettier, no @babel/generator.
 */
import { parse } from "@babel/parser";

export type VisualEditKind =
  | "not_found"
  | "dynamic_classname"
  | "parse_error";

export class VisualEditError extends Error {
  kind: VisualEditKind;
  status: number;
  constructor(kind: VisualEditKind, message: string, status: number) {
    super(message);
    this.name = "VisualEditError";
    this.kind = kind;
    this.status = status;
  }
}

interface AstNode {
  type?: string;
  start?: number;
  end?: number;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
}

/** Depth-first walk over a Babel AST without @babel/traverse. */
function walk(node: unknown, visit: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as AstNode;
  if (typeof n.type === "string") visit(n);
  for (const key in n) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const value = n[key];
    if (value && typeof value === "object") walk(value, visit);
  }
}

/** Parse `loc` of the form "<relpath>:<line>:<col>" (col is 1-based). */
export function parseLoc(
  loc: string,
): { file: string; line: number; column: number } | null {
  const m = /^(.*):(\d+):(\d+)$/.exec(loc);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
}

function findOpeningElement(
  code: string,
  line: number,
  column: number,
): AstNode | null {
  let ast: unknown;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
    });
  } catch (e) {
    throw new VisualEditError(
      "parse_error",
      e instanceof Error ? e.message : "parse failed",
      422,
    );
  }
  // data-bf-loc column is 1-based; Babel loc.column is 0-based.
  const targetColumn = column - 1;
  let match: AstNode | null = null;
  walk((ast as AstNode).program, (n) => {
    if (
      n.type === "JSXOpeningElement" &&
      n.loc &&
      n.loc.start.line === line &&
      n.loc.start.column === targetColumn
    ) {
      match = n;
    }
  });
  return match;
}

/**
 * Replace (or insert) the className of the JSX element at line:col with
 * `newClassName`. Returns the edited source. Throws VisualEditError on failure.
 */
export function setClassNameAtLoc(
  code: string,
  line: number,
  column: number,
  newClassName: string,
): string {
  const opening = findOpeningElement(code, line, column);
  if (!opening) {
    throw new VisualEditError("not_found", `No element at ${line}:${column}`, 404);
  }

  const attrs = (opening.attributes as AstNode[]) || [];
  const classAttr = attrs.find(
    (a) =>
      a.type === "JSXAttribute" &&
      (a.name as AstNode | undefined)?.name === "className",
  );

  // A valid JS/JSX double-quoted string literal for the attribute value.
  const literal = JSON.stringify(newClassName);

  if (!classAttr) {
    // No className yet — insert right after the tag name: <div  →  <div className="...".
    const name = opening.name as AstNode;
    const insertAt = name.end as number;
    return code.slice(0, insertAt) + ` className=${literal}` + code.slice(insertAt);
  }

  const value = classAttr.value as AstNode | null | undefined;

  if (!value) {
    // Boolean-style `className` (no value) — replace the whole attribute.
    return (
      code.slice(0, classAttr.start as number) +
      `className=${literal}` +
      code.slice(classAttr.end as number)
    );
  }

  if (value.type === "StringLiteral") {
    // Splice over the existing quoted string (offsets include the quotes).
    return (
      code.slice(0, value.start as number) +
      literal +
      code.slice(value.end as number)
    );
  }

  // className={...} — a dynamic expression we can't safely rewrite as a string.
  throw new VisualEditError(
    "dynamic_classname",
    "className is a dynamic expression; edit it in code or via the agent.",
    409,
  );
}
