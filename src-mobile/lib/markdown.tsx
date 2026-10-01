import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { fileRefFromText, type FileRef } from '@m/lib/peek';

const plugins = [remarkGfm];

/**
 * Used by MessageBubble: GFM markdown without math/mermaid/raw-HTML so the mobile bundle stays small. With
 * `onFileRef`, inline code that names a file (`src/app.ts:12`) becomes a tap target for the file peek.
 */
export function Prose({ text, onFileRef }: { text: string; onFileRef?: (ref: FileRef) => void }) {
  const components: Components | undefined = onFileRef ? {
    code({ className, children }) {
      const raw = typeof children === 'string' ? children : Array.isArray(children) && children.every((part) => typeof part === 'string') ? children.join('') : null;
      const ref = !className && raw !== null && !raw.includes('\n') ? fileRefFromText(raw) : null;
      if (!ref) return <code className={className}>{children as ReactNode}</code>;
      return <button type="button" className="m-file-ref" onClick={() => onFileRef(ref)}><code>{raw}</code></button>;
    },
  } : undefined;
  return (
    <div className="m-prose text-[15px]">
      <Markdown remarkPlugins={plugins} components={components}>{text}</Markdown>
    </div>
  );
}
