import assert from "node:assert/strict";

import { parseNetworkMetrics } from "../src/utils/metrics";

const interfaces = [
  {
    interface: "eth0",
    bytes_sent: 50,
    bytes_recv: 100,
    packets_sent: 5,
    packets_recv: 10,
  },
];

assert.deepEqual(
  parseNetworkMetrics({ network_metrics: JSON.stringify(interfaces) }),
  interfaces,
  "management JSON strings are decoded"
);
assert.deepEqual(
  parseNetworkMetrics({ network_metrics: interfaces } as never),
  interfaces,
  "public DTO arrays are consumed without a second JSON.parse"
);
assert.deepEqual(
  parseNetworkMetrics({ network_metrics: "[object Object]" }),
  [],
  "malformed network data is ignored"
);
