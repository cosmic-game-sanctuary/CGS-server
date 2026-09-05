// run once: tsx scripts/create-hcs-topics.ts
// creates the three public topics and prints the ids to paste into .env.
// no submit key on any of them — these are public append-only feeds, and
// anyone (including the wishlist agent) should be able to verify them without
// asking us for permission.

import { TopicCreateTransaction } from "@hiero-ledger/sdk";
import client from "../src/services/hedera/client.js";

async function createTopic(memo: string) {
  const receipt = await (
    await new TopicCreateTransaction().setTopicMemo(memo).execute(client)
  ).getReceipt(client);

  if (!receipt.topicId) throw new Error(`topic creation for "${memo}" returned no id`);
  return receipt.topicId.toString();
}

const listings = await createTopic("cgs.listings.v1");
const sales = await createTopic("cgs.sales.v1");
const agentIdentity = await createTopic("cgs.agent-identity.v1");

console.log("\nAdd these to .env:\n");
console.log(`HCS_LISTINGS_TOPIC=${listings}`);
console.log(`HCS_SALES_TOPIC=${sales}`);
console.log(`HCS_AGENT_IDENTITY_TOPIC=${agentIdentity}`);
console.log();

client.close();
