import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";

export function renderChatPanePlacement(props: {
  session: GatewaySessionRow | undefined;
  placementReclaimDisabledReason?: string;
  onPlacementReclaim?: () => void;
}): TemplateResult | typeof nothing {
  const placementState = props.session?.placement?.state;
  if (!isCloudWorkerPlacementState(placementState)) {
    return nothing;
  }
  const label = t("newSession.runsOn", { place: t("newSession.cloud") });
  const disabledReason = props.placementReclaimDisabledReason;
  const age = formatRelativeTimestamp(props.session?.placement?.stateChangedAtMs, {
    fallback: "",
  });
  return html`
    <wa-dropdown class="chat-pane__placement-menu" placement="bottom-start">
      <button slot="trigger" class="chat-pane__placement-chip" type="button">${label}</button>
      <div class="chat-pane__placement-state">${placementState}${age ? ` · ${age}` : ""}</div>
      <wa-dropdown-item
        class="chat-pane__placement-reclaim"
        ?disabled=${Boolean(disabledReason)}
        title=${disabledReason ?? nothing}
        @click=${() => !disabledReason && props.onPlacementReclaim?.()}
      >
        ${t("sessionsView.stopCloudWorker")}
      </wa-dropdown-item>
    </wa-dropdown>
  `;
}
