import crypto from "node:crypto";

export interface TokenVault {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export function createTokenVault(keyBase64: string): TokenVault {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes.");

  return {
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ["v1", iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
    },
    decrypt(ciphertext) {
      const [version, ivValue, tagValue, bodyValue] = ciphertext.split(".");
      if (version !== "v1" || !ivValue || !tagValue || !bodyValue) throw new Error("Unsupported encrypted token format.");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(bodyValue, "base64url")),
        decipher.final()
      ]).toString("utf8");
    }
  };
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
