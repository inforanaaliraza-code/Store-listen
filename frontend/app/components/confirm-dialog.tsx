'use client';

import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';

type ConfirmOptions = {
  title: string;
  message: string;
  subject?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
};

type PendingConfirm = { options: ConfirmOptions; resolve: (confirmed: boolean) => void };
type ConfirmContextValue = { confirm: (options: ConfirmOptions) => Promise<boolean> };

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    if (!pending && dialog.open) dialog.close();
  }, [pending]);

  function confirm(options: ConfirmOptions) {
    return new Promise<boolean>((resolve) => setPending({ options, resolve }));
  }

  function finish(confirmed: boolean) {
    pending?.resolve(confirmed);
    setPending(null);
  }

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onCancel={(event) => { event.preventDefault(); finish(false); }}
        onClick={(event) => { if (event.target === dialogRef.current) finish(false); }}
      >
        {pending ? <div className="confirm-dialog-content">
          <div className={`confirm-dialog-mark ${pending.options.tone === 'danger' ? 'danger' : ''}`} aria-hidden="true">{pending.options.tone === 'danger' ? '!' : '?'}</div>
          <div className="confirm-dialog-copy">
            <h2 id="confirm-dialog-title">{pending.options.title}</h2>
            <p id="confirm-dialog-message">{pending.options.message}</p>
            {pending.options.subject ? <div className="confirm-dialog-subject">{pending.options.subject}</div> : null}
          </div>
          <div className="confirm-dialog-actions">
            <button type="button" className="ghost confirm-cancel" onClick={() => finish(false)} autoFocus>{pending.options.cancelLabel ?? 'Cancel'}</button>
            <button type="button" className={pending.options.tone === 'danger' ? 'confirm-destructive' : 'primary'} onClick={() => finish(true)}>{pending.options.confirmLabel ?? 'Confirm'}</button>
          </div>
        </div> : null}
      </dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirmDialog() {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error('useConfirmDialog must be used inside ConfirmDialogProvider.');
  return context.confirm;
}
