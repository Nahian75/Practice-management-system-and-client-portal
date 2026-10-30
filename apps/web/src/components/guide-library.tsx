'use client';

import { useState } from 'react';
import { PAGE_GUIDES } from '@/lib/page-guides';

export function GuideLibrary() {
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const guides = PAGE_GUIDES.filter((guide) =>
    [guide.title, guide.description, ...guide.steps, guide.reminder].join(' ').toLowerCase().includes(search));

  return <>
    <div className="guide-search">
      <label className="label" htmlFor="guide-search">What do you need help with?</label>
      <input className="input" id="guide-search" type="search" value={query}
        onChange={(event) => setQuery(event.target.value)} placeholder="Try client invitations, sanctions, payments or leave" />
      <p className="hint" role="status">{guides.length} {guides.length === 1 ? 'guide' : 'guides'} found</p>
    </div>
    {guides.length === 0 && <div className="notice"><p>No matching guide. Try a shorter word, or ask your supervisor for help.</p></div>}
    <div className="guide-library">{guides.map((guide) => <details key={guide.title}>
      <summary>{guide.title}</summary>
      <p>{guide.description}</p>
      <ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <p className="guide-reminder"><strong>Remember:</strong> {guide.reminder}</p>
    </details>)}</div>
  </>;
}
