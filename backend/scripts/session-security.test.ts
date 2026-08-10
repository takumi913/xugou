import assert from "node:assert/strict";
import {
  digestAdminSessionToken,
  SessionConfigurationError,
} from "../src/modules/auth/persistence/D1SessionStore";
import { generateSecureToken } from "../src/utils/crypto";

const token = `xgs_${generateSecureToken(32)}`;
assert.match(token, /^xgs_[0-9a-f]{64}$/);

const env = { SESSION_HMAC_SECRET: "fixture-secret-with-at-least-32-characters" };
const firstDigest = await digestAdminSessionToken(env, token);
const secondDigest = await digestAdminSessionToken(env, token);
const otherDigest = await digestAdminSessionToken(env, `${token}0`);

assert.match(firstDigest, /^[0-9a-f]{64}$/);
assert.equal(firstDigest, secondDigest, "same token must have a stable digest");
assert.notEqual(firstDigest, otherDigest, "different tokens must have different digests");
assert.equal(firstDigest.includes(token), false, "digest must not contain plaintext token");

await assert.rejects(
  digestAdminSessionToken({ SESSION_HMAC_SECRET: "short" }, token),
  SessionConfigurationError
);
