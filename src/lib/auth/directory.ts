import { getIdentityDb } from "./database";
import { decryptPrivateData, encryptPrivateData } from "./crypto";

export interface IdentityEmail {
  id: string;
  emailAddress: string;
  verification: { status: string };
}
export interface IdentityUser {
  id: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  imageUrl: string;
  primaryEmailAddressId: string;
  primaryEmailAddress: IdentityEmail;
  emailAddresses: IdentityEmail[];
  publicMetadata: Record<string, unknown>;
  privateMetadata: Record<string, unknown>;
  unsafeMetadata: Record<string, unknown>;
  createdAt: number;
  lastSignInAt: number | null;
}
interface DirectoryRow {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  createdAt: Date;
  source_primary_email: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  email_addresses: IdentityEmail[] | null;
  public_metadata: Record<string, unknown> | null;
  unsafe_metadata: Record<string, unknown> | null;
  private_metadata_encrypted: string | null;
  last_sign_in_at: Date | null;
}
function toUser(row: DirectoryRow, includePrivate: boolean): IdentityUser {
  const primary = {
    id: `email_${row.id}`,
    emailAddress: row.email,
    verification: { status: row.emailVerified ? "verified" : "unverified" },
  };
  const aliases =
    row.source_primary_email &&
    row.source_primary_email.toLowerCase() !== row.email.toLowerCase()
      ? []
      : (row.email_addresses ?? []);
  const renamed =
    row.name !== [row.first_name, row.last_name].filter(Boolean).join(" ");
  const emails = [
    primary,
    ...aliases.filter(
      (e) => e.emailAddress.toLowerCase() !== row.email.toLowerCase(),
    ),
  ];
  return {
    id: row.id,
    fullName: row.name,
    firstName: renamed
      ? row.name.split(" ")[0]
      : (row.first_name ?? row.name.split(" ")[0] ?? null),
    lastName: renamed
      ? row.name.split(" ").slice(1).join(" ") || null
      : row.last_name,
    username: row.username,
    imageUrl: row.image ?? "",
    primaryEmailAddressId: primary.id,
    primaryEmailAddress: primary,
    emailAddresses: emails,
    publicMetadata: row.public_metadata ?? {},
    unsafeMetadata: row.unsafe_metadata ?? {},
    privateMetadata:
      includePrivate && row.private_metadata_encrypted
        ? decryptPrivateData(
            row.private_metadata_encrypted,
            `profile:${row.id}`,
          )
        : {},
    createdAt: new Date(row.createdAt).getTime(),
    lastSignInAt: row.last_sign_in_at
      ? new Date(row.last_sign_in_at).getTime()
      : null,
  };
}
export async function getIdentityUser(
  id: string,
  includePrivate = false,
): Promise<IdentityUser> {
  const { rows } = await getIdentityDb().query<DirectoryRow>(
    "SELECT u.*, p.*, u.username AS username FROM identity_user u LEFT JOIN identity_profile p ON p.user_id=u.id WHERE u.id=$1",
    [id],
  );
  if (!rows[0]) throw new Error("User not found");
  return toUser(rows[0], includePrivate);
}
export async function updateIdentityMetadata(
  id: string,
  patch: {
    publicMetadata?: Record<string, unknown>;
    privateMetadata?: Record<string, unknown>;
    unsafeMetadata?: Record<string, unknown>;
  },
  replacePublic = false,
): Promise<void> {
  const connection = await getIdentityDb().connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "INSERT INTO identity_profile (user_id, private_metadata_encrypted) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [id, encryptPrivateData({}, `profile:${id}`)],
    );
    const { rows } = await connection.query<{
      private_metadata_encrypted: string;
    }>(
      "SELECT private_metadata_encrypted FROM identity_profile WHERE user_id=$1 FOR UPDATE",
      [id],
    );
    const privateData = decryptPrivateData<Record<string, unknown>>(
      rows[0].private_metadata_encrypted,
      `profile:${id}`,
    );
    await connection.query(
      `UPDATE identity_profile SET public_metadata=CASE WHEN $5 THEN $2::jsonb ELSE public_metadata || $2::jsonb END,
      unsafe_metadata=unsafe_metadata || $3::jsonb, private_metadata_encrypted=$4, updated_at=now() WHERE user_id=$1`,
      [
        id,
        JSON.stringify(patch.publicMetadata ?? {}),
        JSON.stringify(patch.unsafeMetadata ?? {}),
        encryptPrivateData(
          { ...privateData, ...patch.privateMetadata },
          `profile:${id}`,
        ),
        replacePublic,
      ],
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
/** Compatibility surface for the app's existing directory consumers; no Clerk requests. */
export async function identityClient() {
  return {
    users: {
      getUser: (id: string) => getIdentityUser(id, true),
      updateUserMetadata: updateIdentityMetadata,
      async getUserList(
        options: {
          userId?: string[];
          emailAddress?: string[];
          limit?: number;
          offset?: number;
          orderBy?: string;
        } = {},
      ) {
        const emails =
          options.emailAddress?.map((e) => e.toLowerCase()) ?? null;
        const where = `($4::text[] IS NULL OR u.id=ANY($4)) AND ($1::text[] IS NULL OR lower(u.email)=ANY($1) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.email_addresses,'[]')) e WHERE lower(e->>'emailAddress')=ANY($1)))`;
        const params = [
          emails,
          Math.min(options.limit ?? 100, 500),
          Math.max(options.offset ?? 0, 0),
          options.userId ?? null,
        ];
        const [result, count] = await Promise.all([
          getIdentityDb().query<DirectoryRow>(
            `SELECT u.*, p.*, u.username AS username FROM identity_user u LEFT JOIN identity_profile p ON p.user_id=u.id WHERE ${where} ORDER BY u."createdAt" DESC LIMIT $2 OFFSET $3`,
            params,
          ),
          getIdentityDb().query<{ count: string }>(
            `SELECT count(*) FROM identity_user u LEFT JOIN identity_profile p ON p.user_id=u.id WHERE ${where.replaceAll("$4", "$2")}`,
            [emails, options.userId ?? null],
          ),
        ]);
        return {
          data: result.rows.map((row) => toUser(row, false)),
          totalCount: Number(count.rows[0].count),
        };
      },
    },
  };
}
