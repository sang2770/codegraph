import * as vscode from 'vscode';

const MODEL_SETTING = 'ai.model';

/** Selects the model for extension-owned AI commands, never for ChatParticipant requests. */
export async function selectCodeBrainModel(): Promise<vscode.LanguageModelChat | undefined> {
  const configuredId = vscode.workspace
    .getConfiguration('codebrain')
    .get<string>(MODEL_SETTING, '')
    .trim();
  const models = configuredId
    ? await vscode.lm.selectChatModels({ id: configuredId })
    : await vscode.lm.selectChatModels({});

  if (models.length > 0) {
    return models[0];
  }

  if (configuredId) {
    throw new Error(
      `The configured CodeBrain model '${configuredId}' is unavailable. Clear codebrain.ai.model or update it to an available model id.`,
    );
  }
  return undefined;
}

export async function chooseCodeBrainModel(): Promise<void> {
  const models = await vscode.lm.selectChatModels({});
  if (models.length === 0) {
    void vscode.window.showErrorMessage('No VS Code Language Model is available.');
    return;
  }
  const items = models.map((model) => ({
    label: model.name || model.family || model.id,
    description: `${model.vendor} · ${model.id}`,
    model,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Choose the CodeBrain AI model',
    placeHolder: 'Used by CodeBrain-owned AI commands, not ChatParticipant requests',
  });
  if (!selected) return;
  await vscode.workspace
    .getConfiguration('codebrain')
    .update(MODEL_SETTING, selected.model.id, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    `CodeBrain AI model set to ${selected.model.name || selected.model.id}.`,
  );
}
