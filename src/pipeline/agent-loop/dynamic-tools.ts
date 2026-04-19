/**
 * Dynamic Tool Registry — runtime-created tools that agents can define
 * and reuse across sessions. Persisted to agent_memory.
 */
import type { Tool } from "../../providers/types";
import { MAX_DYNAMIC_TOOLS } from "./types";

export interface DynamicToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  model: string;
  promptTemplate: string;
  createdAt: string;
}

const RESERVED_NAMES = new Set([
  "memory_search",
  "memory_write",
  "rag_search",
  "think",
  "done",
  "consult_specialists",
  "create_tool",
  "list_tools",
]);

export class DynamicToolRegistry {
  private tools = new Map<string, DynamicToolDef>();

  register(def: DynamicToolDef): { success: boolean; error?: string } {
    if (RESERVED_NAMES.has(def.name)) {
      return { success: false, error: `"${def.name}" is a reserved tool name` };
    }
    if (!def.name.match(/^[a-z][a-z0-9_]{1,48}$/)) {
      return {
        success: false,
        error: "Tool name must match /^[a-z][a-z0-9_]{1,48}$/",
      };
    }
    if (this.tools.size >= MAX_DYNAMIC_TOOLS && !this.tools.has(def.name)) {
      return {
        success: false,
        error: `Max ${MAX_DYNAMIC_TOOLS} dynamic tools reached. Delete one first.`,
      };
    }
    this.tools.set(def.name, def);
    return { success: true };
  }

  get(name: string): DynamicToolDef | undefined {
    return this.tools.get(name);
  }

  list(): DynamicToolDef[] {
    return [...this.tools.values()];
  }

  delete(name: string): boolean {
    return this.tools.delete(name);
  }

  toToolDefs(): Tool[] {
    return this.list().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: `[Dynamic] ${t.description}`,
        parameters: t.parameters,
      },
    }));
  }

  serialize(): DynamicToolDef[] {
    return this.list();
  }

  load(defs: DynamicToolDef[]): void {
    for (const d of defs) {
      if (!RESERVED_NAMES.has(d.name)) {
        this.tools.set(d.name, d);
      }
    }
  }
}
