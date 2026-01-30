'use client';

import React from 'react';

export default function Modal({
  open,
  onClose,
  children,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* dialog */}
      <div className="absolute inset-0 flex items-start justify-center mt-16 px-4">
        <div className="w-full max-w-2xl rounded-lg bg-white dark:bg-neutral-900 shadow-lg border border-gray-200 dark:border-gray-800 max-h-[80vh] overflow-hidden">
          {/* sticky header */}
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 p-3 bg-white dark:bg-neutral-900 border-b border-gray-200 dark:border-gray-800">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {title ?? ''}
            </div>

            <button
              onClick={onClose}
              className="rounded border px-3 py-1 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
            >
              Close
            </button>
          </div>

          {/* scrollable body */}
          <div className="p-6 overflow-y-auto max-h-[calc(80vh-52px)]">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}