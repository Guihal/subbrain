import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-freelance-leads.db";

let db: MemoryDB;

beforeAll(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new MemoryDB(TEST_DB);
});

afterAll(() => {
  db.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("FreelanceLeadsTable", () => {
  test("insert + getById + existsByUrl", () => {
    db.insertFreelanceLead({
      id: "l1",
      url: "https://fl.ru/projects/1",
      source: "fl.ru",
      title: "Test",
      budget: 5000,
      score: 8,
      reason: "easy",
    });
    const row = db.getFreelanceLead("l1");
    expect(row).not.toBeNull();
    expect(row?.status).toBe("new");
    expect(row?.budget).toBe(5000);
    expect(db.existsFreelanceByUrl("https://fl.ru/projects/1")).toBe(true);
    expect(db.existsFreelanceByUrl("https://fl.ru/projects/999")).toBe(false);
  });

  test("unique url constraint", () => {
    expect(() =>
      db.insertFreelanceLead({
        id: "l2",
        url: "https://fl.ru/projects/1",
        source: "fl.ru",
        title: "Dup",
        budget: null,
        score: null,
        reason: null,
      }),
    ).toThrow();
  });

  test("list pagination + status filter", () => {
    for (let i = 0; i < 5; i++) {
      db.insertFreelanceLead({
        id: `lp${i}`,
        url: `https://fl.ru/projects/${100 + i}`,
        source: "fl.ru",
        title: `P${i}`,
        budget: 1000 + i,
        score: 5 + i,
        reason: null,
      });
    }
    const page1 = db.listFreelanceLeads({ limit: 3, offset: 0 });
    expect(page1.items.length).toBe(3);
    expect(page1.total).toBeGreaterThanOrEqual(6);
    const onlyNew = db.listFreelanceLeads({
      status: "new",
      limit: 100,
      offset: 0,
    });
    expect(onlyNew.items.every((i) => i.status === "new")).toBe(true);
  });

  test("updateStatus", () => {
    db.updateFreelanceStatus("l1", "taken");
    const row = db.getFreelanceLead("l1");
    expect(row?.status).toBe("taken");
    const taken = db.listFreelanceLeads({
      status: "taken",
      limit: 10,
      offset: 0,
    });
    expect(taken.items.length).toBe(1);
    expect(taken.items[0]?.id).toBe("l1");
  });

  test("chats.kind default main", () => {
    db.createChat("c1", "test", "teamlead", "web");
    const chat = db.getChat("c1");
    expect(chat?.kind).toBe("main");
  });
});
