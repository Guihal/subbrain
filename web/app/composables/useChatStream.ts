// Re-export shim for Nuxt auto-import: default scan only picks top-level
// `composables/*.ts`. Composable was split into `useChatStream/` folder
// (W1-1) — this shim keeps `useChatStream()` callable from pages without
// explicit import.

export type { ChatStreamDeps } from "./useChatStream/index";
export { useChatStream } from "./useChatStream/index";
