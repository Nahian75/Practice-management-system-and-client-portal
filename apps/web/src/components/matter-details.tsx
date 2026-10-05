import Link from 'next/link';
import { formatDate } from '@/lib/format';
import { MATTER_TYPE_LABELS, PARTY_ROLE_LABELS, TEAM_ROLE_LABELS, type Matter } from '@/lib/matters';

/** A matter's details, team and other parties, read-only. */
export function MatterDetails({ matter, linkClient = true }: { matter: Matter; linkClient?: boolean }) {
  const client = `${matter.client.name} (${matter.client.reference})`;
  return (
    <>
      <dl className="summary">
        {(
          [
            ['Client', linkClient ? <Link key="client" href={`/clients/${matter.client.id}`}>{client}</Link> : client],
            ['Type of work', MATTER_TYPE_LABELS[matter.matterType]],
            ['Opened', formatDate(matter.openedAt)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="summary-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <h2>Team</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
          </tr>
        </thead>
        <tbody>
          {matter.team.map((member) => (
            <tr key={member.accountId}>
              <td>{member.displayName}</td>
              <td>{TEAM_ROLE_LABELS[member.role]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Other parties</h2>
      {matter.parties.length === 0 ? (
        <p>None.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Person or organisation</th>
            </tr>
          </thead>
          <tbody>
            {matter.parties.map((party) => (
              <tr key={party.id}>
                <td>{party.name}</td>
                <td>{PARTY_ROLE_LABELS[party.role]}</td>
                <td>{party.kind === 'individual' ? 'Person' : 'Organisation'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
