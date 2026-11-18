'use client';

import { useState } from 'react';
import { logCopiedAction } from '@/app/actions';

/** Copies the draft text and records "copied, not sent". Sends nothing. */
export function CopyButton({ draftId, text }: { draftId: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span className="copy">
      <button
        type="button"
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState('copied');
            await logCopiedAction(draftId);
          } catch {
            setState('failed');
          }
        }}
      >
        Copy draft
      </button>
      <span role="status" aria-live="polite" className="copy-status">
        {state === 'copied' ? 'Copied to clipboard. Logged as copied, not sent.' : state === 'failed' ? 'Copy failed. Select the text and copy it by hand.' : ''}
      </span>
    </span>
  );
}
