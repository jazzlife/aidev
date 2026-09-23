import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];

/** Used by MessageBubble: GFM markdown without math/mermaid/raw-HTML so the mobile bundle stays small. */
export function Prose({ text }: { text: string }) {
  return (
    <div className="m-prose text-[15px]">
      <Markdown remarkPlugins={plugins}>{text}</Markdown>
    </div>
  );
}
