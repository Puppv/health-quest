// Mirrors HealthQuest/HealthKit/DeterministicHash.swift — plain 64-bit
// FNV-1a via BigInt so client and server pick the same encounter kind from
// the same seed string. JS numbers lose precision above 2^53, hence BigInt
// rather than plain arithmetic.

const FNV_OFFSET_BASIS = 14_695_981_039_346_656_037n;
const FNV_PRIME = 1_099_511_628_211n;
const UINT64_MASK = (1n << 64n) - 1n;

export const DeterministicHash = {
  fnv1a(input) {
    let hash = FNV_OFFSET_BASIS;
    for (const byte of Buffer.from(input, "utf8")) {
      hash ^= BigInt(byte);
      hash = (hash * FNV_PRIME) & UINT64_MASK;
    }
    return hash;
  },
};
