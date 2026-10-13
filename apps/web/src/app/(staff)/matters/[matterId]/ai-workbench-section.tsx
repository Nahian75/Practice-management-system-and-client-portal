'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DocumentSummary } from '@/lib/documents';
import type { AiDraftSummary, AiDraftDetail, MatterAiMetrics } from '@/lib/ai';
import { postJson, messagesOf } from '@/lib/requests';

interface AiWorkbenchSectionProps {
  matterId: string;
  documents?: DocumentSummary[];
  initialDrafts?: AiDraftSummary[];
  metrics?: MatterAiMetrics;
  canUseAi: boolean;
}

type TabType = 'generate' | 'review' | 'metrics';
type GeneratorAction = 'summarise' | 'chronology' | 'correspondence' | 'attendance';

export function AiWorkbenchSection({
  matterId,
  documents = [],
  initialDrafts = [],
  metrics,
  canUseAi,
}: AiWorkbenchSectionProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabType>('generate');
  const [action, setAction] = useState<GeneratorAction>('summarise');

  // Generator inputs
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [rawNotes, setRawNotes] = useState('');
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateErrors, setGenerateErrors] = useState<string[] | undefined>();

  // Review state
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(
    initialDrafts.length > 0 ? initialDrafts[0]?.id ?? null : null,
  );
  const [activeDraftDetail, setActiveDraftDetail] = useState<AiDraftDetail | null>(null);
  const [isLoadingDraft, setIsLoadingDraft] = useState(false);
  const [draftsList, setDraftsList] = useState<AiDraftSummary[]>(initialDrafts);

  // Review submission inputs
  const [editedText, setEditedText] = useState('');
  const [feedbackReason, setFeedbackReason] = useState('');
  const [promoteToDoc, setPromoteToDoc] = useState(false);
  const [promoteToDocTitle, setPromoteToDocTitle] = useState('');
  const [promoteToTask, setPromoteToTask] = useState(false);
  const [promoteToTaskTitle, setPromoteToTaskTitle] = useState('');
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [reviewErrors, setReviewErrors] = useState<string[] | undefined>();

  if (!canUseAi) {
    return null;
  }

  const handleDocToggle = (docId: string) => {
    setSelectedDocIds((prev) =>
      prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId],
    );
  };

  const loadDraftDetails = async (draftId: string) => {
    setIsLoadingDraft(true);
    setReviewErrors(undefined);
    try {
      const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/ai/drafts/${encodeURIComponent(draftId)}`);
      if (res.ok) {
        const detail = (await res.json()) as AiDraftDetail;
        setActiveDraftDetail(detail);
        setEditedText(detail.review?.finalText || detail.generatedText);
        setPromoteToDocTitle(detail.title);
        setPromoteToTaskTitle(`Follow up: ${detail.title}`);
        setSelectedDraftId(draftId);
      } else {
        setReviewErrors(await messagesOf(res));
      }
    } catch {
      setReviewErrors(['Failed to load draft details. Please try again.']);
    } finally {
      setIsLoadingDraft(false);
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGenerating(true);
    setGenerateErrors(undefined);

    const contextDocs = documents
      .filter((d) => selectedDocIds.includes(d.id))
      .map((d) => ({
        id: d.id,
        title: d.title,
        content: `Document: ${d.title}. Referenced evidence file.`,
      }));

    let path: `/api/${string}` = `/api/matters/${encodeURIComponent(matterId)}/ai/generate`;
    let body: Record<string, unknown> = {};

    if (action === 'summarise') {
      path = `/api/matters/${encodeURIComponent(matterId)}/ai/summarise-document`;
      body = {
        title: title || 'Document Summary',
        instruction: instruction || 'Extract key obligations, dates, counterparties and risks.',
        contextDocuments: contextDocs,
      };
    } else if (action === 'chronology') {
      path = `/api/matters/${encodeURIComponent(matterId)}/ai/extract-chronology`;
      body = {
        title: title || 'Matter Event Chronology',
        instruction: instruction || 'Extract chronological timeline of all relevant events with dates.',
        contextDocuments: contextDocs,
      };
    } else if (action === 'correspondence') {
      path = `/api/matters/${encodeURIComponent(matterId)}/ai/draft-correspondence`;
      body = {
        title: title || 'Client Correspondence',
        instruction: instruction || 'Draft professional legal correspondence updating on case progress.',
        contextDocuments: contextDocs,
      };
    } else if (action === 'attendance') {
      path = `/api/matters/${encodeURIComponent(matterId)}/ai/structure-attendance-note`;
      body = {
        title: title || 'Attendance Note',
        rawNotes: rawNotes || 'Telephone conference with client regarding instructions.',
        contextDocuments: contextDocs,
      };
    }

    try {
      const response = await postJson(path, body);
      if (!response.ok) {
        setGenerateErrors(await messagesOf(response));
        setIsGenerating(false);
        return;
      }

      const created = (await response.json()) as { draftId: string };
      // Refresh drafts list
      const draftsRes = await fetch(`/api/matters/${encodeURIComponent(matterId)}/ai/drafts`);
      if (draftsRes.ok) {
        const data = (await draftsRes.json()) as { drafts: AiDraftSummary[] };
        setDraftsList(data.drafts);
      }

      // Switch to review tab and load newly created draft
      setActiveTab('review');
      await loadDraftDetails(created.draftId);
      setTitle('');
      setInstruction('');
      setRawNotes('');
      router.refresh();
    } catch {
      setGenerateErrors(['A network error occurred while dispatching the AI request.']);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReviewDecision = async (decision: 'accepted' | 'modified' | 'rejected') => {
    if (!activeDraftDetail) return;
    setIsSubmittingReview(true);
    setReviewErrors(undefined);

    const body: Record<string, unknown> = {
      decision,
      finalText: decision !== 'rejected' ? editedText : null,
      feedbackReason: feedbackReason || null,
    };

    if (decision !== 'rejected' && promoteToDoc) {
      body.promoteToDocument = {
        title: promoteToDocTitle || activeDraftDetail.title,
        category: 'correspondence',
      };
    }

    if (decision !== 'rejected' && promoteToTask) {
      body.promoteToTask = {
        title: promoteToTaskTitle || `Review AI draft: ${activeDraftDetail.title}`,
        priority: 'normal',
      };
    }

    try {
      const response = await postJson(
        `/api/matters/${encodeURIComponent(matterId)}/ai/drafts/${encodeURIComponent(activeDraftDetail.id)}/review`,
        body,
      );

      if (!response.ok) {
        setReviewErrors(await messagesOf(response));
        setIsSubmittingReview(false);
        return;
      }

      // Refresh draft details and list
      await loadDraftDetails(activeDraftDetail.id);
      const draftsRes = await fetch(`/api/matters/${encodeURIComponent(matterId)}/ai/drafts`);
      if (draftsRes.ok) {
        const data = (await draftsRes.json()) as { drafts: AiDraftSummary[] };
        setDraftsList(data.drafts);
      }
      router.refresh();
    } catch {
      setReviewErrors(['Failed to record review decision. Please try again.']);
    } finally {
      setIsSubmittingReview(false);
    }
  };

  return (
    <section aria-labelledby="ai-workbench-heading" className="card" style={{ marginTop: '2rem', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '1.5rem', background: '#ffffff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '1rem' }}>
        <div>
          <h2 id="ai-workbench-heading" style={{ margin: 0, fontSize: '1.35rem', color: '#0f172a' }}>
            Legal Drafting Assistant & AI Workbench
          </h2>
          <p className="secondary" style={{ margin: '0.25rem 0 0', fontSize: '0.9rem' }}>
            SRA Code Paras 1.4 & 2.1 compliant: AI generates unapproved drafts under fee earner supervision.
          </p>
        </div>

        {metrics && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', background: '#f8fafc', padding: '0.5rem 1rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
            <span style={{ fontSize: '0.85rem', color: '#475569' }}>Matter Token Budget:</span>
            <div style={{ width: '100px', height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, metrics.percentUsed)}%`, height: '100%', background: metrics.percentUsed > 80 ? '#ef4444' : '#0284c7' }} />
            </div>
            <strong style={{ fontSize: '0.85rem', color: '#0f172a' }}>{metrics.tokensUsedThisMonth.toLocaleString()} tokens</strong>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="AI Workbench navigation" style={{ display: 'flex', gap: '0.5rem', margin: '1.25rem 0', borderBottom: '1px solid #e2e8f0' }}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'generate'}
          onClick={() => setActiveTab('generate')}
          style={{
            padding: '0.5rem 1rem',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'generate' ? '2px solid #0284c7' : '2px solid transparent',
            color: activeTab === 'generate' ? '#0284c7' : '#64748b',
            fontWeight: activeTab === 'generate' ? 600 : 400,
            cursor: 'pointer',
          }}
        >
          Drafting Assistant
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'review'}
          onClick={() => {
            setActiveTab('review');
            if (selectedDraftId && !activeDraftDetail) {
              void loadDraftDetails(selectedDraftId);
            }
          }}
          style={{
            padding: '0.5rem 1rem',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'review' ? '2px solid #0284c7' : '2px solid transparent',
            color: activeTab === 'review' ? '#0284c7' : '#64748b',
            fontWeight: activeTab === 'review' ? 600 : 400,
            cursor: 'pointer',
          }}
        >
          Drafts & Review ({draftsList.length})
        </button>
      </div>

      {/* GENERATION TAB */}
      {activeTab === 'generate' && (
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
            <button
              type="button"
              className={`button ${action === 'summarise' ? '' : 'button-secondary'}`}
              onClick={() => setAction('summarise')}
            >
              📄 Summarise Document
            </button>
            <button
              type="button"
              className={`button ${action === 'chronology' ? '' : 'button-secondary'}`}
              onClick={() => setAction('chronology')}
            >
              📅 Extract Chronology
            </button>
            <button
              type="button"
              className={`button ${action === 'correspondence' ? '' : 'button-secondary'}`}
              onClick={() => setAction('correspondence')}
            >
              ✉️ Draft Correspondence
            </button>
            <button
              type="button"
              className={`button ${action === 'attendance' ? '' : 'button-secondary'}`}
              onClick={() => setAction('attendance')}
            >
              📝 Attendance Note
            </button>
          </div>

          <form onSubmit={handleGenerate} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {generateErrors && (
              <div className="notice notice-error" role="alert">
                {generateErrors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            )}

            <div>
              <label htmlFor="ai-title" style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
                Draft Title
              </label>
              <input
                id="ai-title"
                type="text"
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={
                  action === 'summarise'
                    ? 'e.g. Commercial Lease Key Terms Summary'
                    : action === 'chronology'
                      ? 'e.g. Chronology of Contractual Breach'
                      : action === 'correspondence'
                        ? 'e.g. Client Update Letter'
                        : 'e.g. Attendance Note: Telephone conference with Client'
                }
                required
                style={{ width: '100%' }}
              />
            </div>

            {action !== 'attendance' ? (
              <div>
                <label htmlFor="ai-instruction" style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
                  Fee Earner Instructions
                </label>
                <textarea
                  id="ai-instruction"
                  className="input"
                  rows={4}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Specify particular issues to focus on, legal questions to analyse, or key deadlines to extract..."
                  required
                  style={{ width: '100%', fontFamily: 'inherit' }}
                />
              </div>
            ) : (
              <div>
                <label htmlFor="ai-raw-notes" style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
                  Raw Notes / Dictation
                </label>
                <textarea
                  id="ai-raw-notes"
                  className="input"
                  rows={6}
                  value={rawNotes}
                  onChange={(e) => setRawNotes(e.target.value)}
                  placeholder="Paste dictated transcript or quick phone jottings here..."
                  required
                  style={{ width: '100%', fontFamily: 'inherit' }}
                />
              </div>
            )}

            {documents.length > 0 && (
              <div>
                <span style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                  Attach Context Matter Documents (Grounded Citations)
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '150px', overflowY: 'auto', border: '1px solid #e2e8f0', padding: '0.5rem', borderRadius: '4px' }}>
                  {documents.map((doc) => (
                    <label key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
                      <input
                        type="checkbox"
                        checked={selectedDocIds.includes(doc.id)}
                        onChange={() => handleDocToggle(doc.id)}
                      />
                      <span>{doc.title} ({doc.category})</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div>
              <button type="submit" className="button" disabled={isGenerating}>
                {isGenerating ? 'Generating Draft...' : 'Generate Unapproved Draft'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* REVIEW TAB */}
      {activeTab === 'review' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(250px, 300px) 1fr', gap: '1.5rem' }}>
          {/* Drafts List Column */}
          <div style={{ borderRight: '1px solid #e2e8f0', paddingRight: '1rem' }}>
            <h3 style={{ fontSize: '1rem', marginTop: 0 }}>Matter Drafts</h3>
            {draftsList.length === 0 ? (
              <p className="secondary" style={{ fontSize: '0.9rem' }}>No AI drafts generated yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {draftsList.map((d) => {
                  const isSelected = d.id === selectedDraftId;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => void loadDraftDetails(d.id)}
                      style={{
                        textAlign: 'left',
                        padding: '0.75rem',
                        borderRadius: '6px',
                        border: isSelected ? '2px solid #0284c7' : '1px solid #e2e8f0',
                        background: isSelected ? '#f0f9ff' : '#ffffff',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                        <strong style={{ fontSize: '0.9rem', color: '#0f172a' }}>{d.title}</strong>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            fontWeight: 600,
                            background:
                              d.reviewDecision === 'accepted'
                                ? '#dcfce7'
                                : d.reviewDecision === 'modified'
                                  ? '#dbeafe'
                                  : d.reviewDecision === 'rejected'
                                    ? '#fee2e2'
                                    : '#fef3c7',
                            color:
                              d.reviewDecision === 'accepted'
                                ? '#166534'
                                : d.reviewDecision === 'modified'
                                  ? '#1e40af'
                                  : d.reviewDecision === 'rejected'
                                    ? '#991b1b'
                                    : '#92400e',
                          }}
                        >
                          {d.reviewStatus === 'reviewed' ? d.reviewDecision : 'Pending'}
                        </span>
                      </div>
                      <span className="secondary" style={{ fontSize: '0.8rem' }}>{d.draftType.replace('_', ' ')}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Workbench / Diff Editor Column */}
          <div>
            {isLoadingDraft && <p>Loading draft details...</p>}

            {!isLoadingDraft && !activeDraftDetail && (
              <p className="secondary">Select a draft on the left to review, edit and promote.</p>
            )}

            {!isLoadingDraft && activeDraftDetail && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* SRA Warning Banner */}
                <div style={{ background: '#fffbeb', borderLeft: '4px solid #f59e0b', padding: '0.75rem 1rem', borderRadius: '4px' }}>
                  <strong style={{ color: '#92400e', display: 'block', marginBottom: '0.25rem' }}>
                    SRA Warning Notice: Unverified AI Output
                  </strong>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: '#78350f' }}>
                    This text was generated by AI. All case citations, statutory references, and factual assertions must be independently verified against primary matter files prior to client dispatch.
                  </p>
                </div>

                {reviewErrors && (
                  <div className="notice notice-error" role="alert">
                    {reviewErrors.map((err, i) => (
                      <p key={i}>{err}</p>
                    ))}
                  </div>
                )}

                {/* Structured Citations */}
                {activeDraftDetail.structuredCitations.length > 0 && (
                  <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                    <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.9rem' }}>Linked Grounding Citations</h4>
                    <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.85rem' }}>
                      {activeDraftDetail.structuredCitations.map((c, i) => (
                        <li key={i} style={{ marginBottom: '0.25rem' }}>
                          <strong>{c.documentTitle}</strong> {c.pageNumber ? `(p. ${c.pageNumber})` : ''}: <em>&ldquo;{c.quote}&rdquo;</em>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Side-by-Side / Diff Viewer */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', color: '#64748b' }}>
                      Original AI Draft (Read-Only)
                    </label>
                    <textarea
                      readOnly
                      rows={12}
                      value={activeDraftDetail.generatedText}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        fontSize: '0.85rem',
                        fontFamily: 'monospace',
                        background: '#f1f5f9',
                        border: '1px solid #cbd5e1',
                        borderRadius: '4px',
                        color: '#334155',
                      }}
                    />
                  </div>

                  <div>
                    <label htmlFor="ai-editor" style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', color: '#0f172a' }}>
                      Fee Earner Edited & Approved Version
                    </label>
                    <textarea
                      id="ai-editor"
                      rows={12}
                      value={editedText}
                      onChange={(e) => setEditedText(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        fontSize: '0.85rem',
                        fontFamily: 'inherit',
                        border: '1px solid #0284c7',
                        borderRadius: '4px',
                      }}
                    />
                  </div>
                </div>

                {/* Promotion options */}
                <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '6px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Promotion Options Upon Approval</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={promoteToDoc}
                      onChange={(e) => setPromoteToDoc(e.target.checked)}
                    />
                    <span>Promote draft to official Matter Document (`app.documents`)</span>
                  </label>
                  {promoteToDoc && (
                    <input
                      type="text"
                      className="input"
                      value={promoteToDocTitle}
                      onChange={(e) => setPromoteToDocTitle(e.target.value)}
                      placeholder="Official Document Title"
                      style={{ width: '100%', fontSize: '0.85rem' }}
                    />
                  )}

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={promoteToTask}
                      onChange={(e) => setPromoteToTask(e.target.checked)}
                    />
                    <span>Create follow-up task on Matter (`app.tasks`)</span>
                  </label>
                  {promoteToTask && (
                    <input
                      type="text"
                      className="input"
                      value={promoteToTaskTitle}
                      onChange={(e) => setPromoteToTaskTitle(e.target.value)}
                      placeholder="Follow-up Task Title"
                      style={{ width: '100%', fontSize: '0.85rem' }}
                    />
                  )}
                </div>

                {/* Feedback reason input for rejection or modification */}
                <div>
                  <label htmlFor="ai-feedback" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                    Review / Audit Feedback Notes (Required if rejecting)
                  </label>
                  <input
                    id="ai-feedback"
                    type="text"
                    className="input"
                    value={feedbackReason}
                    onChange={(e) => setFeedbackReason(e.target.value)}
                    placeholder="e.g. Corrected statutory limitation period; verified all primary authorities..."
                    style={{ width: '100%', fontSize: '0.85rem' }}
                  />
                </div>

                {/* Review Action Buttons */}
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="button"
                    disabled={isSubmittingReview}
                    onClick={() => void handleReviewDecision('accepted')}
                    style={{ background: '#16a34a', borderColor: '#16a34a' }}
                  >
                    ✅ Accept As-Is & Promote
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={isSubmittingReview}
                    onClick={() => void handleReviewDecision('modified')}
                  >
                    ✏️ Approve with Modifications
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={isSubmittingReview}
                    onClick={() => void handleReviewDecision('rejected')}
                    style={{ color: '#dc2626' }}
                  >
                    ❌ Reject Draft
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
