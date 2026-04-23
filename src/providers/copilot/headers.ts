export const COPILOT_API_URL = "https://api.githubcopilot.com";

export function buildApiHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": "vscode/1.115.0",
    "Editor-Plugin-Version": "copilot-chat/0.43.0",
  };
}
