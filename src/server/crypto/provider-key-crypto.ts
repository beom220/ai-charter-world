import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// Provider API 키 암호화 (architecture.md §8.1). Worker에서도 쓰므로 Next.js·server-only에 의존하지 않는다.
// - AES-256-GCM, IV 12바이트(매번 새로 생성), 인증 태그 16바이트
// - AAD = "userId:connectionId" → 암호문을 다른 행에 옮기면 복호화 실패
// - keyFingerprint = HMAC-SHA256(KEY_FINGERPRINT_SECRET, 원문) → 교체 감지용, 원문 복원 불가
// 오류 메시지에는 키·암호문·환경변수 값을 담지 않는다.

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MIN_FINGERPRINT_SECRET_LENGTH = 32;

/** 현재 마스터 키 버전. 마스터 키 교체 시 버전별 재암호화 스크립트와 함께 올린다. */
export const CURRENT_ENCRYPTION_KEY_VERSION = 1;

export const PROVIDER_CRYPTO_ENV_KEYS = ["PROVIDER_KEY_ENCRYPTION_KEY", "KEY_FINGERPRINT_SECRET"] as const;

export type ProviderKeyMaterial = {
  encryptionKey: Buffer;
  fingerprintSecret: Buffer;
};

export type EncryptedSecret = {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  keyVersion: number;
};

export class CryptoConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`API 키 암호화 설정 오류: ${problems.join(", ")}. .env.example을 참고하세요.`);
    this.name = "CryptoConfigError";
  }
}

/** 복호화 실패. 원인(키·IV·태그·AAD·버전)을 구분해 알려 주지 않는다. */
export class DecryptionError extends Error {
  constructor() {
    super("저장된 API 키를 복호화할 수 없습니다.");
    this.name = "DecryptionError";
  }
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function readProviderKeyMaterial(source: Readonly<Record<string, string | undefined>>): ProviderKeyMaterial {
  const problems: string[] = [];
  const rawKey = source.PROVIDER_KEY_ENCRYPTION_KEY?.trim() ?? "";
  const rawSecret = source.KEY_FINGERPRINT_SECRET?.trim() ?? "";

  let encryptionKey = Buffer.alloc(0);
  if (!rawKey) {
    problems.push("PROVIDER_KEY_ENCRYPTION_KEY 누락");
  } else if (!STRICT_BASE64.test(rawKey)) {
    problems.push("PROVIDER_KEY_ENCRYPTION_KEY는 base64여야 함");
  } else {
    encryptionKey = Buffer.from(rawKey, "base64");
    if (encryptionKey.length !== KEY_BYTES) {
      problems.push(`PROVIDER_KEY_ENCRYPTION_KEY는 base64로 ${KEY_BYTES}바이트여야 함`);
    }
  }

  if (!rawSecret) problems.push("KEY_FINGERPRINT_SECRET 누락");
  else if (rawSecret.length < MIN_FINGERPRINT_SECRET_LENGTH) {
    problems.push(`KEY_FINGERPRINT_SECRET는 ${MIN_FINGERPRINT_SECRET_LENGTH}자 이상이어야 함`);
  }

  if (problems.length > 0) throw new CryptoConfigError(problems);
  return { encryptionKey, fingerprintSecret: Buffer.from(rawSecret, "utf8") };
}

let cached: ProviderKeyMaterial | undefined;

/** process.env에서 읽은 키 재료. 첫 사용 시 검증하고, 실패하면 캐시하지 않는다. */
export function getProviderKeyMaterial(): ProviderKeyMaterial {
  cached ??= readProviderKeyMaterial(process.env);
  return cached;
}

/** 저장 행과 결합하는 AAD. 사용자·연결이 바뀌면 복호화가 실패한다. */
export function connectionAad(userId: string, connectionId: string): string {
  return `${userId}:${connectionId}`;
}

export function encryptSecret(plaintext: string, aad: string, material: ProviderKeyMaterial): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, material.encryptionKey, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    authTag: new Uint8Array(cipher.getAuthTag()),
    keyVersion: CURRENT_ENCRYPTION_KEY_VERSION,
  };
}

export function decryptSecret(encrypted: EncryptedSecret, aad: string, material: ProviderKeyMaterial): string {
  if (
    encrypted.keyVersion !== CURRENT_ENCRYPTION_KEY_VERSION ||
    encrypted.iv.length !== IV_BYTES ||
    encrypted.authTag.length !== AUTH_TAG_BYTES
  ) {
    throw new DecryptionError();
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, material.encryptionKey, encrypted.iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError();
  }
}

export function keyFingerprint(plaintext: string, material: ProviderKeyMaterial): string {
  return createHmac("sha256", material.fingerprintSecret).update(plaintext, "utf8").digest("hex");
}

