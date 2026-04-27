import type { MemoryRow } from "../useMemory";

export type FocusPatch = { key: string; value: string };
export type SharedPatch = {
  id: string;
  patch: { category: string; content: string; tags: string };
};
export type ContextPatch = {
  id: string;
  patch: { title: string; content: string; tags: string };
};
// M-12 (mig 15): confidence unified to REAL [0..1] | null.
export type ArchivePatch = {
  id: string;
  patch: {
    title: string;
    content: string;
    tags: string;
    confidence: number | null;
  };
};
export type AgentPatch = { id: string; patch: { content: string; tags: string } };

export type EditorPatch =
  | { kind: "focus"; data: FocusPatch }
  | { kind: "shared"; data: SharedPatch }
  | { kind: "context"; data: ContextPatch }
  | { kind: "archive"; data: ArchivePatch }
  | { kind: "agent"; data: AgentPatch }
  | { kind: "log" };

export type EditorFields = {
  value: string;
  category: string;
  title: string;
  content: string;
  tags: string;
  confidence: number | null;
};

export function resetFrom(fields: EditorFields, row: MemoryRow): void {
  fields.value = "";
  fields.category = "";
  fields.title = "";
  fields.content = "";
  fields.tags = "";
  fields.confidence = null;
  switch (row.__kind) {
    case "focus":
      fields.value = row.value;
      break;
    case "shared":
      fields.category = row.category;
      fields.content = row.content;
      fields.tags = row.tags;
      break;
    case "context":
      fields.title = row.title;
      fields.content = row.content;
      fields.tags = row.tags;
      break;
    case "archive":
      fields.title = row.title;
      fields.content = row.content;
      fields.tags = row.tags;
      fields.confidence = row.confidence;
      break;
    case "agent":
      fields.content = row.content;
      fields.tags = row.tags;
      break;
    case "log":
      /* view-only */
      break;
  }
}

export function buildPatch(fields: EditorFields, row: MemoryRow): EditorPatch {
  switch (row.__kind) {
    case "focus":
      return { kind: "focus", data: { key: row.key, value: fields.value } };
    case "shared":
      return {
        kind: "shared",
        data: {
          id: row.id,
          patch: {
            category: fields.category,
            content: fields.content,
            tags: fields.tags,
          },
        },
      };
    case "context":
      return {
        kind: "context",
        data: {
          id: row.id,
          patch: {
            title: fields.title,
            content: fields.content,
            tags: fields.tags,
          },
        },
      };
    case "archive":
      return {
        kind: "archive",
        data: {
          id: row.id,
          patch: {
            title: fields.title,
            content: fields.content,
            tags: fields.tags,
            confidence: fields.confidence,
          },
        },
      };
    case "agent":
      return {
        kind: "agent",
        data: {
          id: row.id,
          patch: { content: fields.content, tags: fields.tags },
        },
      };
    case "log":
      return { kind: "log" };
  }
}
