import assert from "node:assert/strict";
import {
  NotificationSecretConfigurationError,
  decryptNotificationSecretPayload,
  encryptNotificationSecretPayload,
  rewrapNotificationSecretPayload,
  splitNotificationConfig,
} from "../src/modules/notifications/security/notification-secret-crypto";

const env = { NOTIFICATION_KEK: Buffer.alloc(32, 7).toString("base64") };
const split = splitNotificationConfig("telegram", {
  botToken: "fixture-bot-secret",
  chatId: "12345",
});
assert.deepEqual(split.publicConfig, { chatId: "12345" });
assert.deepEqual(split.secrets, { botToken: "fixture-bot-secret" });

const encrypted = await encryptNotificationSecretPayload(env, split.secrets);
assert.ok(encrypted);
assert.equal(
  JSON.stringify(encrypted).includes("fixture-bot-secret"),
  false,
  "encrypted record must not contain plaintext Secret"
);

const decrypted = await decryptNotificationSecretPayload(env, {
  ciphertext: encrypted.ciphertext,
  iv: encrypted.iv,
  wrapped_dek: encrypted.wrappedDek,
  wrap_iv: encrypted.wrapIv,
});
assert.deepEqual(decrypted, split.secrets);

const rotatedEnv = {
  NOTIFICATION_KEK: Buffer.alloc(32, 8).toString("base64"),
  NOTIFICATION_KEK_VERSION: "2",
  NOTIFICATION_KEK_PREVIOUS: env.NOTIFICATION_KEK,
  NOTIFICATION_KEK_PREVIOUS_VERSION: "1",
};
const rewrapped = await rewrapNotificationSecretPayload(rotatedEnv, {
  wrapped_dek: encrypted.wrappedDek,
  wrap_iv: encrypted.wrapIv,
  key_version: encrypted.keyVersion,
});
assert.equal(rewrapped.keyVersion, 2);
assert.notEqual(rewrapped.wrappedDek, encrypted.wrappedDek);
const decryptedAfterRotation = await decryptNotificationSecretPayload(
  {
    NOTIFICATION_KEK: rotatedEnv.NOTIFICATION_KEK,
    NOTIFICATION_KEK_VERSION: "2",
  },
  {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    wrapped_dek: rewrapped.wrappedDek,
    wrap_iv: rewrapped.wrapIv,
    key_version: rewrapped.keyVersion,
  }
);
assert.deepEqual(decryptedAfterRotation, split.secrets);

await assert.rejects(
  decryptNotificationSecretPayload(
    {
      NOTIFICATION_KEK: rotatedEnv.NOTIFICATION_KEK,
      NOTIFICATION_KEK_VERSION: "2",
    },
    {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      wrapped_dek: encrypted.wrappedDek,
      wrap_iv: encrypted.wrapIv,
      key_version: 1,
    }
  ),
  NotificationSecretConfigurationError
);

await assert.rejects(
  encryptNotificationSecretPayload(
    { NOTIFICATION_KEK: Buffer.alloc(16, 1).toString("base64") },
    split.secrets
  ),
  NotificationSecretConfigurationError
);
