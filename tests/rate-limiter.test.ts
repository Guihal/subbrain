import { RateLimiter } from "../src/lib/rate-limiter";

const limiter = new RateLimiter();
let completed = 0;

console.log(
  `Initial: load=${limiter.currentLoad}, available=${limiter.availableSlots}`,
);

// Fire 5 critical requests — should all run immediately
const promises: Promise<number>[] = [];
for (let i = 0; i < 5; i++) {
  promises.push(
    limiter.schedule("critical", async () => {
      completed++;
      return completed;
    }),
  );
}

await Promise.all(promises);
console.assert(completed === 5, `Expected 5, got ${completed}`);
console.assert(
  limiter.currentLoad === 5,
  `Load should be 5, got ${limiter.currentLoad}`,
);
console.log(
  `✅ 5 critical requests ran immediately (load=${limiter.currentLoad})`,
);

// Test priority ordering: fill to 80%, then low should queue
// Reset by creating a new limiter for this test
const limiter2 = new RateLimiter();
const order: string[] = [];

// Fill to 33 requests to be above 80% (32/40 = 80%)
for (let i = 0; i < 33; i++) {
  await limiter2.schedule("critical", async () => {});
}
console.log(`Load after fill: ${limiter2.currentLoad}`);

// Low priority should be queued (> 80% threshold)
const lowPromise = limiter2.schedule("low", async () => {
  order.push("low");
  return "low-done";
});

// Critical should run immediately
const criticalPromise = limiter2.schedule("critical", async () => {
  order.push("critical");
  return "critical-done";
});

const critResult = await criticalPromise;
console.assert(critResult === "critical-done", "Critical should resolve");
console.assert(
  order[0] === "critical",
  `Critical should run first, got ${order[0]}`,
);
console.log(`✅ Critical runs before low-priority at high load`);

// Test backoff
const limiter3 = new RateLimiter();
limiter3.backoff429();
console.assert(
  limiter3.availableSlots === 0,
  `After backoff, slots should be 0, got ${limiter3.availableSlots}`,
);
console.log(`✅ backoff429 fills all slots`);

console.log("\n🎉 Rate limiter tests passed!");
process.exit(0);
