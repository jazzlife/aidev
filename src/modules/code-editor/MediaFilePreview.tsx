import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodeEditorFile, PreviewKind } from '@/shared/types';
import CodeEditorMediaPreview from '@/modules/code-editor/CodeEditorMediaPreview';

type MediaFilePreviewProps = {
  file: CodeEditorFile;
  kind: PreviewKind;
  onClose: () => void;
  projectPath?: string;
  isSidebar?: boolean;
};

/**
 * Used by LazyCodeEditor (and CodeEditor) to show an image, PDF, audio or video file. It needs nothing of the CodeMirror
 * editor, so a media file opens without waiting for that bundle (2026-11-09: an image in the right pane showed nothing
 * until the editor bundle and then the image had both downloaded).
 */
export default function MediaFilePreview({ file, kind, onClose, projectPath, isSidebar = false }: MediaFilePreviewProps) {
  const { t } = useTranslation('codeEditor');
  // the preview's own fullscreen toggle (outside the sidebar)
  const [isFullscreen, setIsFullscreen] = useState(false);
  return (
    <CodeEditorMediaPreview
      file={file}
      kind={kind}
      // the DB projectId from the editor sidebar; projectPath for older callers (as useCodeEditorDocument)
      projectId={file.projectId ?? projectPath}
      isSidebar={isSidebar}
      isFullscreen={isFullscreen}
      onClose={onClose}
      onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
      labels={{
        loading: t('filePreview.loading', 'Loading preview...'),
        error: t('filePreview.error', 'Unable to display this file.'),
        openInNewTab: t('filePreview.openInNewTab', 'Open in new tab'),
        fullscreen: t('actions.fullscreen', 'Fullscreen'),
        exitFullscreen: t('actions.exitFullscreen', 'Exit fullscreen'),
        close: t('actions.close', 'Close'),
      }}
    />
  );
}
