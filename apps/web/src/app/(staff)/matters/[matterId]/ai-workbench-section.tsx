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
    <section aria-labelledby="ai-workbench-heading"  className={["card","ai-rule-1"].join(" ")}>
      <div className={["ai-rule-2"].join(" ")}>
        <div>
          <h2 id="ai-workbench-heading" className={["ai-rule-3"].join(" ")}>
            Legal Drafting Assistant & AI Workbench
          </h2>
          <p  className={["secondary","ai-rule-4"].join(" ")}>
            AI output is an unapproved draft. A responsible fee earner must verify sources, accuracy and confidentiality before use.
          </p>
        </div>

        {metrics && (
          <div className={["ai-rule-5"].join(" ")}>
            <span className={["ai-rule-6"].join(" ")}>Matter Token Budget:</span>
            <div className={["ai-rule-7"].join(" ")}>
              <progress className={metrics.percentUsed > 80 ? 'ai-budget-progress ai-budget-high' : 'ai-budget-progress'} value={Math.max(0, Math.min(100, metrics.percentUsed))} max={100} aria-label="AI token budget used" />
            </div>
            <strong className={["ai-rule-8"].join(" ")}>{metrics.tokensUsedThisMonth.toLocaleString()} tokens</strong>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="AI Workbench navigation" className={["ai-rule-9"].join(" ")}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'generate'}
          onClick={() => setActiveTab('generate')}
          className={["ai-rule-16",(activeTab === 'generate' ? "ai-rule-10" : "ai-rule-11"),(activeTab === 'generate' ? "ai-rule-12" : "ai-rule-13"),(activeTab === 'generate' ? "ai-rule-14" : "ai-rule-15")].join(" ")}
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
          className={["ai-rule-16",(activeTab === 'review' ? "ai-rule-10" : "ai-rule-11"),(activeTab === 'review' ? "ai-rule-12" : "ai-rule-13"),(activeTab === 'review' ? "ai-rule-14" : "ai-rule-15")].join(" ")}
        >
          Drafts & Review ({draftsList.length})
        </button>
      </div>

      {/* GENERATION TAB */}
      {activeTab === 'generate' && (
        <div>
          <div className={["ai-rule-17"].join(" ")}>
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

          <form onSubmit={handleGenerate} className={["ai-rule-18"].join(" ")}>
            {generateErrors && (
              <div className="notice notice-error" role="alert">
                {generateErrors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            )}

            <div>
              <label htmlFor="ai-title" className={["ai-rule-19"].join(" ")}>
                Draft Title
              </label>
              <input
                id="ai-title"
                type="text"
                
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
                className={["input","ai-rule-20"].join(" ")}
              />
            </div>

            {action !== 'attendance' ? (
              <div>
                <label htmlFor="ai-instruction" className={["ai-rule-19"].join(" ")}>
                  Fee Earner Instructions
                </label>
                <textarea
                  id="ai-instruction"
                  
                  rows={4}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Specify particular issues to focus on, legal questions to analyse, or key deadlines to extract..."
                  required
                  className={["input","ai-rule-21"].join(" ")}
                />
              </div>
            ) : (
              <div>
                <label htmlFor="ai-raw-notes" className={["ai-rule-19"].join(" ")}>
                  Raw Notes / Dictation
                </label>
                <textarea
                  id="ai-raw-notes"
                  
                  rows={6}
                  value={rawNotes}
                  onChange={(e) => setRawNotes(e.target.value)}
                  placeholder="Paste dictated transcript or quick phone jottings here..."
                  required
                  className={["input","ai-rule-21"].join(" ")}
                />
              </div>
            )}

            {documents.length > 0 && (
              <div>
                <span className={["ai-rule-22"].join(" ")}>
                  Attach Context Matter Documents (Grounded Citations)
                </span>
                <div className={["ai-rule-23"].join(" ")}>
                  {documents.map((doc) => (
                    <label key={doc.id} className={["ai-rule-24"].join(" ")}>
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
        <div className={["ai-rule-25"].join(" ")}>
          {/* Drafts List Column */}
          <div className={["ai-rule-26"].join(" ")}>
            <h3 className={["ai-rule-27"].join(" ")}>Matter Drafts</h3>
            {draftsList.length === 0 ? (
              <p  className={["secondary","ai-rule-28"].join(" ")}>No AI drafts generated yet.</p>
            ) : (
              <div className={["ai-rule-29"].join(" ")}>
                {draftsList.map((d) => {
                  const isSelected = d.id === selectedDraftId;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => void loadDraftDetails(d.id)}
                      className={["ai-rule-34",(isSelected ? "ai-rule-30" : "ai-rule-31"),(isSelected ? "ai-rule-32" : "ai-rule-33")].join(" ")}
                    >
                      <div className={["ai-rule-35"].join(" ")}>
                        <strong className={["ai-rule-36"].join(" ")}>{d.title}</strong>
                        <span
                          className={["ai-rule-45",(d.reviewDecision === 'accepted' ? "ai-rule-37" : (d.reviewDecision === 'modified' ? "ai-rule-38" : (d.reviewDecision === 'rejected' ? "ai-rule-39" : "ai-rule-40"))),(d.reviewDecision === 'accepted' ? "ai-rule-41" : (d.reviewDecision === 'modified' ? "ai-rule-42" : (d.reviewDecision === 'rejected' ? "ai-rule-43" : "ai-rule-44")))].join(" ")}
                        >
                          {d.reviewStatus === 'reviewed' ? d.reviewDecision : 'Pending'}
                        </span>
                      </div>
                      <span  className={["secondary","ai-rule-46"].join(" ")}>{d.draftType.replace('_', ' ')}</span>
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
              <div className={["ai-rule-18"].join(" ")}>
                {/* SRA Warning Banner */}
                <div className={["ai-rule-47"].join(" ")}>
                  <strong className={["ai-rule-48"].join(" ")}>
                    SRA Warning Notice: Unverified AI Output
                  </strong>
                  <p className={["ai-rule-49"].join(" ")}>
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
                  <div className={["ai-rule-50"].join(" ")}>
                    <h4 className={["ai-rule-51"].join(" ")}>Linked Grounding Citations</h4>
                    <ul className={["ai-rule-52"].join(" ")}>
                      {activeDraftDetail.structuredCitations.map((c, i) => (
                        <li key={i} className={["ai-rule-53"].join(" ")}>
                          <strong>{c.documentTitle}</strong> {c.pageNumber ? `(p. ${c.pageNumber})` : ''}: <em>&ldquo;{c.quote}&rdquo;</em>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Side-by-Side / Diff Viewer */}
                <div className={["ai-rule-54"].join(" ")}>
                  <div>
                    <label className={["ai-rule-55"].join(" ")}>
                      Original AI Draft (Read-Only)
                    </label>
                    <textarea
                      readOnly
                      rows={12}
                      value={activeDraftDetail.generatedText}
                      className={["ai-rule-56"].join(" ")}
                    />
                  </div>

                  <div>
                    <label htmlFor="ai-editor" className={["ai-rule-57"].join(" ")}>
                      Fee Earner Edited & Approved Version
                    </label>
                    <textarea
                      id="ai-editor"
                      rows={12}
                      value={editedText}
                      onChange={(e) => setEditedText(e.target.value)}
                      className={["ai-rule-58"].join(" ")}
                    />
                  </div>
                </div>

                {/* Promotion options */}
                <div className={["ai-rule-59"].join(" ")}>
                  <span className={["ai-rule-60"].join(" ")}>Promotion Options Upon Approval</span>
                  <label className={["ai-rule-61"].join(" ")}>
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
                      
                      value={promoteToDocTitle}
                      onChange={(e) => setPromoteToDocTitle(e.target.value)}
                      placeholder="Official Document Title"
                      className={["input","ai-rule-62"].join(" ")}
                    />
                  )}

                  <label className={["ai-rule-61"].join(" ")}>
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
                      
                      value={promoteToTaskTitle}
                      onChange={(e) => setPromoteToTaskTitle(e.target.value)}
                      placeholder="Follow-up Task Title"
                      className={["input","ai-rule-62"].join(" ")}
                    />
                  )}
                </div>

                {/* Feedback reason input for rejection or modification */}
                <div>
                  <label htmlFor="ai-feedback" className={["ai-rule-63"].join(" ")}>
                    Review / Audit Feedback Notes (Required if rejecting)
                  </label>
                  <input
                    id="ai-feedback"
                    type="text"
                    
                    value={feedbackReason}
                    onChange={(e) => setFeedbackReason(e.target.value)}
                    placeholder="e.g. Corrected statutory limitation period; verified all primary authorities..."
                    className={["input","ai-rule-62"].join(" ")}
                  />
                </div>

                {/* Review Action Buttons */}
                <div className={["ai-rule-64"].join(" ")}>
                  <button
                    type="button"
                    
                    disabled={isSubmittingReview}
                    onClick={() => void handleReviewDecision('accepted')}
                    className={["button","ai-rule-65"].join(" ")}
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
                    
                    disabled={isSubmittingReview}
                    onClick={() => void handleReviewDecision('rejected')}
                    className={["button button-secondary","ai-rule-66"].join(" ")}
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
