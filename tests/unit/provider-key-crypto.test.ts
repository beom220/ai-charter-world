import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { geminiApiKeyInputSchema, isAcceptableGeminiApiKey } from "@/lib/schemas/provider";
import {
  connectionAad,
  CryptoConfigError,
  CURRENT_ENCRYPTION_KEY_VERSION,
  decryptSecret,
  DecryptionError,
  encryptSecret,
  keyFingerprint,
  readProviderKeyMaterial,
  type EncryptedSecret,
} from "@/server/crypto/provider-key-crypto";

// 테스트용 가짜 키. 비밀 스캐너 오탐을 피하려고 접두사를 런타임에 붙인다.
const FAKE_GEMINI_KEY = ["AIza", "SyUnitTestKey0000000000000000000000"].join("");
const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "unit-test-fingerprint-secret-0123456789",
});
const AAD = connectionAad("user-1", "conn-1");

const flip = (bytes: Uint8Array<ArrayBuffer>, index = 0) => {
  const copy = new Uint8Array(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
};

describe("AES-256-GCM 암호화", () => {
  it("암호화 후 복호화하면 원문과 같다", () => {
    const encrypted = encryptSecret(FAKE_GEMINI_KEY, AAD, material);
    expect(decryptSecret(encrypted, AAD, material)).toBe(FAKE_GEMINI_KEY);
    expect(encrypted.keyVersion).toBe(CURRENT_ENCRYPTION_KEY_VERSION);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
  });

  it("같은 평문도 매번 다른 IV·암호문이 된다", () => {
    const results = Array.from({ length: 20 }, () => encryptSecret(FAKE_GEMINI_KEY, AAD, material));
    const ivs = new Set(results.map((r) => Buffer.from(r.iv).toString("hex")));
    const ciphertexts = new Set(results.map((r) => Buffer.from(r.ciphertext).toString("hex")));
    expect(ivs.size).toBe(20);
    expect(ciphertexts.size).toBe(20);
  });

  it("암호문에 평문이 그대로 들어 있지 않다", () => {
    const { ciphertext } = encryptSecret(FAKE_GEMINI_KEY, AAD, material);
    expect(Buffer.from(ciphertext).includes(Buffer.from(FAKE_GEMINI_KEY))).toBe(false);
    expect(Buffer.from(ciphertext).toString("utf8")).not.toContain("AIza");
  });

  describe("변조·불일치는 복호화를 거부한다", () => {
    const encrypted = encryptSecret(FAKE_GEMINI_KEY, AAD, material);
    const otherMaterial = readProviderKeyMaterial({
      PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      KEY_FINGERPRINT_SECRET: "x".repeat(32),
    });
    const cases: [string, EncryptedSecret, string, typeof material][] = [
      ["다른 마스터 키", encrypted, AAD, otherMaterial],
      ["변조된 암호문", { ...encrypted, ciphertext: flip(encrypted.ciphertext) }, AAD, material],
      ["변조된 IV", { ...encrypted, iv: flip(encrypted.iv) }, AAD, material],
      ["변조된 인증 태그", { ...encrypted, authTag: flip(encrypted.authTag, 15) }, AAD, material],
      ["잘린 인증 태그", { ...encrypted, authTag: encrypted.authTag.slice(0, 8) }, AAD, material],
      ["잘못된 IV 길이", { ...encrypted, iv: new Uint8Array(16) }, AAD, material],
      ["다른 사용자의 AAD", encrypted, connectionAad("user-2", "conn-1"), material],
      ["다른 연결의 AAD", encrypted, connectionAad("user-1", "conn-2"), material],
      ["알 수 없는 키 버전", { ...encrypted, keyVersion: 2 }, AAD, material],
    ];
    for (const [label, input, aad, m] of cases) {
      it(label, () => {
        expect(() => decryptSecret(input, aad, m)).toThrow(DecryptionError);
      });
    }

    it("복호화 오류 메시지에 원인·값을 담지 않는다", () => {
      try {
        decryptSecret({ ...encrypted, authTag: flip(encrypted.authTag) }, AAD, material);
      } catch (error) {
        expect((error as Error).message).toBe("저장된 API 키를 복호화할 수 없습니다.");
      }
    });
  });
});

describe("키 지문 (HMAC-SHA256)", () => {
  it("같은 키는 같은 지문, 다른 키·다른 비밀은 다른 지문이며 원문을 포함하지 않는다", () => {
    const a = keyFingerprint(FAKE_GEMINI_KEY, material);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(keyFingerprint(FAKE_GEMINI_KEY, material)).toBe(a);
    expect(keyFingerprint(`${FAKE_GEMINI_KEY.slice(0, -1)}X`, material)).not.toBe(a);
    const other = readProviderKeyMaterial({ PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"), KEY_FINGERPRINT_SECRET: "y".repeat(40) });
    expect(keyFingerprint(FAKE_GEMINI_KEY, other)).not.toBe(a);
    expect(a).not.toContain(FAKE_GEMINI_KEY);
  });
});

describe("암호화 환경변수 검증", () => {
  const good = { PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"), KEY_FINGERPRINT_SECRET: "z".repeat(32) };
  const problemsOf = (env: Record<string, string | undefined>) => {
    try {
      readProviderKeyMaterial(env);
      return [];
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoConfigError);
      return (error as CryptoConfigError).problems;
    }
  };

  it("누락", () => {
    expect(problemsOf({})).toEqual(["PROVIDER_KEY_ENCRYPTION_KEY 누락", "KEY_FINGERPRINT_SECRET 누락"]);
  });

  it("base64가 아니거나 32바이트가 아닌 마스터 키", () => {
    expect(problemsOf({ ...good, PROVIDER_KEY_ENCRYPTION_KEY: "not base64 !!" })).toEqual(["PROVIDER_KEY_ENCRYPTION_KEY는 base64여야 함"]);
    expect(problemsOf({ ...good, PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(16).toString("base64") })).toEqual([
      "PROVIDER_KEY_ENCRYPTION_KEY는 base64로 32바이트여야 함",
    ]);
    expect(problemsOf({ ...good, PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(33).toString("base64") })).toHaveLength(1);
  });

  it("짧은 지문 비밀, 그리고 오류 메시지에 값이 담기지 않는다", () => {
    const shortSecret = "short-fingerprint";
    try {
      readProviderKeyMaterial({ PROVIDER_KEY_ENCRYPTION_KEY: "bad", KEY_FINGERPRINT_SECRET: shortSecret });
    } catch (error) {
      expect((error as Error).message).toMatch(/KEY_FINGERPRINT_SECRET는 32자 이상/);
      expect((error as Error).message).not.toContain(shortSecret);
    }
  });

  it("정상 값", () => {
    expect(problemsOf(good)).toEqual([]);
  });
});

describe("Gemini API 키 입력 정책 (형식을 앱이 정의하지 않음)", () => {
  // 실제 키가 아닌 가짜 값들. 접두사는 런타임에 조립한다.
  const variants = [
    FAKE_GEMINI_KEY, // AIza…
    ["AQ", "Ab8FakeNewFormatKey_0123456789-abcdef"].join("."), // AQ.…
    "sk-some-other-prefix-123", // 다른 접두사
    "short", // 짧은 값
    "key/with+base64=chars", // 이전 허용 문자 집합 밖
    "키값-유니코드-포함", // 비ASCII
    "  leading-and-trailing-spaces  ", // 앞뒤 공백 (보정하지 않음)
    "inner space key", // 내부 공백
    "x".repeat(4096), // 최대 길이
  ];

  for (const apiKey of variants) {
    it(`그대로 받는다: ${JSON.stringify(apiKey.slice(0, 24))}${apiKey.length > 24 ? "…" : ""}`, () => {
      expect(geminiApiKeyInputSchema.parse({ apiKey })).toEqual({ apiKey });
      expect(isAcceptableGeminiApiKey(apiKey)).toBe(true);
    });
  }

  it("userId 같은 다른 필드는 버린다", () => {
    expect(geminiApiKeyInputSchema.parse({ apiKey: FAKE_GEMINI_KEY, userId: "victim" })).toEqual({ apiKey: FAKE_GEMINI_KEY });
  });

  it("비어 있거나 공백만 있는 값, 4096자 초과, 문자열이 아닌 값은 거부하고 오류에 입력값을 담지 않는다", () => {
    const tooLong = `AQ.${"y".repeat(4094)}`;
    const inputs = [{ apiKey: "" }, { apiKey: " " }, { apiKey: "\t\n  \r" }, { apiKey: tooLong }, { apiKey: 123 }, { apiKey: null }, {}, null];
    for (const input of inputs) {
      const result = geminiApiKeyInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain(tooLong.slice(0, 50));
    }
    expect(isAcceptableGeminiApiKey(tooLong)).toBe(false);
  });
});
