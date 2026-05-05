import { describe, expect, test } from "bun:test";
import { applyEdgeWalkBoost } from "../packages/agent/src/rag/pipeline/boosts";
import type { RAGResult } from "../packages/agent/src/rag/types";
import type { MemoryDB } from "../packages/core/src/db";

type Neighbour = { id: string; layer: string; kind: string; weight: number };

function makeMemoryDB(relations: Map<string, Neighbour[]>): MemoryDB {
  return {
    getRelated: (id: string, layer: string) => {
      const key = `${layer}:${id}`;
      return relations.get(key) ?? [];
    },
  } as unknown as MemoryDB;
}

function makeResult(
  p: Partial<RAGResult> & { id: string; layer: string; score: number },
): RAGResult {
  return {
    title: "t",
    snippet: "s",
    ...p,
  };
}

// Default salience = 0.5 → factor = 1 + 0.1*0.5 = 1.05
const SALIENCE_DEFAULT = 1.05;

describe("applyEdgeWalkBoost", () => {
  test("empty results pass through", () => {
    const mem = makeMemoryDB(new Map());
    expect(applyEdgeWalkBoost([], mem)).toEqual([]);
  });

  test("no edges → salience-only boost", () => {
    const mem = makeMemoryDB(new Map());
    const results = [makeResult({ id: "a", layer: "context", score: 100 })];
    const out = applyEdgeWalkBoost(results, mem);
    expect(out[0].score).toBeCloseTo(100 * SALIENCE_DEFAULT, 5);
  });

  test("1-hop reachable row gets max(salience, edge) = 1.08x", () => {
    const rels = new Map<string, Neighbour[]>([
      ["context:a", [{ id: "b", layer: "context", kind: "related", weight: 1 }]],
    ]);
    const mem = makeMemoryDB(rels);
    const results = [
      makeResult({ id: "a", layer: "context", score: 100 }),
      makeResult({ id: "b", layer: "context", score: 100 }),
    ];
    const out = applyEdgeWalkBoost(results, mem);
    const a = out.find((r) => r.id === "a")!;
    const b = out.find((r) => r.id === "b")!;
    expect(a.score).toBeCloseTo(100 * SALIENCE_DEFAULT, 5);
    expect(b.score).toBeCloseTo(100 * 1.08, 5);
  });

  test("non-stacking: persona 1.10 > edge 1.08 → persona wins", () => {
    const rels = new Map<string, Neighbour[]>([
      ["shared:a", [{ id: "b", layer: "shared", kind: "related", weight: 1 }]],
    ]);
    const mem = makeMemoryDB(rels);
    const results = [
      makeResult({ id: "a", layer: "shared", kind: "persona", score: 100 }),
      makeResult({ id: "b", layer: "shared", kind: "persona", score: 100 }),
    ];
    const out = applyEdgeWalkBoost(results, mem);
    const b = out.find((r) => r.id === "b")!;
    expect(b.score).toBeCloseTo(110, 5);
  });

  test("non-stacking: salience 1.05 < edge 1.08 → edge wins", () => {
    const rels = new Map<string, Neighbour[]>([
      ["context:a", [{ id: "b", layer: "context", kind: "related", weight: 1 }]],
    ]);
    const mem = makeMemoryDB(rels);
    const results = [
      makeResult({ id: "a", layer: "context", salience: 0.5, score: 100 }),
      makeResult({ id: "b", layer: "context", salience: 0.5, score: 100 }),
    ];
    const out = applyEdgeWalkBoost(results, mem);
    const b = out.find((r) => r.id === "b")!;
    expect(b.score).toBeCloseTo(108, 5);
  });

  test("combined ceiling ≤ 1.10x (persona is max)", () => {
    const rels = new Map<string, Neighbour[]>([
      ["shared:a", [{ id: "b", layer: "shared", kind: "related", weight: 1 }]],
    ]);
    const mem = makeMemoryDB(rels);
    const results = [
      makeResult({ id: "a", layer: "shared", kind: "persona", salience: 1.0, score: 100 }),
      makeResult({ id: "b", layer: "shared", kind: "persona", salience: 1.0, score: 100 }),
    ];
    const out = applyEdgeWalkBoost(results, mem);
    const b = out.find((r) => r.id === "b")!;
    expect(b.score).toBeCloseTo(110, 5);
  });

  test("re-sort after boost", () => {
    const rels = new Map<string, Neighbour[]>([
      ["context:a", [{ id: "b", layer: "context", kind: "related", weight: 1 }]],
    ]);
    const mem = makeMemoryDB(rels);
    const results = [
      makeResult({ id: "a", layer: "context", score: 105 }),
      makeResult({ id: "b", layer: "context", score: 100 }),
    ];
    const out = applyEdgeWalkBoost(results, mem);
    // a → 105 * 1.05 = 110.25; b → 100 * 1.08 = 108 → a still first
    expect(out[0].id).toBe("a");
    expect(out[1].id).toBe("b");
  });

  test("re-sort where edge overtakes", () => {
    const rels = new Map<string, Neighbour[]>([
      ["context:a", [{ id: "b", layer: "context", kind: "related", weight: 1 }]],
    ]);
    const mem = makeMemoryDB(rels);
    const results = [
      makeResult({ id: "a", layer: "context", score: 102 }),
      makeResult({ id: "b", layer: "context", score: 100 }),
    ];
    const out = applyEdgeWalkBoost(results, mem);
    // a → 102 * 1.05 = 107.1; b → 100 * 1.08 = 108 → b first
    expect(out[0].id).toBe("b");
    expect(out[1].id).toBe("a");
  });

  test("layer mismatch → no boost (edge targets different layer)", () => {
    const rels = new Map<string, Neighbour[]>([
      ["context:a", [{ id: "b", layer: "archive", kind: "related", weight: 1 }]],
    ]);
    const mem = makeMemoryDB(rels);
    const results = [
      makeResult({ id: "a", layer: "context", score: 100 }),
      makeResult({ id: "b", layer: "context", score: 100 }),
    ];
    const out = applyEdgeWalkBoost(results, mem);
    const b = out.find((r) => r.id === "b")!;
    // b is context layer, edge points to archive:b → no match → salience only
    expect(b.score).toBeCloseTo(100 * SALIENCE_DEFAULT, 5);
  });

  test("bidirectional edges both expand", () => {
    const rels = new Map<string, Neighbour[]>([
      ["context:a", [{ id: "b", layer: "context", kind: "related", weight: 1 }]],
      ["context:b", [{ id: "c", layer: "context", kind: "related", weight: 1 }]],
    ]);
    const mem = makeMemoryDB(rels);
    const results = [
      makeResult({ id: "a", layer: "context", score: 100 }),
      makeResult({ id: "b", layer: "context", score: 100 }),
      makeResult({ id: "c", layer: "context", score: 100 }),
    ];
    const out = applyEdgeWalkBoost(results, mem);
    const scores = Object.fromEntries(out.map((r) => [r.id, r.score]));
    // a not reachable from any seed (b→c, no b→a)
    expect(scores["a"]).toBeCloseTo(100 * SALIENCE_DEFAULT, 5);
    // b reachable from a
    expect(scores["b"]).toBeCloseTo(108, 5);
    // c reachable from b
    expect(scores["c"]).toBeCloseTo(108, 5);
  });
});
