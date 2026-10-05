import { messagesOf } from '@/lib/requests';

/**
 * What to show when the API refuses a staff change. A refusal for lack of
 * permission carries no message of its own; one for the person's own account
 * does, and is shown as it is.
 */
export async function staffChangeRefusal(response: Response): Promise<string[]> {
  const messages = await messagesOf(response);
  if (response.status === 403 && messages.every((message) => message === 'Forbidden')) {
    return ['Only administrators can change staff accounts'];
  }
  return messages;
}
