import { Client } from "@elastic/elasticsearch";
import { config } from "./config.js";

export const searchClient = new Client({ node: config.ELASTICSEARCH_URL });

export async function initializeSearch(): Promise<void> {
  const index = config.ELASTICSEARCH_INDEX;
  const exists = await searchClient.indices.exists({ index });
  if (!exists) {
    await searchClient.indices.create({
      index,
      mappings: {
        properties: {
          userId: { type: "keyword" },
          emailId: { type: "keyword" },
          recipient: { type: "text", fields: { keyword: { type: "keyword" } } },
          subject: { type: "text" },
          status: { type: "keyword" },
          scheduledAt: { type: "date" },
          sentAt: { type: "date" },
        },
      },
    });
  }
}

export interface SearchableEmail {
  id: string;
  user_id: string;
  recipient: string;
  subject: string;
  status: string;
  scheduled_at: Date | string;
  sent_at: Date | string | null;
}

export async function indexEmails(emails: SearchableEmail[]): Promise<void> {
  for (let offset = 0; offset < emails.length; offset += 500) {
    const chunk = emails.slice(offset, offset + 500);
    const operations = chunk.flatMap((email) => [
      { index: { _index: config.ELASTICSEARCH_INDEX, _id: email.id } },
      {
        userId: email.user_id,
        emailId: email.id,
        recipient: email.recipient,
        subject: email.subject,
        status: email.status,
        scheduledAt: email.scheduled_at,
        sentAt: email.sent_at,
      },
    ]);
    const result = await searchClient.bulk({ operations, refresh: "wait_for" });
    if (result.errors) {
      const failures = result.items.filter((item) => item.index?.error).length;
      throw new Error(`Elasticsearch failed to index ${failures} email record(s)`);
    }
  }
}

export async function indexEmail(email: SearchableEmail): Promise<void> {
  await indexEmails([email]);
}

export async function searchEmails(userId: string, query: string): Promise<string[]> {
  const result = await searchClient.search<{ emailId: string }>({
    index: config.ELASTICSEARCH_INDEX,
    size: 100,
    query: {
      bool: {
        must: [{ multi_match: { query, fields: ["recipient", "subject"] } }],
        filter: [{ term: { userId } }],
      },
    },
  });
  return result.hits.hits.map((hit) => hit._source?.emailId).filter((id): id is string => Boolean(id));
}
