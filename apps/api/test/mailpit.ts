const MAILPIT_URL = process.env['TEST_MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
const POLL_INTERVAL_MS = 50;
const WAIT_MS = 5_000;

export interface ReceivedEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

interface SearchResult {
  messages: { ID: string }[];
}

interface MessageDetail {
  From: { Address: string };
  To: { Address: string }[];
  Subject: string;
  Text: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_URL}${path}`);
  if (!response.ok) {
    throw new Error(`Mailpit ${path} returned ${response.status}. Is it running? (docker compose up -d)`);
  }
  return (await response.json()) as T;
}

/** Every email Mailpit has caught for the address, oldest first. */
export async function inbox(address: string): Promise<ReceivedEmail[]> {
  const { messages } = await getJson<SearchResult>(`/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  const details = await Promise.all(messages.map((m) => getJson<MessageDetail>(`/api/v1/message/${m.ID}`)));
  return details.reverse().map((d) => ({
    from: d.From.Address,
    to: d.To.map((t) => t.Address),
    subject: d.Subject,
    text: d.Text,
  }));
}

/** Waits for the number of emails to the address to reach `count`. */
export async function waitForEmails(address: string, count = 1): Promise<ReceivedEmail[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const emails = await inbox(address);
    if (emails.length >= count || Date.now() > deadline) {
      return emails;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
