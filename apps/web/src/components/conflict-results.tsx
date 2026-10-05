import { RELATION_LABELS, type ConflictCheck } from '@/lib/matters';

/**
 * What a conflict check found: the names checked and each possible match, by
 * reference only. A possible match is for a person to judge; it is not a
 * finding that there is a conflict.
 */
export function ConflictResults({ check }: { check: ConflictCheck }) {
  return (
    <>
      <p>Names checked: {check.names.join('; ')}.</p>
      {check.matchCount === 0 ? (
        <p>No possible conflicts were found.</p>
      ) : (
        <table className="table">
          <caption>
            {check.matchCount > check.matches.length
              ? `${check.matchCount} possible conflicts; the ${check.matches.length} closest are shown`
              : `${check.matchCount} possible ${check.matchCount === 1 ? 'conflict' : 'conflicts'}`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Name checked</th>
              <th scope="col">Similar name</th>
              <th scope="col">Known as</th>
              <th scope="col">Client</th>
              <th scope="col">Matter</th>
            </tr>
          </thead>
          <tbody>
            {check.matches.map((match, index) => (
              <tr key={index}>
                <td>{match.checkedName}</td>
                <td>{match.matchedName}</td>
                <td>{RELATION_LABELS[match.relation]}</td>
                <td>{match.clientReference}</td>
                <td>{match.matterReference ?? <span className="secondary">None</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
