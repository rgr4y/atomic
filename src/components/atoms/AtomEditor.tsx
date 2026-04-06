import { useState, useEffect, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getTransport } from '../../lib/transport';
import { TagChip } from '../tags/TagChip';
import { MarkdownImage } from '../ui/MarkdownImage';
import { useAtomsStore, AtomWithTags, Tag } from '../../stores/atoms';
import { useTagsStore } from '../../stores/tags';
import { isValidUrl } from '../../lib/markdown';

interface AtomEditorProps {
  atomId: string | null; // null for new atom
  onClose?: () => void;
  onSaved?: (atom: AtomWithTags) => void;
}

// Inline tag input — just the text input with dropdown, chips rendered by parent
function InlineTagInput({ selectedTags, onTagsChange }: { selectedTags: Tag[]; onTagsChange: (tags: Tag[]) => void }) {
  const tags = useTagsStore(s => s.tags);
  const [inputValue, setInputValue] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const filtered = tags.filter(t =>
    !selectedTags.find(st => st.id === t.id) &&
    t.name.toLowerCase().includes(inputValue.toLowerCase())
  );

  const exactMatch = filtered.some(t => t.name.toLowerCase() === inputValue.toLowerCase());

  const addTag = (tag: Tag) => {
    onTagsChange([...selectedTags, tag]);
    setInputValue('');
    setShowDropdown(false);
  };

  const commitInput = () => {
    if (inputValue.trim() && !exactMatch) {
      // Just commit the input to the tag input - user can save later
      setInputValue('');
      setShowDropdown(false);
    }
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          setShowDropdown(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (filtered.length > 0) {
              addTag(filtered[0]);
            } else if (!exactMatch && inputValue.trim()) {
              commitInput();
            }
          } else if (e.key === 'Escape') {
            setShowDropdown(false);
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
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const isEditing = atomId !== null;

  useEffect(() => {
    if (isEditing && atomId) {
      setIsLoadingAtom(true);
      setIsDirty(false);
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
      setIsDirty(false);
    }
  }, [isEditing, atomId]);

  useEffect(() => {
    if (existingAtom) {
      setContent(existingAtom.content);
      setSourceUrl(existingAtom.source_url || '');
      setSelectedTags(existingAtom.tags);
      // Don't mark dirty — this is loading, not user editing
    }
  }, [existingAtom]);

  // Auto-save on unmount (when drawer closes, click outside, ESC, etc.)
  const contentRef = useRef(content);
  const sourceUrlRef = useRef(sourceUrl);
  const selectedTagsRef = useRef(selectedTags);
  const onSavedRef = useRef(onSaved);
  contentRef.current = content;
  sourceUrlRef.current = sourceUrl;
  selectedTagsRef.current = selectedTags;
  onSavedRef.current = onSaved;

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  // Debounced background save while typing
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!content.trim() || !isDirty) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

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
    }, 2000);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [content, selectedTags, sourceUrl, isDirty, isEditing, atomId, updateAtom, createAtom]);

  useEffect(() => {
    return () => {
      if (!isDirtyRef.current) return;
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
      {/* Split pane: Editor on left, Preview on right */}
      <div className="flex-1 flex overflow-hidden gap-px bg-[var(--color-border)]">
        {/* Left: CodeMirror editor - full height */}
        <div className="w-1/2 overflow-hidden">
          <CodeMirror
            value={content}
            onChange={(val) => { setContent(val); setIsDirty(true); }}
            theme={oneDark}
            extensions={[markdown()]}
            className="h-full"
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
            }}
          />
        </div>

        {/* Right: Live preview (rendered markdown) - full height */}
        <div className="w-1/2 overflow-y-auto bg-[var(--color-bg-panel)] px-6 py-4">
          <article className="prose prose-invert prose-sm max-w-none prose-headings:text-[var(--color-text-primary)] prose-p:text-[var(--color-text-primary)] prose-a:text-[var(--color-text-primary)] prose-a:underline prose-a:decoration-[var(--color-border-hover)] hover:prose-a:decoration-current prose-strong:text-[var(--color-text-primary)] prose-code:text-[var(--color-accent-light)] prose-code:bg-[var(--color-bg-card)] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[var(--color-bg-card)] prose-pre:border prose-pre:border-[var(--color-border)] prose-blockquote:border-l-[var(--color-accent)] prose-blockquote:text-[var(--color-text-secondary)] prose-li:text-[var(--color-text-primary)] prose-hr:border-[var(--color-border)]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: MarkdownImage,
              }}
            >
              {content}
            </ReactMarkdown>
          </article>
        </div>
      </div>

      {/* Bottom bar: tags left, source URL right */}
      <div className="flex items-center gap-3 px-6 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg-card)]">
        <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
          {selectedTags.map(tag => (
            <TagChip
              key={tag.id}
              name={tag.name}
              size="sm"
              onRemove={() => { setSelectedTags(selectedTags.filter(t => t.id !== tag.id)); setIsDirty(true); }}
            />
          ))}
          <InlineTagInput
            selectedTags={selectedTags}
            onTagsChange={(tags) => { setSelectedTags(tags); setIsDirty(true); }}
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
            onChange={(e) => { setSourceUrl(e.target.value); setIsDirty(true); }}
            onBlur={() => setIsEditingUrl(false)}
            placeholder="Source URL"
            className="shrink-0 w-[220px] px-3 py-1.5 text-sm text-right rounded-lg bg-white/8 backdrop-blur-sm border border-white/10 text-[var(--color-text-secondary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:text-[var(--color-text-primary)] focus:border-white/20 focus:bg-white/12 transition-all duration-200"
          />
        )}
      </div>
    </div>
  );
}
