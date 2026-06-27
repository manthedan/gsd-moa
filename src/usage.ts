import type { Usage } from "@earendil-works/pi-ai/compat";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(...items: Array<Usage | undefined>): Usage {
  const total = emptyUsage();
  for (const item of items) {
    if (!item) continue;
    total.input += item.input ?? 0;
    total.output += item.output ?? 0;
    total.cacheRead += item.cacheRead ?? 0;
    total.cacheWrite += item.cacheWrite ?? 0;
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + (item.cacheWrite1h ?? 0);
    total.totalTokens += item.totalTokens ?? 0;
    total.cost.input += item.cost?.input ?? 0;
    total.cost.output += item.cost?.output ?? 0;
    total.cost.cacheRead += item.cost?.cacheRead ?? 0;
    total.cost.cacheWrite += item.cost?.cacheWrite ?? 0;
    total.cost.total += item.cost?.total ?? 0;
  }
  if (!total.cacheWrite1h) delete total.cacheWrite1h;
  return total;
}
