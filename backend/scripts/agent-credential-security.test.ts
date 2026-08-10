import assert from "node:assert/strict";
import {
  AgentCredentialConfigurationError,
  digestAgentToken,
  generateAgentCredentialToken,
} from "../src/modules/agents/persistence/D1AgentCredentialStore";

const env = { AGENT_TOKEN_PEPPER: "fixture-agent-pepper-with-at-least-32-chars" };
const token = generateAgentCredentialToken();
assert.match(token, /^xga_[0-9a-f]{64}$/);

const first = await digestAgentToken(env, token);
const second = await digestAgentToken(env, token);
const withOtherPepper = await digestAgentToken(
  { AGENT_TOKEN_PEPPER: "another-fixture-pepper-with-at-least-32-chars" },
  token
);

assert.match(first, /^[0-9a-f]{64}$/);
assert.equal(first, second, "same Token and pepper must produce a stable digest");
assert.notEqual(first, withOtherPepper, "pepper must affect the digest");
assert.equal(first.includes(token), false, "digest must not contain plaintext Token");

await assert.rejects(
  digestAgentToken({ AGENT_TOKEN_PEPPER: "short" }, token),
  AgentCredentialConfigurationError
);
