import * as vscode from "vscode";
import { SubbrainChatModelProvider } from "./provider";

let _provider: SubbrainChatModelProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
  const provider = new SubbrainChatModelProvider(context.secrets);
  _provider = provider;

  // Refresh model list when token is changed externally
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === "subbrain.token") {
        _provider?.fireModelInfoChanged();
      }
    }),
  );

  // Register as a VS Code Copilot Chat language model provider
  const registration = vscode.lm.registerLanguageModelChatProvider(
    "subbrain",
    provider,
  );
  context.subscriptions.push(registration);

  // Command to configure the auth token
  context.subscriptions.push(
    vscode.commands.registerCommand("subbrain.manage", async () => {
      const existing = await context.secrets.get("subbrain.token");
      const token = await vscode.window.showInputBox({
        title: "Subbrain Auth Token",
        prompt: existing
          ? "Update your Subbrain auth token"
          : "Enter your Subbrain auth token (PROXY_AUTH_TOKEN value)",
        ignoreFocusOut: true,
        password: true,
        value: existing ?? "",
        placeHolder: "Enter token...",
      });

      if (token === undefined) return; // user cancelled

      if (!token.trim()) {
        await context.secrets.delete("subbrain.token");
        vscode.window.showInformationMessage("Subbrain: token cleared.");
        _provider?.fireModelInfoChanged();
        return;
      }

      await context.secrets.store("subbrain.token", token.trim());
      vscode.window.showInformationMessage("Subbrain: token saved.");
      _provider?.fireModelInfoChanged();
    }),
  );

  console.log("[Subbrain] Extension activated");
}

export function deactivate() {
  _provider = null;
  console.log("[Subbrain] Extension deactivated");
}
