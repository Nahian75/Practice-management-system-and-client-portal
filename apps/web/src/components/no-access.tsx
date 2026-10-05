/** Shown when the API refuses (403): the person's roles do not allow this. */
export function NoAccess({ what }: { what: string }) {
  return (
    <>
      <h1>No access</h1>
      <p>Your role does not give you access to {what}. If you need it, ask an administrator.</p>
    </>
  );
}
