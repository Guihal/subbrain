export interface ModelItem {
  value: string;
  label: string;
  description: string;
}

export type ModelId = string;

export function useChatMode() {
  const { api } = useApi();

  const currentModel = useState<ModelId>("model", () => "teamlead");
  const directMode = useState("direct-mode", () => false);
  const agentMode = useState("agent-mode", () => true);
  const models = useState<ModelItem[]>("models", () => []);

  async function loadModels() {
    try {
      const res = await api<{
        data: Array<{ id: string; label?: string; description?: string }>;
      }>("/v1/models");
      models.value = res.data.map((m) => ({
        value: m.id,
        label: m.label || m.id,
        description: m.description || "",
      }));
    } catch {
      if (models.value.length === 0) {
        models.value = [{ value: "teamlead", label: "Лид", description: "Default" }];
      }
    }
  }

  function buildHeaders(chatId: string): Record<string, string> {
    const headers: Record<string, string> = {
      "X-Session-Id": chatId,
      "X-Chat-Id": chatId,
      "X-Chat-Source": "web",
      Accept: "text/event-stream",
    };
    if (directMode.value) headers["X-Direct-Mode"] = "true";
    return headers;
  }

  return {
    currentModel,
    directMode,
    agentMode,
    models,
    loadModels,
    buildHeaders,
  };
}
