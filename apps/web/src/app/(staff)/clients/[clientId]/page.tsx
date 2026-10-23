import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HowTo } from '@/components/how-to';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { clientName, type Client } from '@/lib/clients';
import type { CddSummary } from '@/lib/compliance';
import { CLIENT_KIND_LABELS, countryName, formatCalendarDate, formatDate, ORGANISATION_TYPE_LABELS } from '@/lib/format';
import { MATTER_STATUS_LABELS, type MatterSummary } from '@/lib/matters';
import { PortalAccess, type PortalCandidate, type PortalPerson } from './portal-access';
import { ContactVerification, type ContactVerificationRecord } from './contact-verification';
import { CompanyVerification } from './company-verification';
import { ElectronicChecks } from './electronic-checks';
import { ConflictManagement } from './conflict-management';
import { ActivationGatePanel } from './activation-gate';
import { EngagementDocuments } from './engagement-documents';
import { FeeEstimatesAndPayments } from './fee-estimates-and-payments';
import type {
  ActivationException,
  ActivationGate,
  ClientConflictCheck,
  CompanySnapshot,
  ConflictAlias,
  ConflictConnectedPerson,
  ConflictDecision,
  ElectronicCheck,
  EngagementDocument,
  EngagementTemplate,
  MatterFeeEstimate,
  OnboardingPaymentRequest,
} from '@/lib/onboarding';
import { TakeOverForm } from './take-over-form';

export const metadata: Metadata = { title: 'Client' };

export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const { status, body: client } = await apiGet<Client>(`/clients/${encodeURIComponent(clientId)}`);
  if (status === 403) {
    return <NoAccess what="clients" />;
  }
  if (status === 400) {
    notFound();
  }
  if (status === 404 || !client) {
    // The API gives the same answer for a client that does not exist and one
    // the person may not see; so does this page.
    return (
      <>
        <h1>You cannot see this client</h1>
        <p>Either there is no such client, or you are not responsible for it and are on none of its matter teams.</p>
        <hr className="rule" />
        <TakeOverForm clientId={clientId} />
      </>
    );
  }

  const [
    matters,
    cdd,
    contactVerifications,
    electronicChecks,
    chStatus,
    companySnapshots,
    conflictAliases,
    conflictConnectedPersons,
    conflictChecks,
    conflictDecisions,
    activationGate,
    activationExceptions,
    engagementDocs,
    engagementTemplates,
    paymentRequests,
  ] = await Promise.all([
    apiGet<{ matters: MatterSummary[] }>(`/clients/${encodeURIComponent(clientId)}/matters`),
    apiGet<{ cases: CddSummary[]; next: string | null }>(`/clients/${encodeURIComponent(clientId)}/cdd`),
    apiGet<{ verifications: ContactVerificationRecord[] }>(`/clients/${encodeURIComponent(clientId)}/contact-verifications`),
    apiGet<{ checks: ElectronicCheck[] }>(`/clients/${encodeURIComponent(clientId)}/electronic-checks`),
    client.kind === 'organisation'
      ? apiGet<{ configured: boolean }>(`/clients/${encodeURIComponent(clientId)}/companies-house/status`)
      : Promise.resolve({ status: 200, body: { configured: false } }),
    client.kind === 'organisation'
      ? apiGet<{ snapshots: CompanySnapshot[] }>(`/clients/${encodeURIComponent(clientId)}/company-snapshots`)
      : Promise.resolve({ status: 200, body: { snapshots: [] } }),
    apiGet<{ aliases: ConflictAlias[] }>(`/clients/${encodeURIComponent(clientId)}/conflict-aliases`),
    apiGet<{ connectedPersons: ConflictConnectedPerson[] }>(`/clients/${encodeURIComponent(clientId)}/conflict-connected-persons`),
    apiGet<{ checks: ClientConflictCheck[] }>(`/clients/${encodeURIComponent(clientId)}/conflict-checks`),
    apiGet<{ decisions: ConflictDecision[] }>(`/clients/${encodeURIComponent(clientId)}/conflict-decisions`),
    apiGet<ActivationGate>(`/clients/${encodeURIComponent(clientId)}/activation-gate`),
    apiGet<{ exceptions: ActivationException[] }>(`/clients/${encodeURIComponent(clientId)}/activation-exceptions`),
    apiGet<{ documents: EngagementDocument[] }>(`/clients/${encodeURIComponent(clientId)}/engagement-documents`),
    apiGet<{ templates: EngagementTemplate[] }>('/onboarding/engagement-templates'),
    apiGet<{ requests: OnboardingPaymentRequest[] }>(`/clients/${encodeURIComponent(clientId)}/payment-requests`),
  ]);

  const clientMatters = matters.body?.matters ?? [];
  const estimates = clientMatters.length > 0
    ? (await Promise.all(clientMatters.map((m) => apiGet<{ estimates: MatterFeeEstimate[] }>(`/matters/${encodeURIComponent(m.id)}/fee-estimates`))))
        .flatMap((res) => res.body?.estimates ?? [])
    : [];
  // Only for roles that manage portal access; for others the API refuses and the section is left out.
  const portal = await apiGet<{ people: PortalPerson[] }>(`/clients/${encodeURIComponent(clientId)}/portal-access`);
  const portalCandidates: PortalCandidate[] =
    client.kind === 'individual'
      ? [{ contactId: null, name: clientName(client), email: client.email }]
      : client.contacts
          .filter((contact) => contact.active)
          .map((contact) => ({ contactId: contact.id, name: `${contact.givenNames} ${contact.familyName}`, email: contact.email }));
  const rows: [string, string | null][] =
    client.kind === 'individual'
      ? [
          ['Title', client.title],
          ['Given names', client.givenNames],
          ['Family name', client.familyName],
          ['Date of birth', client.dateOfBirth && formatCalendarDate(client.dateOfBirth)],
        ]
      : [
          ['Legal name', client.legalName],
          ['Type of organisation', ORGANISATION_TYPE_LABELS[client.organisationType]],
          ['Registration number', client.registrationNumber],
        ];
  const address = client.address
    ? [client.address.line1, client.address.line2, client.address.town, client.address.postcode, countryName(client.address.country)]
        .filter(Boolean)
        .join(', ')
    : null;

  return (
    <>
      <span className="caption">
        {client.reference} · {CLIENT_KIND_LABELS[client.kind]}
      </span>
      <h1>{clientName(client)}</h1>
      <HowTo>
        <li>Check the details below are right. Select &ldquo;Change details&rdquo; to correct them.</li>
        <li>Complete &ldquo;Identity and due diligence&rdquo; before work starts: matters stay blocked until it is cleared.</li>
        <li>Select &ldquo;Open a matter&rdquo; to start a new piece of work for this client.</li>
        <li>Their existing matters are listed at the bottom.</li>
      </HowTo>
      <div className="actions">
        <Link href={`/clients/${client.id}/edit`}>Change details</Link>
        {client.kind === 'organisation' && <Link href={`/clients/${client.id}/contacts/new`}>Add a contact</Link>}
        <Link href={`/clients/${client.id}/matters/new`}>Open a matter</Link>
      </div>

      <dl className="summary">
        {[...rows, ['Email', client.email], ['Phone', client.phone], ['Address', address], ['Client since', formatDate(client.createdAt)]].map(
          ([label, value]) => (
            <div key={label} className="summary-row">
              <dt>{label}</dt>
              <dd>{value ?? <span className="secondary">Not given</span>}</dd>
            </div>
          ),
        )}
      </dl>

      {client.kind === 'organisation' && (
        <>
          <h2>Contacts</h2>
          {client.contacts.length === 0 ? (
            <p>No contacts yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Job title</th>
                  <th scope="col">Email</th>
                  <th scope="col">Phone</th>
                  <th scope="col">
                    <span className="visually-hidden">Change</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {client.contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      {contact.givenNames} {contact.familyName}
                      {!contact.active && <span className="secondary"> (no longer a contact)</span>}
                    </td>
                    <td>{contact.jobTitle}</td>
                    <td>{contact.email}</td>
                    <td>{contact.phone}</td>
                    <td>
                      <Link href={`/clients/${client.id}/contacts/${contact.id}/edit`}>
                        Change<span className="visually-hidden">
                          {' '}
                          {contact.givenNames} {contact.familyName}
                        </span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {portal.body && <PortalAccess clientId={client.id} people={portal.body.people} candidates={portalCandidates} />}

      {contactVerifications.body && <ContactVerification clientId={client.id}
        records={contactVerifications.body.verifications} candidates={portalCandidates} />}

      {client.kind === 'organisation' && (
        <CompanyVerification
          clientId={client.id}
          defaultCompanyNumber={client.registrationNumber}
          isConfigured={Boolean(chStatus.body?.configured)}
          snapshots={companySnapshots.body?.snapshots ?? []}
        />
      )}

      {electronicChecks.body && (
        <ElectronicChecks
          clientId={client.id}
          checks={electronicChecks.body.checks}
        />
      )}

      {cdd.body && <section aria-labelledby="aml-heading"><h2 id="aml-heading">Identity and due diligence</h2>
        <p>{cdd.body.cases.length ? `Latest case: version ${cdd.body.cases[0]!.version}, ${cdd.body.cases[0]!.status}.` : 'No CDD case has been started.'}</p>
        <p><Link href={`/clients/${client.id}/compliance`}>Open client AML record</Link></p>
      </section>}

      <ConflictManagement
        clientId={client.id}
        aliases={conflictAliases.body?.aliases ?? []}
        connectedPersons={conflictConnectedPersons.body?.connectedPersons ?? []}
        checks={conflictChecks.body?.checks ?? []}
        decisions={conflictDecisions.body?.decisions ?? []}
      />

      <EngagementDocuments
        clientId={client.id}
        clientName={clientName(client)}
        documents={engagementDocs.body?.documents ?? []}
        templates={engagementTemplates.body?.templates ?? []}
        matters={clientMatters}
      />

      <FeeEstimatesAndPayments
        clientId={client.id}
        matters={clientMatters}
        paymentRequests={paymentRequests.body?.requests ?? []}
        feeEstimates={estimates}
      />

      {activationGate.body && (
        <ActivationGatePanel
          clientId={client.id}
          gate={activationGate.body}
          exceptions={activationExceptions.body?.exceptions ?? []}
        />
      )}

      <h2>Matters</h2>
      {matters.status !== 200 || !matters.body || matters.body.matters.length === 0 ? (
        <p>No matters you are on the team of.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {matters.body.matters.map((matter) => (
              <tr key={matter.id}>
                <td>{matter.reference}</td>
                <td>
                  <Link href={`/matters/${matter.id}`}>{matter.title}</Link>
                </td>
                <td>{MATTER_STATUS_LABELS[matter.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
