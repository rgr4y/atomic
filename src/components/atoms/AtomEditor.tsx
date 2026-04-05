import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getTransport } from '../../lib/transport';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { nord } from '@milkdown/theme-nord';
import '@milkdown/theme-nord/style.css';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { TagChip } from '../tags/TagChip';
import { useAtomsStore, AtomWithTags, Tag } from '../../stores/atoms';
import { useTagsStore, TagWithCount } from '../../stores/tags';
import { isValidUrl } from '../../lib/markdown';

interface AtomEditorProps {
  atomId: string | null; // null for new atom
  onClose?: () => void;
  onSaved?: (atom: AtomWithTags) => void;
}

interface MilkdownEditorInnerProps {
  initialContent: string;
  onChange: (markdown: string) => void;
}

function MilkdownEditorInner({ initialContent, onChange }: MilkdownEditorInnerProps) {
  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialContent);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
          if (markdown !== prevMarkdown) {
            onChange(markdown);
          }
        });
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(listener),
    [initialContent]
  );

  return <Milkdown />;
}

// Inline tag input — just the text input with dropdown, chips rendered by parent
function InlineTagInput({ selectedTags, onTagsChange }: { selectedTags: Tag[]; onTagsChange: (tags: Tag[]) => void }) {
  const tags = useTagsStore(s => s.tags);
  const createTag = useTagsStore(s => s.createTag);
  const [inputValue, setInputValue] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const flattenTags = (tags: TagWithCount[]): Tag[] => {
    return tags.reduce<Tag[]>((acc, tag) => {
      acc.push({ id: tag.id, name: tag.name, parent_id: tag.parent_id, created_at: tag.created_at });
      if (tag.children) acc.push(...flattenTags(tag.children));
      return acc;
    }, []);
  };

  const allTags = useMemo(() => flattenTags(tags), [tags]);
  const selectedTagIds = new Set(selectedTags.map(t => t.id));

  const filtered = useMemo(() => {
    if (!inputValue.trim()) return [];
    const q = inputValue.toLowerCase();
    return allTags
      .filter(t => !selectedTagIds.has(t.id) && t.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [allTags, inputValue, selectedTagIds]);

  const exactMatch = allTags.some(t => t.name.toLowerCase() === inputValue.trim().toLowerCase());

  const addTag = (tag: Tag) => {
    onTagsChange([...selectedTags, tag]);
    setInputValue('');
    setShowDropdown(false);
  };

  const commitInput = async () => {
    const val = inputValue.trim();
    if (!val || isCreating) return;

    const existing = allTags.find(t => t.name.toLowerCase() === val.toLowerCase() && !selectedTagIds.has(t.id));
    if (existing) {
      addTag(existing);
      return;
    }

    if (!exactMatch) {
      setIsCreating(true);
      try {
        const newTag = await createTag(val);
        onTagsChange([...selectedTags, newTag]);
        setInputValue('');
        setShowDropdown(false);
      } catch (e) {
        console.error('Failed to create tag:', e);
      } finally {
        setIsCreating(false);
      }
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={inputValue}
        onChange={e => { setInputValue(e.target.value); setShowDropdown(true); }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (filtered.length > 0) {
              addTag(filtered[0]);
            } else {
              commitInput();
            }
          }
          if (e.key === 'Backspace' && !inputValue && selectedTags.length > 0) {
            onTagsChange(selectedTags.slice(0, -1));
          }
        }}
        onFocus={() => setShowDropdown(true)}
        onBlur={() => {
          setTimeout(() => {
            setShowDropdown(false);
            if (inputValue.trim()) commitInput();
          }, 150);
        }}
        placeholder={selectedTags.length === 0 ? 'Add tags...' : ''}
        className="bg-transparent border-none outline-none text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] min-w-[60px] w-auto"
        style={{ width: Math.max(60, inputValue.length * 8 + 20) }}
      />
      {showDropdown && inputValue && (filtered.length > 0 || (!exactMatch && inputValue.trim())) && (
        <div className="absolute bottom-full left-0 mb-1 w-56 bg-[var(--color-bg-panel)] border border-[var(--color-border)] rounded-md shadow-lg max-h-48 overflow-y-auto z-50">
          {filtered.map(tag => (
            <button
              key={tag.id}
              onMouseDown={e => e.preventDefault()}
              onClick={() => addTag(tag)}
              className="w-full px-3 py-1.5 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              {tag.name}
            </button>
          ))}
          {!exactMatch && inputValue.trim() && (
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => commitInput()}
              className="w-full px-3 py-1.5 text-left text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              Create "{inputValue.trim()}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function AtomEditor({ atomId, onSaved }: AtomEditorProps) {
  const createAtom = useAtomsStore(s => s.createAtom);
  const updateAtom = useAtomsStore(s => s.updateAtom);
  const fetchTags = useTagsStore(s => s.fetchTags);
  const [content, setContent] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [existingAtom, setExistingAtom] = useState<AtomWithTags | null>(null);
  const [isLoadingAtom, setIsLoadingAtom] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [isEditingUrl, setIsEditingUrl] = useState(false);

  const isEditing = atomId !== null;

  useEffect(() => {
    if (isEditing && atomId) {
      setIsLoadingAtom(true);
      getTransport().invoke<AtomWithTags | null>('get_atom_by_id', { id: atomId })
        .then((fetchedAtom) => {
          setExistingAtom(fetchedAtom);
          setIsLoadingAtom(false);
        })
        .catch((error) => {
          console.error('Failed to fetch atom:', error);
          setExistingAtom(null);
          setIsLoadingAtom(false);
        });
    } else {
      setExistingAtom(null);
      setEditorReady(true);
    }
  }, [isEditing, atomId]);

  useEffect(() => {
    if (existingAtom) {
      setContent(existingAtom.content);
      setSourceUrl(existingAtom.source_url || '');
      setSelectedTags(existingAtom.tags);
      setEditorReady(true);
    }
  }, [existingAtom]);

  const handleContentChange = useCallback((markdown: string) => {
    setContent(markdown);
  }, []);

  // Auto-save on unmount (when drawer closes, click outside, ESC, etc.)
  const contentRef = useRef(content);
  const sourceUrlRef = useRef(sourceUrl);
  const selectedTagsRef = useRef(selectedTags);
  const onSavedRef = useRef(onSaved);
  contentRef.current = content;
  sourceUrlRef.current = sourceUrl;
  selectedTagsRef.current = selectedTags;
  onSavedRef.current = onSaved;

  // Debounced background save while typing (silent, doesn't affect focus)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!content.trim()) return;

    // Clear existing timer
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    // Set new timer for debounced save
    saveTimerRef.current = setTimeout(() => {
      const c = contentRef.current;
      const url = sourceUrlRef.current;
      const tags = selectedTagsRef.current;
      if (!c.trim()) return;

      const tagIds = tags.map((t) => t.id);
      const validUrl = url && isValidUrl(url) ? url : undefined;
      const save = isEditing
        ? updateAtom(atomId!, c, validUrl, tagIds)
        : createAtom(c, validUrl, tagIds);
      save.catch((e) => console.error('Auto-save failed:', e));
    }, 2000); // 2 second debounce

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [content, selectedTags, sourceUrl, isEditing, atomId, updateAtom, createAtom]);

  useEffect(() => {
    return () => {
      const c = contentRef.current;
      const url = sourceUrlRef.current;
      const tags = selectedTagsRef.current;
      if (!c.trim()) return;
      const tagIds = tags.map((t) => t.id);
      const validUrl = url && isValidUrl(url) ? url : undefined;
      const save = isEditing
        ? updateAtom(atomId!, c, validUrl, tagIds)
        : createAtom(c, validUrl, tagIds);
      save
        .then((savedAtom) => { onSavedRef.current?.(savedAtom); return fetchTags(); })
        .catch((e) => console.error('Auto-save on close failed:', e));
    };
  }, []);

  if (isEditing && isLoadingAtom) {
    return (
      <div className="flex items-center justify-center h-full p-4 text-[var(--color-text-secondary)]">
        Loading atom...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Editor - takes all available space */}
      <div className="flex-1 overflow-auto milkdown-editor-wrapper">
        {editorReady && (
          <MilkdownProvider>
            <MilkdownEditorInner
              initialContent={content}
              onChange={handleContentChange}
            />
          </MilkdownProvider>
        )}
      </div>

      {/* Bottom bar: tags left, source URL right */}
      <div className="flex items-center gap-3 px-6 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg-card)]">
        <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
          {selectedTags.map(tag => (
            <TagChip
              key={tag.id}
              name={tag.name}
              size="sm"
              onRemove={() => setSelectedTags(selectedTags.filter(t => t.id !== tag.id))}
            />
          ))}
          <InlineTagInput
            selectedTags={selectedTags}
            onTagsChange={setSelectedTags}
          />
        </div>
        {/* Source URL: glass input when empty, clickable link when filled */}
        {sourceUrl && !isEditingUrl ? (
          <button
            onDoubleClick={() => setIsEditingUrl(true)}
            onClick={(e) => {
              e.preventDefault();
              if (sourceUrl && isValidUrl(sourceUrl)) {
                window.open(sourceUrl, '_blank');
              }
            }}
            title="Click to open, double-click to edit"
            className="shrink-0 max-w-[220px] px-3 py-1.5 text-sm text-right text-[var(--color-accent)] hover:text-[var(--color-accent-light)] underline cursor-pointer transition-colors truncate"
          >
            {sourceUrl}
          </button>
        ) : (
          <input
            autoFocus={isEditingUrl}
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            onBlur={() => setIsEditingUrl(false)}
            placeholder="Source URL"
            className="shrink-0 w-[220px] px-3 py-1.5 text-sm text-right rounded-lg bg-white/8 backdrop-blur-sm border border-white/10 text-[var(--color-text-secondary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:text-[var(--color-text-primary)] focus:border-white/20 focus:bg-white/12 transition-all duration-200"
          />
        )}
      </div>
    </div>
  );
}
