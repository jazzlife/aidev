import { DownloadIcon, FileArchiveIcon, FileCodeIcon, FileIcon, FileTextIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ChatAttachment } from '@/shared/types';
import { isIosHomeScreenApp } from '@/shared/utils';

type ChatMessageFilesProps = {
  files: ChatAttachment[];
};

const formatFileSize = (size?: number) => {
  if (typeof size !== 'number') return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const getFileIcon = (file: ChatAttachment) => {
  const name = (file.name || file.path || '').toLowerCase();
  const mimeType = file.mimeType || '';
  if (mimeType.startsWith('text/') || /\.(md|txt|pdf|docx?)$/.test(name)) return FileTextIcon;
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return FileArchiveIcon;
  if (/\.(js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|css|html|json|ya?ml)$/.test(name)) return FileCodeIcon;
  return FileIcon;
};

/**
 * Saves the file. In the iOS home-screen app a download opens the file in place of the app with no way back, so
 * the share sheet ("파일에 저장" and friends) takes it instead. False when iOS refused the sheet because the tap
 * that asked for it is too old (the file was still downloading): the caller asks for another tap.
 */
async function saveFile(blob: Blob, name: string): Promise<boolean> {
  if (isIosHomeScreenApp()) {
    const shared = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare?.({ files: [shared] })) {
      try {
        await navigator.share({ files: [shared] });
      } catch (error) {
        // AbortError: the sheet was closed without picking anything
        if (error instanceof DOMException && error.name === 'NotAllowedError') return false;
      }
      return true;
    }
  }
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  return true;
}

function ChatMessageFile({ file }: { file: ChatAttachment }) {
  const [isDownloading, setIsDownloading] = useState(false);
  // the file is downloaded but iOS wanted a fresh tap to open the share sheet: the card says so
  const [needsTap, setNeedsTap] = useState(false);
  // that downloaded file, so the next tap opens the sheet at once (a fetch first would be too late again)
  const readyBlobRef = useRef<Blob | null>(null);
  const name = file.name || file.path?.split(/[\\/]/).pop() || 'Attached file';
  const FileTypeIcon = getFileIcon(file);
  const size = formatFileSize(file.size);

  const download = async () => {
    if (!file.path || isDownloading) return;
    const storedName = file.path.split(/[\\/]/).pop();
    if (!storedName) return;

    const ready = readyBlobRef.current;
    if (ready) {
      readyBlobRef.current = null;
      setNeedsTap(false);
      if (!(await saveFile(ready, name))) {
        readyBlobRef.current = ready;
        setNeedsTap(true);
      }
      return;
    }

    setIsDownloading(true);
    try {
      const response = await api.assets.file(storedName);
      if (!response.ok) return;
      const blob = await response.blob();
      if (!(await saveFile(blob, name))) {
        readyBlobRef.current = blob;
        setNeedsTap(true);
      }
    } catch (error) {
      console.error(`Failed to download attachment "${name}":`, error);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void download()}
      disabled={!file.path || isDownloading}
      className="group/file flex w-64 max-w-full items-center gap-3 rounded-xl border border-border/50 bg-card px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-card"
      aria-label={`Download ${name}`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <FileTypeIcon className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={name}>{name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{needsTap ? '한 번 더 누르면 저장' : size || 'File attachment'}</p>
      </div>
      <DownloadIcon
        className={`h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover/file:text-foreground ${
          isDownloading ? 'animate-pulse' : ''
        }`}
        aria-hidden
      />
    </button>
  );
}

/**
 * Rendered by chat's MessageComponent to list the non-image file attachments
 * on a user turn as downloadable cards.
 */
export default function ChatMessageFiles({ files }: ChatMessageFilesProps) {
  if (!files?.length) return null;

  return (
    <div className="flex max-w-full flex-wrap justify-end gap-2">
      {files.map((file, index) => (
        <ChatMessageFile key={file.path || file.name || index} file={file} />
      ))}
    </div>
  );
}
