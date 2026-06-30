/**
 * Read-only source for a public project's editor pane.
 *
 * Downloads the project's source bundle (gzipped tar, produced on a public
 * deploy) from UploadThing, unpacks it in-memory (built-in zlib + a minimal tar
 * reader — no extra deps), and returns the text files. Binary/oversized files
 * are skipped. Public, no auth required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'zlib';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { enforce, identifierFor } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 256 * 1024;

interface SourceFile {
  path: string;
  content: string;
}

/** Minimal tar reader (ustar + GNU long-name). Returns regular text files only. */
function extractTextFiles(tar: Buffer): SourceFile[] {
  const files: SourceFile[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  const readField = (block: Buffer, start: number, len: number): string =>
    block.subarray(start, start + len).toString('utf-8').replace(/\0[\s\S]*$/, '').trim();

  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive

    let name = readField(block, 0, 100);
    const prefix = readField(block, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(readField(block, 124, 12) || '0', 8) || 0;
    const type = String.fromCharCode(block[156]);

    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      // GNU long name — applies to the next entry.
      pendingLongName = data.toString('utf-8').replace(/\0[\s\S]*$/, '');
      continue;
    }
    let entryName = pendingLongName ?? name;
    pendingLongName = null;

    // Only regular files ('0' or NUL). Skip dirs, symlinks, pax/global headers.
    if (type !== '0' && type !== '\0') continue;

    entryName = entryName.replace(/^\.\//, '');
    if (!entryName.startsWith('/')) entryName = `/${entryName}`;
    if (entryName.includes('/node_modules/') || entryName.includes('/.git/')) continue;
    if (size === 0 || size > MAX_FILE_BYTES) continue;
    if (data.includes(0)) continue; // crude binary check

    files.push({ path: entryName, content: data.toString('utf-8') });
  }

  return files;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    // Public, unauth, heavy (remote fetch + gunzip + tar parse): strict per-IP cap.
    const blocked = await enforce(identifierFor(null, req), 'publicHeavy');
    if (blocked) return blocked;

    const { slug } = await params;
    const db = getDb();
    const [project] = await db
      .select({
        publicSourceUrl: projects.publicSourceUrl,
        isPublic: projects.isPublic,
      })
      .from(projects)
      .where(and(eq(projects.publicSlug, slug), eq(projects.isPublic, true)))
      .limit(1);

    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!project.publicSourceUrl) {
      // Deployed + public but no bundle (e.g. legacy). Editor pane is hidden.
      return NextResponse.json({ files: [], hasBundle: false });
    }

    const res = await fetch(project.publicSourceUrl);
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch source bundle' }, { status: 502 });
    }
    const gz = Buffer.from(await res.arrayBuffer());
    const tar = gunzipSync(gz);
    const files = extractTextFiles(tar).sort((a, b) => a.path.localeCompare(b.path));

    return NextResponse.json({ files, hasBundle: true });
  } catch (e) {
    console.error('[public source] failed:', e);
    return NextResponse.json({ error: 'Failed to load source' }, { status: 500 });
  }
}
