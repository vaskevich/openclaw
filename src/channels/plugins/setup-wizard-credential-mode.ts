import { resolveSecretInputModeForEnvSelection } from "../../plugins/provider-auth-mode.js";
import type { SecretInputMode } from "../../plugins/provider-auth-types.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

export async function resolveSharedChannelCredentialInputMode(params: {
  prompter: Pick<WizardPrompter, "select">;
  credentialLabel: string;
}): Promise<SecretInputMode> {
  return await resolveSecretInputModeForEnvSelection({
    prompter: params.prompter,
    copy: {
      modeMessage: `How do you want to provide this ${params.credentialLabel}?`,
      plaintextLabel: `Enter ${params.credentialLabel}`,
      plaintextHint: "Stores the credential directly in OpenClaw config",
      refLabel: "Use external secret provider",
      refHint: "Stores a reference to env or configured external secret providers",
    },
  });
}
