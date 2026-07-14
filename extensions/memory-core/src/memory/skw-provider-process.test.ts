// Entry point for the persistent SKW provider process test suite.
import { afterEach, cleanup } from "./skw-provider-process-helpers.js";
import { registerMockTests } from "./skw-provider-process-mock.test.js";
import { registerRealMalformedTests } from "./skw-provider-process-real-malformed.test.js";
import { registerRealOpsTests } from "./skw-provider-process-real-ops.test.js";
import { registerRealResilienceTests } from "./skw-provider-process-real-resilience.test.js";

afterEach(async () => {
  await cleanup();
});

registerRealOpsTests();
registerRealResilienceTests();
registerRealMalformedTests();
registerMockTests();
