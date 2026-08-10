// Control UI helper reveals a one-time secret in-app. window.prompt cannot do this job:
// it is unstyled, unlabeled, uncopyable on touch, and never renders at all in a webview
// without a dialog bridge, which drops the only copy of a freshly issued credential.
import { html, nothing, render } from "lit";
import { t } from "../i18n/index.ts";
import { renderCopyButton } from "./copy-button.ts";
import "./modal-dialog.ts";

type SecretRevealDialogOptions = {
  title: string;
  message: string;
  /** Omitted when the operation issued no secret to this operator; the dialog then
   *  reports the outcome only, and dismissal gestures behave normally. */
  secret?: string;
  acknowledgeLabel: string;
  /** Only reachable with a secret, because only then is dismissal refused. */
  dismissHint?: string;
};

/**
 * Resolves on the explicit acknowledgement. With a secret, Escape and backdrop cannot
 * settle it; without one there is nothing to lose, so they close it like any dialog.
 */
export function showSecretRevealDialog(options: SecretRevealDialogOptions): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve) => {
    let dismissRefused = false;
    const acknowledge = () => {
      render(nothing, host);
      host.remove();
      resolve();
    };
    // The secret is shown once, so a stray Escape or backdrop click must not be the last
    // thing that happens to it. Web Awesome pulses the refused dialog; the hint is the
    // accessible half of that answer, because a silent no-op reads as a broken control.
    // An outcome-only dialog holds nothing recoverable, so it dismisses normally.
    const handleCancel = (event: Event) => {
      if (!options.secret) {
        acknowledge();
        return;
      }
      event.preventDefault();
      if (dismissRefused) {
        return;
      }
      dismissRefused = true;
      paint();
    };
    const paint = () => {
      render(
        html`
          <openclaw-modal-dialog
            label=${options.title}
            description=${options.message}
            @modal-cancel=${handleCancel}
          >
            <div class="exec-approval-card">
              <div class="exec-approval-header">
                <div>
                  <div class="exec-approval-title">${options.title}</div>
                  <div class="exec-approval-sub">${options.message}</div>
                </div>
              </div>
              ${options.secret
                ? html`
                    <div class="secret-reveal__value">
                      <code class="secret-reveal__code">${options.secret}</code>
                      ${renderCopyButton(options.secret, t("common.copy"))}
                    </div>
                  `
                : nothing}
              ${dismissRefused
                ? html`<p class="secret-reveal__hint" role="status">${options.dismissHint}</p>`
                : nothing}
              <div class="exec-approval-actions">
                <button type="button" class="btn primary" autofocus @click=${acknowledge}>
                  ${options.acknowledgeLabel}
                </button>
              </div>
            </div>
          </openclaw-modal-dialog>
        `,
        host,
      );
    };
    paint();
  });
}
