import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

import { PreviewPane, ScreenPane } from '@/modules/remote-target';

/**
 * A live window popped out of the workbench into a browser window of its own (`/live/preview`,
 * `/live/screen`): the same pane, full size, for a second monitor or side-by-side with an editor.
 * Used by App (route) — the workbench's live windows open it with their "새 창" button.
 */
export function LiveWindowPage() {
  const { kind } = useParams();
  useEffect(() => { document.title = kind === 'screen' ? '원격 화면 · Nado AI Dev' : '미리보기 · Nado AI Dev'; }, [kind]);
  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {kind === 'screen' ? <ScreenPane isVisible /> : <PreviewPane isVisible />}
    </div>
  );
}
