import type { ReplyPayload } from "../reply-payload.js";
import { resolvePendingFinalDeliveryCompletion } from "./pending-final-delivery.js";

export function resolvePendingFinalDeliverySendParams(
  payloads: readonly ReplyPayload[] | undefined,
) {
  const deliveryCompletion = resolvePendingFinalDeliveryCompletion(payloads);
  return deliveryCompletion
    ? {
        deliveryCompletion,
        deliveryIntentId: deliveryCompletion.deliveryId,
        durability: "required" as const,
      }
    : {};
}
