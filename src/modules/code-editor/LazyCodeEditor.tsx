import { lazy, Suspense, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/shared/context/ThemeContext';
import type CodeEditorComponent from '@/modules/code-editor/CodeEditor';
import CodeEditorLoadingState from '@/modules/code-editor/CodeEditorLoadingState';
import MediaFilePreview from '@/modules/code-editor/MediaFilePreview';
import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';

// the CodeMirror editor downloads when a text file is first opened instead of with the app's first screen
const CodeEditor = lazy(() => import('@/modules/code-editor/CodeEditor'));

/**
 * Used by EditorSidebar here and, through the barrel, by the workbench editor group. A media file (image, PDF, audio,
 * video) opens in the preview at once — it never waits for the editor bundle; a text file shows the loading state
 * while that bundle downloads (it showed nothing, 2026-11-09).
 */
export function LazyCodeEditor(props: ComponentProps<typeof CodeEditorComponent>) {
  const { t } = useTranslation('codeEditor');
  const { isDarkMode } = useTheme();
  const kind = getPreviewKind(props.file.name);
  if (kind) {
    return <MediaFilePreview file={props.file} kind={kind} onClose={props.onClose} projectPath={props.projectPath} isSidebar={props.isSidebar} />;
  }
  return (
    <Suspense fallback={<CodeEditorLoadingState isDarkMode={isDarkMode} isSidebar={Boolean(props.isSidebar)} loadingText={t('loading', { fileName: props.file.name })} />}>
      <CodeEditor {...props} />
    </Suspense>
  );
}
