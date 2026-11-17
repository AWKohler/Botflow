'use client';

import { useState, useRef } from 'react';
import type { JSX } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FileNode {
  type: 'file' | 'folder';
  [key: string]: unknown;
}

interface FileTreeProps {
  files: Record<string, FileNode>;
  selectedFile: string | null;
  onFileSelect: (filePath: string) => void;
  onFileDrop?: (targetFolder: string, transfer: DataTransfer) => Promise<void>;
}

export function FileTree({ files, selectedFile, onFileSelect, onFileDrop }: FileTreeProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['/']));
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // Counter to correctly handle nested drag enter/leave events
  const dragCounter = useRef(0);

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  // ── Drag handlers ──────────────────────────────────────────────────────────

  const onContainerDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDraggingOver(true);
  };

  const onContainerDragLeave = (_e: React.DragEvent) => {
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDraggingOver(false);
      setDragOverFolder(null);
    }
  };

  const onContainerDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    // If nothing specific is highlighted, default to root
    if (!dragOverFolder) setDragOverFolder('/');
  };

  const onContainerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const target = dragOverFolder ?? '/';
    dragCounter.current = 0;
    setIsDraggingOver(false);
    setDragOverFolder(null);
    if (e.dataTransfer.items.length > 0 || e.dataTransfer.files.length > 0) {
      onFileDrop?.(target, e.dataTransfer);
    }
  };

  const onFolderDragEnter = (e: React.DragEvent, folderPath: string) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.stopPropagation();
    setDragOverFolder(folderPath);
    // Auto-expand the folder so user can navigate into subfolders while dragging
    setExpandedFolders(prev => new Set([...prev, folderPath]));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const renderFileTree = () => {
    const sortedPaths = Object.keys(files).sort();
    const tree: JSX.Element[] = [];

    for (const filePath of sortedPaths) {
      if (filePath === '/') continue;

      const pathParts = filePath.split('/').filter(Boolean);
      const depth = pathParts.length - 1;
      const name = pathParts[pathParts.length - 1];
      const parentPath = '/' + pathParts.slice(0, -1).join('/');

      if (depth > 0 && !expandedFolders.has(parentPath)) continue;

      const isFolder = files[filePath].type === 'folder';
      const isExpanded = expandedFolders.has(filePath);
      const isSelected = selectedFile === filePath;
      const isDragTarget = dragOverFolder === filePath;

      tree.push(
        <div
          key={filePath}
          className={cn(
            'flex h-7 cursor-pointer items-center rounded-md px-2 text-[13px] transition-colors duration-100',
            'hover:bg-elevated',
            // Selected file: a stronger fill plus an accent edge, not just a shade.
            isSelected && !isFolder && 'bg-soft font-medium shadow-[inset_2px_0_0_var(--sand-accent)]',
            isDragTarget && isFolder && 'bg-accent-soft ring-1 ring-accent',
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            if (isFolder) toggleFolder(filePath);
            else onFileSelect(filePath);
          }}
          // Folder rows advertise themselves as drop targets
          onDragEnter={isFolder ? (e) => onFolderDragEnter(e, filePath) : undefined}
          onDragOver={isFolder ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
        >
          {isFolder ? (
            <>
              {isExpanded ? (
                <ChevronDown size={14} className="mr-1 shrink-0 text-subtle" />
              ) : (
                <ChevronRight size={14} className="mr-1 shrink-0 text-subtle" />
              )}
              {isExpanded ? (
                <FolderOpen size={15} strokeWidth={1.75} className={cn('mr-2 shrink-0', isDragTarget ? 'text-accent' : 'text-muted')} />
              ) : (
                <Folder size={15} strokeWidth={1.75} className="mr-2 shrink-0 text-muted" />
              )}
            </>
          ) : (
            <>
              <div className="mr-1 w-3.5 shrink-0" />
              <File size={15} strokeWidth={1.75} className="mr-2 shrink-0 text-subtle" />
            </>
          )}
          <span className={cn(
            'truncate',
            isSelected && !isFolder ? 'text-fg' : isFolder ? 'text-fg' : 'text-muted',
            isDragTarget && isFolder && 'text-accent font-medium',
          )}>
            {name}
          </span>
        </div>
      );
    }

    return tree;
  };

  // Root row drag target
  const isRootTarget = dragOverFolder === '/';

  return (
    <div
      className={cn(
        'relative p-1.5 text-fg transition-colors duration-150',
        isDraggingOver && 'rounded-lg bg-accent-soft ring-1 ring-inset ring-accent/40',
      )}
      onDragEnter={onContainerDragEnter}
      onDragLeave={onContainerDragLeave}
      onDragOver={onContainerDragOver}
      onDrop={onContainerDrop}
    >
      {/* Root "Project" row */}
      <div
        className={cn(
          'flex h-7 cursor-pointer items-center rounded-md px-2 text-[13px] transition-colors duration-100 hover:bg-elevated',
          isRootTarget && isDraggingOver && 'bg-accent-soft ring-1 ring-accent',
        )}
        onClick={() => toggleFolder('/')}
        onDragEnter={(e) => { e.stopPropagation(); setDragOverFolder('/'); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        {expandedFolders.has('/') ? (
          <ChevronDown size={14} className="mr-1 shrink-0 text-subtle" />
        ) : (
          <ChevronRight size={14} className="mr-1 shrink-0 text-subtle" />
        )}
        {expandedFolders.has('/') ? (
          <FolderOpen size={15} strokeWidth={1.75} className="mr-2 shrink-0 text-muted" />
        ) : (
          <Folder size={15} strokeWidth={1.75} className="mr-2 shrink-0 text-muted" />
        )}
        <span className={cn('flex-1 font-medium text-fg', isRootTarget && isDraggingOver && 'text-accent')}>
          Project
        </span>
      </div>

      {expandedFolders.has('/') && renderFileTree()}

      {/* Drop overlay — only shown while dragging over the tree */}
      {isDraggingOver && (
        <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-end pb-4 gap-1">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent/90 text-accent-foreground text-xs font-medium shadow-lg">
            <UploadCloud size={13} />
            Drop into{' '}
            {dragOverFolder === '/' || !dragOverFolder
              ? 'Project root'
              : dragOverFolder.split('/').filter(Boolean).pop()}
          </div>
        </div>
      )}
    </div>
  );
}
