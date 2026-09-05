import { TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import client from "./client.js";

// writes a JSON message to a topic and waits for consensus. used for the
// listings topic (a publish IS this write, not a notification of one) and
// the sales topic. returns the sdk-style transaction id ("0.0.x@sec.nanos")
// so callers can look it up on the mirror node afterwards.
export async function submitTopicMessage(topicId: string, payload: unknown) {
  const tx = await new TopicMessageSubmitTransaction({
    topicId,
    message: JSON.stringify(payload),
  }).execute(client);

  await tx.getReceipt(client);
  return tx.transactionId.toString();
}
