'use client';

import { useEffect, useRef } from 'react';

/**
 * A problem with what was submitted, shown above the form. It takes focus when
 * it appears, so screen-reader and keyboard users hear it at once.
 */
export function ErrorSummary({ messages }: { messages: string[] }) {
  const summary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    summary.current?.focus();
  }, [messages]);

  return (
    <div className="error-summary" role="alert" tabIndex={-1} ref={summary} aria-labelledby="error-summary-title">
      <h2 id="error-summary-title">There is a problem</h2>
      {messages.length === 1 ? (
        <p>{messages[0]}</p>
      ) : (
        <ul>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
