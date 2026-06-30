/**
 * Swift client codegen from a Convex function spec.
 *
 * The Fly deploy worker runs `convex function-spec` after every successful
 * deploy and returns the manifest (function identifiers, types, visibility).
 * For Swift projects we turn that into `Sources/Core/ConvexAPI.swift` — one
 * nested enum per backend module, one `static let` per public function — the
 * Swift analog of web's `convex/_generated/api`. Function names are unchecked
 * strings at the ConvexMobile call site, so routing every call through these
 * generated constants converts the "stale function name" class of bug from a
 * runtime ServerError into a compile error on the next build.
 *
 * Names-only v1: argument validators in the spec are NOT turned into Swift
 * types. Internal functions and HTTP actions are excluded — clients can't
 * call them.
 */
import { sandboxWriteFile } from "./vercel-sandbox";

/** Shape of `convex function-spec` output (defensively typed). */
export interface ConvexFunctionSpec {
  url?: string;
  functions?: Array<{
    /** e.g. "items.js:list" or "notes/helpers.js:get" */
    identifier?: string;
    /** "Query" | "Mutation" | "Action" | "HttpAction" */
    functionType?: string;
    udfType?: string;
    visibility?: { kind?: string };
  }>;
}

export const SWIFT_CONVEX_API_PATH = "/Sources/Core/ConvexAPI.swift";

const SWIFT_RESERVED = new Set([
  "associatedtype", "class", "deinit", "enum", "extension", "fileprivate",
  "func", "import", "init", "inout", "internal", "let", "open", "operator",
  "private", "protocol", "public", "static", "struct", "subscript",
  "typealias", "var", "case", "default", "defer", "do", "else", "fallthrough",
  "for", "guard", "if", "in", "repeat", "return", "switch", "where", "while",
  "as", "false", "is", "nil", "self", "Self", "super", "throw", "true", "try",
]);

/** Make a valid Swift member identifier (backtick-quote reserved words). */
function swiftIdent(name: string): string {
  let ident = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(ident)) ident = `_${ident}`;
  if (SWIFT_RESERVED.has(ident)) ident = `\`${ident}\``;
  return ident;
}

/** "notes/helpers" → "NotesHelpers" (flattened, UpperCamel). */
function moduleEnumName(modulePath: string): string {
  const name = modulePath
    .split("/")
    .flatMap((seg) => seg.split(/[^A-Za-z0-9]+/))
    .filter(Boolean)
    .map((seg) => seg[0].toUpperCase() + seg.slice(1))
    .join("");
  return swiftIdent(name || "Root");
}

/**
 * Render ConvexAPI.swift from a function spec. Returns null when the spec is
 * unusable (missing/empty functions array) — callers should then leave the
 * existing file untouched rather than clobbering it with an empty enum.
 */
export function swiftConvexApiContent(spec: ConvexFunctionSpec): string | null {
  const fns = Array.isArray(spec?.functions) ? spec.functions : null;
  if (!fns) return null;

  // module path → [{ constName, callString, kind }]
  const modules = new Map<string, Array<{ constName: string; callString: string; kind: string }>>();

  for (const fn of fns) {
    const identifier = fn.identifier ?? "";
    const sep = identifier.lastIndexOf(":");
    if (sep <= 0) continue;

    const kind = (fn.functionType ?? fn.udfType ?? "").toLowerCase();
    if (kind === "httpaction") continue; // not callable via the client API
    const visibility = fn.visibility?.kind;
    if (visibility && visibility !== "public") continue; // internal* — clients can't call

    const modulePath = identifier.slice(0, sep).replace(/\.(js|ts)$/, "");
    const fnName = identifier.slice(sep + 1);
    const callString = `${modulePath}:${fnName}`;

    const list = modules.get(modulePath) ?? [];
    if (!list.some((e) => e.callString === callString)) {
      list.push({ constName: swiftIdent(fnName), callString, kind: kind || "function" });
    }
    modules.set(modulePath, list);
  }

  const lines: string[] = [
    "// ─────────────────────────────────────────────────────────────────",
    "// ConvexAPI.swift — Convex function-name constants (PLATFORM-MANAGED)",
    "//",
    "// ⚠️  DO NOT EDIT BY HAND.",
    "//",
    "// Botflow REGENERATES this file from the deployed backend on every",
    "// `convexDeploy`, one nested enum per backend module, one constant per",
    "// public function. It is the Swift analog of the web template's",
    "// `convex/_generated/api` — the only safe way to reference a Convex",
    "// function from Swift. ALWAYS call through these constants, never a raw",
    '// "file:function" string literal.',
    "//",
    "// Workflow when adding/renaming backend functions:",
    "//   1. Edit /convex (schema + functions).",
    "//   2. Deploy the backend — this file regenerates with the new constants.",
    "//   3. Only then write Swift code referencing them.",
    "// ─────────────────────────────────────────────────────────────────",
    "",
    "import Foundation",
    "",
    "enum ConvexAPI {",
  ];

  const sortedModules = [...modules.keys()].sort();
  if (sortedModules.length === 0) {
    lines.push("    // No public functions are deployed yet.");
  }
  for (const modulePath of sortedModules) {
    const entries = modules.get(modulePath)!;
    entries.sort((a, b) => a.callString.localeCompare(b.callString));
    lines.push(`    /// convex/${modulePath}.ts`);
    lines.push(`    enum ${moduleEnumName(modulePath)} {`);
    for (const e of entries) {
      lines.push(`        /// ${e.kind}`);
      lines.push(`        static let ${e.constName} = ${JSON.stringify(e.callString)}`);
    }
    lines.push("    }");
  }
  lines.push("}", "");

  return lines.join("\n");
}

/**
 * Generate and write ConvexAPI.swift into a Swift project's sandbox after a
 * successful backend deploy. No-op (false) for non-Swift projects or unusable
 * specs. Never throws — codegen must not fail a deploy.
 */
export async function writeSwiftConvexApi(
  projectId: string,
  project: { platform: string | null },
  spec: ConvexFunctionSpec | null | undefined,
): Promise<boolean> {
  try {
    if (project.platform !== "swift" || !spec) return false;
    const content = swiftConvexApiContent(spec);
    if (content === null) return false;
    await sandboxWriteFile(projectId, SWIFT_CONVEX_API_PATH, content);
    return true;
  } catch (err) {
    console.warn("[swift-convex-codegen] non-fatal:", err);
    return false;
  }
}
