'use strict';

// Weighted distribution of `totalRaw` base units across holders.
//   holders : [{ owner, balanceRaw }]
//   totalRaw: amount to distribute (string|bigint)
//   opts.capPct  : number|null — cap each person's weight at capPct% of supplyRaw
//                  (null = no cap, pure pro-rata).
//   opts.supplyRaw: total supply (string|bigint) — required when capPct != null.
//   opts.clusters: array of address-groups; each group is ONE person for the cap,
//                  then its reward is split among members pro-rata by member balance.
// Integer math throughout (BigInt). Leftover units are assigned by the
// largest-remainder method so the amounts sum EXACTLY to totalRaw.

const PPB = 1000000000n; // parts per billion
const PPB_PER_PCT = 10000000; // 1% = 1e7 ppb

/**
 * capPct% of supplyRaw, in base units. Never returns 0 for a positive capPct:
 * a cap finer than one base unit is the limit case where every holder is
 * capped to the same value, i.e. an equal split — which is a real answer, and
 * infinitely better than returning nothing at all.
 */
function capToRaw(capPct, supplyRaw) {
  const ppb = BigInt(Math.round(capPct * PPB_PER_PCT));
  if (ppb <= 0n) return 1n;
  const raw = (BigInt(supplyRaw.toString()) * ppb) / PPB;
  return raw > 0n ? raw : 1n;
}

// largest-remainder allocation of `amount` across `parts` weighted by part.w / wTotal
function allocate(amount, parts, wTotal) {
  const res = parts.map((p) => {
    const numer = amount * p.w;
    return { key: p.key, amount: numer / wTotal, rem: numer % wTotal };
  });
  let leftover = amount - res.reduce((s, r) => s + r.amount, 0n);
  // stable sort: bigger remainder first, tie-break by key for determinism
  res.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.key < b.key ? -1 : 1));
  for (let i = 0; i < res.length && leftover > 0n; i++) {
    res[i].amount += 1n;
    leftover -= 1n;
  }
  return res;
}

function computeWeightedAllocations(holders, totalRaw, opts = {}) {
  const total = BigInt(totalRaw.toString());
  if (total <= 0n || !holders || holders.length === 0) return [];

  const { capPct = null, supplyRaw = null, clusters = [] } = opts;

  // owner -> clusterId. Keyed LOWERCASE on both sides: holder addresses arrive
  // EIP-55 checksummed from the explorer while CLUSTERS is hand-written, so a
  // case-sensitive lookup would silently match nothing and turn the whole
  // anti-sybil cap into a no-op. Members keep their original casing — the
  // airdrop sends to them.
  const clusterOf = new Map();
  clusters.forEach((group, i) => {
    for (const addr of group) clusterOf.set(String(addr).toLowerCase(), `c${i}`);
  });

  // Group holders; sum cluster balance, keep members for the internal split.
  const groups = new Map(); // id -> { balance, members: [{owner, balance}] }
  for (const h of holders) {
    const bal = BigInt(h.balanceRaw.toString());
    if (bal <= 0n) continue;
    const key = String(h.owner).toLowerCase();
    const id = clusterOf.get(key) || `solo:${key}`;
    let g = groups.get(id);
    if (!g) { g = { balance: 0n, members: [] }; groups.set(id, g); }
    g.balance += bal;
    g.members.push({ owner: h.owner, balance: bal });
  }
  if (groups.size === 0) return [];

  // Cap in PARTS PER BILLION of supply, not hundredths of a percent. Scaling by
  // 100 made every REWARD_CAP_PCT below 0.005 round to a zero cap, which clamps
  // every weight to zero and silently drops the entire airdrop. 1e7 per percent
  // keeps caps meaningful down to 0.0000001%.
  const capRaw = capPct == null ? null : capToRaw(capPct, supplyRaw);

  // weight per group (balance, clamped to cap)
  let totalWeight = 0n;
  const groupList = [];
  for (const [id, g] of groups) {
    const weight = capRaw == null ? g.balance : g.balance < capRaw ? g.balance : capRaw;
    if (weight <= 0n) continue;
    groupList.push({ id, weight, balance: g.balance, members: g.members });
    totalWeight += weight;
  }
  if (totalWeight === 0n) return [];


  // 1) total -> per group, by capped weight
  const groupReward = allocate(
    total,
    groupList.map((g) => ({ key: g.id, w: g.weight })),
    totalWeight
  );
  const rewardById = new Map(groupReward.map((r) => [r.key, r.amount]));

  // 2) each group's reward -> members, by member balance
  const out = [];
  for (const g of groupList) {
    const amount = rewardById.get(g.id) || 0n;
    if (amount <= 0n) continue;
    if (g.members.length === 1) {
      out.push({ owner: g.members[0].owner, amountRaw: amount.toString() });
      continue;
    }
    const memberReward = allocate(
      amount,
      g.members.map((m) => ({ key: m.owner, w: m.balance })),
      g.balance
    );
    for (const m of memberReward) {
      if (m.amount > 0n) out.push({ owner: m.key, amountRaw: m.amount.toString() });
    }
  }
  // deterministic output order
  out.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  return out;
}

/**
 * Shrink an allocation set so it cannot ask for more than the wallet holds.
 *
 * The disperser is all-or-nothing: one transfer short of the balance reverts
 * the whole batch of 30, so a shortfall of a fraction of a cent silently skips
 * dozens of holders. That happened live — a batch of 5 wanted 0.086173 NVDA
 * against a 0.047679 balance, and those 5 got nothing.
 *
 * Rescaling by largest remainder keeps it proportional and exact: everyone
 * keeps their relative share and the new total equals the balance to the wei.
 * Paying slightly less is strictly better than paying some holders nothing.
 *
 * @returns {{allocations: Array, scaled: boolean, wanted: bigint, balance: bigint}}
 */
function fitAllocationsToBalance(allocations, balanceRaw) {
  const balance = BigInt(balanceRaw);
  const wanted = allocations.reduce((s, a) => s + BigInt(a.amountRaw), 0n);
  if (wanted <= balance) return { allocations, scaled: false, wanted, balance };
  if (balance <= 0n) return { allocations: [], scaled: true, wanted, balance };

  const parts = allocations.map((a) => ({ key: a.owner, w: BigInt(a.amountRaw) }));
  const res = allocate(balance, parts, wanted);
  const byOwner = new Map(res.map((r) => [r.key, r.amount]));
  return {
    allocations: allocations
      .map((a) => ({ ...a, amountRaw: (byOwner.get(a.owner) || 0n).toString() }))
      .filter((a) => BigInt(a.amountRaw) > 0n),
    scaled: true,
    wanted,
    balance,
  };
}

module.exports = { computeWeightedAllocations, capToRaw, fitAllocationsToBalance };
