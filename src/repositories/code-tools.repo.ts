/**
 * CodeToolsRepository — PR B-2 (LAYER-5 follow-up).
 *
 * Thin facade над `CodeToolsTable`. Mirror того, как `MemoryRepository`
 * фасадит `MemoryTable`/`SharedTable`. Существует, чтобы `CodeToolRegistry`
 * (`pipeline/agent-loop/code-tools`) не держал raw SQL — guardrail #6.
 */
import type { Database } from "bun:sqlite";
import { CodeToolsTable } from "../db/tables/code-tools";
import type { CodeTool } from "@subbrain/core/types/code-tool";

export class CodeToolsRepository {
  private readonly table: CodeToolsTable;

  constructor(db: Database) {
    this.table = new CodeToolsTable(db);
  }

  insert = (id: string, name: string, description: string, code: string) =>
    this.table.insert(id, name, description, code);
  get = (id: string): CodeTool | null => this.table.get(id);
  getByName = (name: string): CodeTool | null => this.table.getByName(name);
  list = (includeDisabled = false): CodeTool[] => this.table.list(includeDisabled);
  update = (id: string, description: string, code: string) =>
    this.table.update(id, description, code);
  delete = (name: string): boolean => this.table.delete(name);
  recordSuccess = (name: string) => this.table.recordSuccess(name);
  recordError = (name: string, errorMsg: string) => this.table.recordError(name, errorMsg);
  disable = (name: string) => this.table.disable(name);
}
