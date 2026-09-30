import { compare } from "bcryptjs";
import { hashPassword, verifyPassword } from "better-auth/crypto";

export const password = {
  hash: hashPassword,
  async verify({
    hash,
    password,
  }: {
    hash: string;
    password: string;
  }): Promise<boolean> {
    // Existing bcrypt hashes remain usable; new/reset passwords use Better Auth's scrypt.
    if (/^\$2[aby]\$/.test(hash))
      return compare(password, hash.replace(/^\$2y\$/, "$2b$"));
    return verifyPassword({ hash, password });
  },
};
